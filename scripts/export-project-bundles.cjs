'use strict';

/**
 * Split a running multi-project GlobalCRM Docker Compose deployment into independent
 * single-business local deployment bundles (MongoDB BSON dump + re-encrypted secrets +
 * scoped uploads + scoped semantic.sqlite3 + unique .env.production + import scripts).
 *
 * Security invariants:
 * - Read-only against the live MongoDB and live volumes.
 * - Never prints passwords, tokens, keys, or customer PII to stdout/stderr.
 * - Verifies zero cross-project document leaks and cryptographic re-encryption round-trips.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildPerMachineEnv,
  parseEnvText,
} = require('./project-bundle-lib.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    outDir: path.join(REPO_ROOT, 'deploy-bundles'),
    envFile: path.join(REPO_ROOT, '.env.production'),
    serverContainer: 'globalcrm-server-1',
    projects: null,
    httpPort: null,
    skipRuntime: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (arg === '--env-file' && argv[i + 1]) opts.envFile = path.resolve(argv[++i]);
    else if (arg === '--server-container' && argv[i + 1]) opts.serverContainer = argv[++i];
    else if (arg === '--projects' && argv[i + 1]) {
      opts.projects = argv[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg === '--http-port' && argv[i + 1]) opts.httpPort = argv[++i];
    else if (arg === '--skip-runtime') opts.skipRuntime = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/export-project-bundles.cjs [--out <dir>] [--projects genesis,ironhue,velaturo] [--http-port 5173] [--skip-runtime] [--force]');
      process.exit(0);
    }
  }
  return opts;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function runDockerNode(serverContainer, scriptBody, stdinJson) {
  const res = spawnSync('docker', ['exec', '-i', serverContainer, 'node', '-e', scriptBody], {
    input: stdinJson ? JSON.stringify(stdinJson) : undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const safeErr = (res.stderr || res.stdout || 'docker exec failed').slice(0, 600);
    throw new Error(`Container step failed (exit ${res.status}): ${safeErr}`);
  }
  return res.stdout;
}

function discoverProjects(serverContainer) {
  const script = `
    const mongoose = require('mongoose');
    (async () => {
      await mongoose.connect(process.env.MONGODB_URI);
      const projects = await mongoose.connection.db.collection('projects').find({ status: 'active' }).project({
        _id: 1, name: 1, slug: 1, code: 1, companyName: 1, industry: 1, 'brandProfile.brandKey': 1
      }).sort({ isDefault: -1, name: 1 }).toArray();
      console.log(JSON.stringify(projects.map(p => ({
        id: p._id.toHexString(),
        name: p.name,
        slug: p.slug,
        code: p.code,
        companyName: p.companyName || p.name,
        industry: p.industry || '',
        brandKey: (p.brandProfile && p.brandProfile.brandKey) || p.slug.split('-')[0]
      }))));
      await mongoose.disconnect();
    })().catch(err => { console.error(err.message); process.exit(1); });
  `;
  return JSON.parse(runDockerNode(serverContainer, script).trim());
}

function buildContainerExportScript() {
  const libSource = fs.readFileSync(path.join(__dirname, 'project-bundle-lib.cjs'), 'utf8');
  return `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const mongoose = require('mongoose');

const libPath = '/tmp/gcrm_bundle_lib_' + process.pid + '.cjs';
fs.writeFileSync(libPath, ${JSON.stringify(libSource)}, { mode: 0o600 });
const lib = require(libPath);

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const workDir = '/tmp/gcrm_export_' + input.bundleKey + '_' + process.pid;
  const dumpDir = path.join(workDir, 'mongo-dump', 'cdlm');
  const uploadsStage = path.join(workDir, 'uploads');
  const indexStage = path.join(workDir, 'knowledge-index');
  fs.mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsStage, { recursive: true, mode: 0o700 });
  fs.mkdirSync(indexStage, { recursive: true, mode: 0o700 });

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    const BSON = mongoose.mongo.BSON;
    const targetProjectId = new mongoose.Types.ObjectId(input.projectId);
    const sourceEncryptionKey = process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY || process.env.JWT_SECRET;
    const targetEncryptionKey = input.targetEncryptionKey;

    const collInfos = await db.listCollections({}, { nameOnly: true }).toArray();
    const collNames = collInfos.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();

    // Pass 1: discover kept mailAccountIds and automationRuleIds for indirect scoping.
    const keptMailAccountIds = new Set(
      (await db.collection('usermailaccounts').find({ projectId: targetProjectId }).project({ _id: 1 }).toArray())
        .map((d) => lib.idStr(d._id))
    );
    const keptAutomationRuleIds = collNames.includes('agentautomationrules')
      ? new Set(
          (await db.collection('agentautomationrules').find({ projectId: targetProjectId }).project({ _id: 1 }).toArray())
            .map((d) => lib.idStr(d._id))
        )
      : new Set();

    const collectionCounts = {};
    const skippedCollections = [];
    const auditHashes = [];
    const referencedMailFilenames = new Set();
    const referencedStorageKeys = new Set();
    let keptUsers = [];

    for (const collName of collNames) {
      const coll = db.collection(collName);
      const sample = await coll.findOne();
      const sampleKeys = sample ? Object.keys(sample) : [];
      const category = lib.classifyCollection(collName, sampleKeys);
      if (category === 'ephemeral' || category === 'unknown') {
        skippedCollections.push({ name: collName, category });
        continue;
      }

      const query = category === 'project'
        ? { _id: targetProjectId }
        : category === 'projectScoped'
          ? { projectId: targetProjectId }
          : category === 'projectIdsScoped'
            ? { projectIds: targetProjectId }
            : {};

      const bsonPath = path.join(dumpDir, collName + '.bson');
      const fd = fs.openSync(bsonPath, 'w');
      let keptCount = 0;
      try {
        const cursor = coll.find(query).batchSize(100);
        for await (const doc of cursor) {
          const transformed = lib.transformDocumentForProject(collName, doc, {
            targetProjectId,
            category,
            sourceEncryptionKey,
            targetEncryptionKey,
            keptMailAccountIds,
            keptAutomationRuleIds,
            auditHashes,
          });
          if (!transformed) continue;

          const violations = lib.verifyNoCrossProjectLeaks(collName, [transformed], targetProjectId);
          if (violations.length > 0) {
            throw new Error('Cross-project leak check failed: ' + violations.slice(0, 5).join('; '));
          }

          if (collName === 'users') {
            keptUsers.push({ username: transformed.username, role: transformed.role });
          } else if (collName === 'mailmessages') {
            for (const a of (transformed.attachments || [])) {
              if (a && a.filename && path.basename(a.filename) === a.filename) {
                referencedMailFilenames.add(a.filename);
              }
            }
          } else if (collName === 'customerattachments') {
            if (transformed.storageKey) referencedStorageKeys.add(transformed.storageKey);
          }

          const serialized = Buffer.from(BSON.serialize(transformed));
          fs.writeSync(fd, serialized);
          keptCount += 1;
        }
      } finally {
        fs.closeSync(fd);
      }

      if (keptCount === 0) {
        fs.unlinkSync(bsonPath);
        continue;
      }

      const rawIndexes = await coll.indexes();
      const cleanIndexes = rawIndexes.map((idx) => {
        const copy = { ...idx };
        delete copy.ns;
        return copy;
      });
      const metaPath = path.join(dumpDir, collName + '.metadata.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        indexes: cleanIndexes,
        collectionName: collName,
        type: 'collection',
      }));

      // Streaming BSON round-trip & cryptographic verification (low memory footprint)
      const pendingById = new Map();
      for (const h of auditHashes) {
        if (h.verified !== true) {
          const list = pendingById.get(h.docId) || [];
          list.push(h);
          pendingById.set(h.docId, list);
        }
      }
      const vfd = fs.openSync(bsonPath, 'r');
      let parsedCount = 0;
      try {
        const fileSize = fs.fstatSync(vfd).size;
        let offset = 0;
        const header = Buffer.allocUnsafe(4);
        while (offset < fileSize) {
          const readHdr = fs.readSync(vfd, header, 0, 4, offset);
          if (readHdr !== 4) throw new Error('Truncated BSON header in ' + collName);
          const docSize = header.readInt32LE(0);
          if (docSize < 5 || offset + docSize > fileSize) {
            throw new Error('Invalid BSON document size in ' + collName);
          }
          const docBuf = Buffer.allocUnsafe(docSize);
          fs.readSync(vfd, docBuf, 0, docSize, offset);
          offset += docSize;
          parsedCount += 1;

          if (pendingById.size > 0) {
            const doc = BSON.deserialize(docBuf);
            const did = lib.idStr(doc._id);
            const items = pendingById.get(did);
            if (items) {
              for (const h of items) {
                const secretObj = h.field === 'credentialCiphertext'
                  ? { ciphertext: doc.credentialCiphertext, iv: doc.credentialIv, tag: doc.credentialTag }
                  : doc[h.field];
                const decrypted = lib.decryptSecretValue(secretObj, h.purpose, targetEncryptionKey);
                if (lib.sha256Hex(decrypted) !== h.sourceSha256) {
                  throw new Error('Re-encryption cryptographic verification failed for ' + collName + ' ' + h.field);
                }
                h.verified = true;
              }
              pendingById.delete(did);
            }
          }
        }
      } finally {
        fs.closeSync(vfd);
      }
      if (parsedCount !== keptCount) {
        throw new Error('BSON verification count mismatch for ' + collName);
      }

      collectionCounts[collName] = keptCount;
    }

    const unverifiedSecrets = auditHashes.filter((h) => !h.verified).length;
    if (unverifiedSecrets > 0) {
      throw new Error('Unverified re-encrypted secrets remaining: ' + unverifiedSecrets);
    }

    // Export brand package snapshot for reference (no secrets)
    const projectDoc = await db.collection('projects').findOne({ _id: targetProjectId });
    const playbookDoc = await db.collection('projectplaybooks').findOne({ projectId: targetProjectId });
    const brandPackageSnapshot = {
      schemaVersion: 1,
      release: (playbookDoc && playbookDoc.activePackage && playbookDoc.activePackage.release) || 'export-' + new Date().toISOString().slice(0, 10),
      project: {
        id: input.projectId,
        name: projectDoc.name,
        slug: projectDoc.slug,
        code: projectDoc.code,
        companyName: projectDoc.companyName,
        industry: projectDoc.industry || '',
        website: projectDoc.website || '',
        brandKey: (projectDoc.brandProfile && projectDoc.brandProfile.brandKey) || input.bundleKey,
      },
      brandProfile: projectDoc.brandProfile || {},
      playbookCardCount: ((playbookDoc && playbookDoc.segments) || []).length + ((playbookDoc && playbookDoc.preferences) || []).length,
    };
    fs.writeFileSync(path.join(workDir, 'brand-snapshot.json'), JSON.stringify(brandPackageSnapshot, null, 2) + '\\n');

    // Archive mongo dump
    const mongoArchive = path.join(workDir, 'mongo-dump.tar.gz');
    execFileSync('tar', ['-czf', mongoArchive, '-C', path.join(workDir, 'mongo-dump'), 'cdlm']);

    // Stage and archive project-scoped uploads
    const uploadRoot = process.env.UPLOAD_DIR || '/data/uploads';
    let uploadFileCount = 0;
    let uploadTotalBytes = 0;
    const projectMailDir = path.join(uploadRoot, 'mail', input.projectId);
    const copiedMailFiles = new Set();

    if (fs.existsSync(projectMailDir)) {
      const dstDir = path.join(uploadsStage, 'mail', input.projectId);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const entry of fs.readdirSync(projectMailDir)) {
        const src = path.join(projectMailDir, entry);
        const st = fs.statSync(src);
        if (!st.isFile()) continue;
        fs.copyFileSync(src, path.join(dstDir, entry));
        copiedMailFiles.add(entry);
        uploadFileCount += 1;
        uploadTotalBytes += st.size;
      }
    }

    // Legacy pre-V2.6 loose files under /data/uploads/mail/<filename> referenced by this project's mailmessages
    for (const fn of referencedMailFilenames) {
      if (copiedMailFiles.has(fn)) continue;
      const legacySrc = path.join(uploadRoot, 'mail', fn);
      if (fs.existsSync(legacySrc) && fs.statSync(legacySrc).isFile()) {
        const dstDir = path.join(uploadsStage, 'mail');
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(legacySrc, path.join(dstDir, fn));
        const st = fs.statSync(legacySrc);
        uploadFileCount += 1;
        uploadTotalBytes += st.size;
      }
    }

    for (const sk of referencedStorageKeys) {
      const cleanKey = sk.replace(/^\\/+/, '');
      const src = path.resolve(uploadRoot, cleanKey);
      if (src.startsWith(path.resolve(uploadRoot) + path.sep) && fs.existsSync(src) && fs.statSync(src).isFile()) {
        const dst = path.join(uploadsStage, cleanKey);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        uploadFileCount += 1;
        uploadTotalBytes += fs.statSync(src).size;
      }
    }

    const uploadsArchive = path.join(workDir, 'uploads.tar.gz');
    execFileSync('tar', ['-czf', uploadsArchive, '-C', uploadsStage, '.']);

    // Split semantic.sqlite3 cleanly per project using SQLite backup API + DELETE + VACUUM
    let semanticStats = { included: false, rows: {} };
    const srcSqlite = path.join(process.env.KNOWLEDGE_INDEX_DIR || '/data/knowledge-index', 'semantic.sqlite3');
    const pythonBin = process.env.KNOWLEDGE_PYTHON || '/opt/knowledge/bin/python';
    if (fs.existsSync(srcSqlite) && fs.existsSync(pythonBin)) {
      const dstSqlite = path.join(indexStage, 'semantic.sqlite3');
      const pyScript = [
        'import json, sqlite3, sys',
        'src_path, dst_path, pid = sys.argv[1], sys.argv[2], sys.argv[3]',
        'src = sqlite3.connect(src_path, timeout=30)',
        'dst = sqlite3.connect(dst_path, timeout=30)',
        'src.backup(dst)',
        'src.close()',
        'tables = ["vectors", "embeddings", "texts", "lexical", "lexical_terms"]',
        'counts = {}',
        'for t in tables:',
        '    dst.execute(f"DELETE FROM {t} WHERE project != ?", (pid,))',
        'dst.commit()',
        'dst.execute("VACUUM")',
        'total = 0',
        'for t in tables:',
        '    foreign = dst.execute(f"SELECT COUNT(*) FROM {t} WHERE project != ?", (pid,)).fetchone()[0]',
        '    assert foreign == 0, f"Foreign rows left in {t}: {foreign}"',
        '    c = dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]',
        '    counts[t] = c',
        '    total += c',
        'dst.close()',
        'print(json.dumps({"total": total, "rows": counts}))',
      ].join('\\n');
      const pyOut = execFileSync(pythonBin, ['-c', pyScript, srcSqlite, dstSqlite, input.projectId], { encoding: 'utf8' });
      const parsed = JSON.parse(pyOut.trim());
      if (parsed.total > 0) {
        const indexArchive = path.join(workDir, 'knowledge-index.tar.gz');
        execFileSync('tar', ['-czf', indexArchive, '-C', indexStage, 'semantic.sqlite3']);
        semanticStats = { included: true, rows: parsed.rows };
      }
    }

    await mongoose.disconnect();
    console.log(JSON.stringify({
      workDir,
      collectionCounts,
      reencryptedCredentialsVerified: auditHashes.length,
      keptUsers,
      uploadFileCount,
      uploadTotalBytes,
      semanticStats,
      skippedCollections,
    }));
  } finally {
    try { fs.unlinkSync(libPath); } catch {}
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
}

function buildDeployDoc(meta) {
  return `# GlobalCRM 单业务本机部署指南 —— ${meta.projectName}

> 业务标识：\`${meta.bundleKey}\` · 项目代码：\`${meta.projectCode}\` · 导出时间：\`${meta.exportedAt}\`

本目录包含 **${meta.projectName}** 独立本机部署所需的全部隔离配置与业务数据（已与其他项目彻底隔离，并为本机独立生成了数据库密码、JWT 密钥与凭证加密密钥）。

> **安全提示**：本目录包含真实的邮箱/AI 加密凭证与客户业务数据，**严禁提交至 Git 仓库或上传至公开网盘**。部署完成后请妥善离线保管或清理中转拷贝。

## 包含文件

- \`.env.production\` —— 本机专用环境配置（已自动生成独立强密钥）
- \`mongo-dump.tar.gz\` —— 仅属于 **${meta.projectName}** 的 MongoDB 完整数据与索引
- \`uploads.tar.gz\` —— 仅属于 **${meta.projectName}** 的邮件与业务附件（${meta.uploadFileCount} 个文件）
${meta.semanticIncluded ? '- `knowledge-index.tar.gz` —— 本项目的本地知识库向量与词法检索索引\n' : ''}- \`bundle-manifest.json\` —— 数据统计与 SHA-256 完整性校验清单
- \`import-project-bundle.ps1\` / \`import-project-bundle.sh\` —— 一键校验、导入与启动脚本

## 三步完成部署（Windows / macOS / Linux）

### 第 1 步：准备环境并拉取最新代码

确保目标电脑已安装 **Docker Desktop**（已启动）和 **Git**，然后拉取代码：

\`\`\`powershell
git clone https://github.com/D77-jpg/GlobalCRM.git
cd GlobalCRM
\`\`\`

（如果已有仓库，执行 \`git pull origin main\` 更新至最新版。）

### 第 2 步：将本目录复制到目标电脑

将整个 \`${meta.bundleKey}\` 文件夹复制到目标电脑（例如 \`D:\\GlobalCRM-Deploy\\${meta.bundleKey}\`）。
如需启用本地知识库语义检索，请将同级目录的 \`shared\\knowledge-runtime.tar.gz\` 一并复制到 \`D:\\GlobalCRM-Deploy\\shared\\knowledge-runtime.tar.gz\`（导入脚本会自动识别并装载）。

### 第 3 步：一键导入数据并启动服务

在 **GlobalCRM 代码根目录** 下执行：

**Windows PowerShell：**
\`\`\`powershell
powershell -ExecutionPolicy Bypass -File "D:\\GlobalCRM-Deploy\\${meta.bundleKey}\\import-project-bundle.ps1" -BundleDir "D:\\GlobalCRM-Deploy\\${meta.bundleKey}" -RepoDir "."
\`\`\`

**macOS / Linux：**
\`\`\`bash
bash "/path/to/${meta.bundleKey}/import-project-bundle.sh" --bundle-dir "/path/to/${meta.bundleKey}" --repo-dir "."
\`\`\`

脚本会自动完成：
1. 校验全部数据包的 SHA-256 完整性；
2. 安装本机专用 \`.env.production\`；
3. 启动独立 Docker Compose 项目 \`globalcrm-${meta.bundleKey}\` 并导入 MongoDB、附件与知识库索引；
4. 构建并启动 API、Worker 与 Web 前端，验证 \`http://127.0.0.1:${meta.httpPort}/api/health\` 就绪。

启动完成后，浏览器打开：**\`http://localhost:${meta.httpPort}\`**，使用原有团队账号和密码登录即可。

## 当前内置账号

${meta.keptUsers.map((u) => `- \`${u.username}\`（角色：\`${u.role}\`）`).join('\n')}

## 后续版本迭代升级

当 GitHub \`main\` 分支发布新版本后，在目标电脑的 GlobalCRM 目录执行：

\`\`\`powershell
git pull origin main
docker compose -p globalcrm-${meta.bundleKey} --env-file .env.production up -d --build --wait
\`\`\`

> **注意**：升级时**切勿**运行 \`docker compose down -v\`，否则会删除本地数据库与附件卷；请始终保留 \`.env.production\` 中的密钥不变。
`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.envFile)) {
    throw new Error(`Env file not found: ${opts.envFile}`);
  }
  const sourceEnv = parseEnvText(fs.readFileSync(opts.envFile, 'utf8'));
  fs.mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });

  const allProjects = discoverProjects(opts.serverContainer);
  const selected = opts.projects
    ? allProjects.filter((p) => opts.projects.includes(p.brandKey.toLowerCase()) || opts.projects.includes(p.slug.toLowerCase()) || opts.projects.includes(p.code.toLowerCase()))
    : allProjects;

  if (selected.length === 0) {
    throw new Error('No matching active projects found in MongoDB.');
  }

  const containerScript = buildContainerExportScript();
  const summary = [];

  for (const project of selected) {
    const bundleKey = String(project.brandKey || project.slug).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const bundleDir = path.join(opts.outDir, bundleKey);
    if (fs.existsSync(bundleDir)) {
      if (!opts.force) {
        throw new Error(`Destination already exists: ${bundleDir} (pass --force to overwrite)`);
      }
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
    fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

    const envBuilt = buildPerMachineEnv(sourceEnv, {
      bundleKey,
      projectName: project.name,
      httpPort: opts.httpPort || sourceEnv.GLOBALCRM_HTTP_PORT || '5173',
    });

    console.log(`[export] Exporting project "${project.name}" (${bundleKey})...`);
    const rawOut = runDockerNode(opts.serverContainer, containerScript, {
      projectId: project.id,
      bundleKey,
      targetEncryptionKey: envBuilt.secrets.mailEncryptionKey,
    });
    const result = JSON.parse(rawOut.trim().split(/\r?\n/).pop());

    try {
      execFileSync('docker', ['cp', `${opts.serverContainer}:${result.workDir}/mongo-dump.tar.gz`, path.join(bundleDir, 'mongo-dump.tar.gz')]);
      execFileSync('docker', ['cp', `${opts.serverContainer}:${result.workDir}/uploads.tar.gz`, path.join(bundleDir, 'uploads.tar.gz')]);
      execFileSync('docker', ['cp', `${opts.serverContainer}:${result.workDir}/brand-snapshot.json`, path.join(bundleDir, `${bundleKey}-brand-snapshot.json`)]);
      if (result.semanticStats.included) {
        execFileSync('docker', ['cp', `${opts.serverContainer}:${result.workDir}/knowledge-index.tar.gz`, path.join(bundleDir, 'knowledge-index.tar.gz')]);
      }
    } finally {
      spawnSync('docker', ['exec', opts.serverContainer, 'rm', '-rf', result.workDir]);
    }

    fs.writeFileSync(path.join(bundleDir, '.env.production'), envBuilt.content, { mode: 0o600 });
    fs.copyFileSync(path.join(__dirname, 'import-project-bundle.ps1'), path.join(bundleDir, 'import-project-bundle.ps1'));
    fs.copyFileSync(path.join(__dirname, 'import-project-bundle.sh'), path.join(bundleDir, 'import-project-bundle.sh'));

    const exportedAt = new Date().toISOString();
    const files = {
      '.env.production': {
        sizeBytes: fs.statSync(path.join(bundleDir, '.env.production')).size,
        sha256: sha256File(path.join(bundleDir, '.env.production')),
      },
      'mongo-dump.tar.gz': {
        sizeBytes: fs.statSync(path.join(bundleDir, 'mongo-dump.tar.gz')).size,
        sha256: sha256File(path.join(bundleDir, 'mongo-dump.tar.gz')),
      },
      'uploads.tar.gz': {
        sizeBytes: fs.statSync(path.join(bundleDir, 'uploads.tar.gz')).size,
        sha256: sha256File(path.join(bundleDir, 'uploads.tar.gz')),
      },
    };
    if (result.semanticStats.included) {
      files['knowledge-index.tar.gz'] = {
        sizeBytes: fs.statSync(path.join(bundleDir, 'knowledge-index.tar.gz')).size,
        sha256: sha256File(path.join(bundleDir, 'knowledge-index.tar.gz')),
      };
    }

    const manifest = {
      schemaVersion: 1,
      exportedAt,
      bundleKey,
      composeProjectName: `globalcrm-${bundleKey}`,
      httpPort: Number(envBuilt.httpPort),
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        code: project.code,
        brandKey: project.brandKey,
      },
      keptUsers: result.keptUsers,
      collectionCounts: result.collectionCounts,
      reencryptedCredentialsVerified: result.reencryptedCredentialsVerified,
      uploads: {
        fileCount: result.uploadFileCount,
        totalBytes: result.uploadTotalBytes,
      },
      semanticIndex: result.semanticStats,
      files,
    };

    fs.writeFileSync(path.join(bundleDir, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'DEPLOY.md'), buildDeployDoc({
      projectName: project.name,
      projectCode: project.code,
      bundleKey,
      exportedAt,
      httpPort: envBuilt.httpPort,
      keptUsers: result.keptUsers,
      uploadFileCount: result.uploadFileCount,
      semanticIncluded: result.semanticStats.included,
    }), 'utf8');

    summary.push({
      bundleKey,
      projectName: project.name,
      bundleDir,
      collections: Object.keys(result.collectionCounts).length,
      customers: result.collectionCounts.customers || 0,
      prospects: result.collectionCounts.prospects || 0,
      mailMessages: result.collectionCounts.mailmessages || 0,
      users: result.keptUsers.length,
      reencryptedCredentialsVerified: result.reencryptedCredentialsVerified,
      uploadFileCount: result.uploadFileCount,
      semanticIncluded: result.semanticStats.included,
      mongoArchiveMB: Number((files['mongo-dump.tar.gz'].sizeBytes / (1024 * 1024)).toFixed(2)),
      uploadsArchiveMB: Number((files['uploads.tar.gz'].sizeBytes / (1024 * 1024)).toFixed(2)),
    });
  }

  let sharedRuntimeInfo = null;
  if (!opts.skipRuntime && sourceEnv.KNOWLEDGE_PYTHON) {
    const sharedDir = path.join(opts.outDir, 'shared');
    fs.mkdirSync(sharedDir, { recursive: true, mode: 0o700 });
    const runtimeArchive = path.join(sharedDir, 'knowledge-runtime.tar.gz');
    if (opts.force || !fs.existsSync(runtimeArchive)) {
      console.log('[export] Packaging shared local knowledge runtime (/opt/knowledge)...');
      const tmpRuntime = `/tmp/gcrm_kruntime_${process.pid}.tar.gz`;
      try {
        execFileSync('docker', ['exec', opts.serverContainer, 'tar', '-czf', tmpRuntime, '-C', '/opt/knowledge', '.']);
        execFileSync('docker', ['cp', `${opts.serverContainer}:${tmpRuntime}`, runtimeArchive]);
      } finally {
        spawnSync('docker', ['exec', opts.serverContainer, 'rm', '-f', tmpRuntime]);
      }
    }
    const sha = sha256File(runtimeArchive);
    const sizeBytes = fs.statSync(runtimeArchive).size;
    fs.writeFileSync(path.join(sharedDir, 'knowledge-runtime.sha256'), `${sha}  knowledge-runtime.tar.gz\n`, 'utf8');
    sharedRuntimeInfo = {
      path: runtimeArchive,
      sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
      sha256: sha,
    };
  }

  console.log('\n=== EXPORT COMPLETE ===');
  console.log(JSON.stringify({ outDir: opts.outDir, bundles: summary, sharedKnowledgeRuntime: sharedRuntimeInfo }, null, 2));
}

main();
