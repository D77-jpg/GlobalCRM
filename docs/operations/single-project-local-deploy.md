# GlobalCRM 团队单业务本机部署与拆分指南

当团队采用 **“一台电脑独立运行一条业务线”**（例如 `genesis`、`ironhue`、`velaturo` 三台业务电脑各自独立运行一套本地 GlobalCRM）时，可以使用本指南将当前集成多项目的环境安全拆分为各业务专属数据包，并在每台电脑上通过 Docker Compose 一键部署与持续迭代升级。

---

## 架构原则与安全边界

1. **严格按项目隔离业务数据**：每台电脑只导入本业务线对应的客户、潜客、开发信、邮件记录、附件、知识库文档、本地向量索引、产品、政策、行业卡（Playbook）与项目邮箱配置；导入后自动执行零跨项目泄露校验。
2. **每台电脑独立密钥**：导出脚本会为每台目标电脑自动生成全新的 `MONGO_ROOT_PASSWORD`、`JWT_SECRET`、`ADMIN_PASSWORD` 与 `MAIL_CREDENTIAL_ENCRYPTION_KEY`，并使用目标电脑的新密钥重新加密该业务所需的邮箱授权码、AI 服务商密钥与全渠道 Token，确保导入后开箱即用且三台电脑之间不共享任何加密密钥。
3. **保留公共合规与系统元数据**：
   - 保留 `schema_migrations`（确保目标机启动 `migrate` 容器时不会重新触发历史多项目初始化脚本）；
   - 保留 `organizations` 与组织级 `agentaiproviders` / `agentaisettings`（重加密后随包带出，AI 能力开箱即用）；
   - 保留全局 `emailsuppressions` 抑制名单，避免向历史退订/硬退信地址重复发信；
   - 清除 `authsessions`、`authchallenges`、`usagerecords`，目标机以干净会话和计量起步。
4. **账号自动收口**：每台电脑保留管理员账号（`admin` 等）及已分配到该业务的销售账号，并将所有保留账号的 `projectIds` 与 `defaultProjectId` 收口为该单一业务项目。
5. **敏感数据严禁入库**：默认导出目录 `deploy-bundles/` 已写入 `.gitignore`，任何时候都不应将导出包或 `.env.production` 提交至 Git。

---

## 第一步：在主控机拆分导出各业务数据包

在当前运行多项目 Docker Compose 的主控机仓库根目录执行：

```bash
node scripts/export-project-bundles.cjs --out deploy-bundles --force
```

常用可选参数：
- `--projects genesis,ironhue,velaturo`：仅导出指定业务（默认导出全部活跃项目）。
- `--http-port 5173`：指定目标电脑默认 Web 访问端口（默认继承当前 `.env.production` 的 `GLOBALCRM_HTTP_PORT` 或 `5173`）。
- `--skip-runtime`：跳过打包共享的本地知识库 Python/ONNX 运行时（`/opt/knowledge`）。

导出完成后，`deploy-bundles/` 目录结构如下：

```text
deploy-bundles/
├── genesis/
│   ├── .env.production               # Genesis 电脑专用配置（独立强密钥）
│   ├── mongo-dump.tar.gz             # 仅含 Genesis 数据的 BSON 与索引
│   ├── uploads.tar.gz                # 仅含 Genesis 的邮件与业务附件
│   ├── knowledge-index.tar.gz        # 仅含 Genesis 的本地语义索引（semantic.sqlite3）
│   ├── genesis-brand-snapshot.json   # 品牌配置快照
│   ├── bundle-manifest.json          # 数据统计与 SHA-256 校验清单
│   ├── import-project-bundle.ps1     # Windows 一键导入启动脚本
│   ├── import-project-bundle.sh      # macOS / Linux 一键导入启动脚本
│   └── DEPLOY.md                     # 本业务电脑专属操作说明
├── ironhue/                          # 同上（仅含 IRONHUE 数据）
├── velaturo/                         # 同上（仅含 VELATURO 数据）
└── shared/
    ├── knowledge-runtime.tar.gz      # 共享的本地知识库模型与 Python 运行时（无业务数据）
    └── knowledge-runtime.sha256
```

---

## 第二步：分发并在目标业务电脑一键部署

将对应业务的文件夹（例如 `genesis/`）以及可选的 `shared/knowledge-runtime.tar.gz` 通过内网或 U 盘复制到对应业务电脑（如 `D:\GlobalCRM-Deploy\`）。

### 1. 在目标电脑安装前置环境并拉取最新代码

目标电脑需安装 **Docker Desktop**（保持运行状态）与 **Git**：

```powershell
git clone https://github.com/D77-jpg/GlobalCRM.git
cd GlobalCRM
```

### 2. 运行一键导入并启动脚本

**Windows PowerShell**（在 `GlobalCRM` 仓库根目录执行）：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\GlobalCRM-Deploy\genesis\import-project-bundle.ps1" -BundleDir "D:\GlobalCRM-Deploy\genesis" -RepoDir "."
```

**macOS / Linux**：

```bash
bash "/path/to/genesis/import-project-bundle.sh" --bundle-dir "/path/to/genesis" --repo-dir "."
```

脚本会自动完成以下 7 个步骤：
1. 逐文件校验 `bundle-manifest.json` 中的 SHA-256 完整性；
2. 将数据包中的 `.env.production` 安装到仓库根目录（若已存在则默认拒绝覆盖，需显式传 `-Force` / `--force`）；
3. 启动隔离的 MongoDB 副本集容器（Compose 项目名 `globalcrm-<业务标识>`）；
4. 检查目标库非空保护，随后调用 `mongorestore` 无损恢复全部集合与索引；
5. 将附件卷、知识库索引卷及共享知识库运行时卷导入 Docker 命名卷；
6. 构建并启动 `migrate`、`server`、`worker`、`web` 完整服务栈；
7. 自动探测 `http://127.0.0.1:<端口>/api/health` 确认服务状态为 `ok`。

启动成功后，浏览器访问 `http://localhost:5173`（或配置的端口），使用团队原有账号密码登录即可。

> **关于 Velaturo 等新启业务电脑**：若初始尚未分配销售子账号，管理员登录后可在「用户管理」中创建该业务线的专属销售账号，并在「个人邮箱设置 / 工作台设置」中绑定该业务的 SMTP/IMAP 邮箱。

---

## 第三步：后续版本迭代升级流程

当 GitHub（`https://github.com/D77-jpg/GlobalCRM`）的 `main` 分支发布新版本（如 `v2.7.1`、`v2.8.0`）时，每台业务电脑只需执行两步即可无损升级：

```powershell
# 1. 拉取最新代码
git pull origin main

# 2. 重新构建并平滑重启（migrate 容器会自动执行新增数据库迁移）
docker compose -p globalcrm-<业务标识> --env-file .env.production up -d --build --wait
```

例如 Genesis 电脑对应 `-p globalcrm-genesis`，IRONHUE 电脑对应 `-p globalcrm-ironhue`，VELATURO 电脑对应 `-p globalcrm-velaturo`。

### 升级与运维注意事项

- **严禁执行 `docker compose down -v`**：`-v` 会删除本地 MongoDB 数据卷与附件卷；正常停机请使用 `docker compose -p globalcrm-<业务标识> --env-file .env.production stop`。
- **保持 `.env.production` 稳定**：升级代码时切勿覆盖或修改已生效的 `MAIL_CREDENTIAL_ENCRYPTION_KEY` 与 `MONGO_ROOT_PASSWORD`，否则已加密保存的邮箱与 AI 凭证将无法解密。
- **定期备份**：建议在每台业务电脑定期执行 [MongoDB 备份脚本](mongo-backup.md) 并将备份存至独立磁盘或加密备份盘。
- **如需局域网内其他同事访问**：默认仅绑定 `127.0.0.1`（本机回环）。若需办公室局域网内访问，建议在本机前置 Nginx / Caddy 反向代理转发至 `127.0.0.1:5173`，并将对应局域网访问来源追加到 `.env.production` 的 `CORS_ORIGIN` 中后重启 `server` 与 `worker`。
