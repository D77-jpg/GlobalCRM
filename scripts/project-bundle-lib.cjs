'use strict';

const crypto = require('node:crypto');

const SYSTEM_KEEP_COLLECTIONS = new Set([
  'schema_migrations',
  'organizations',
  'emailsuppressions',
]);

const AI_SECRET_COLLECTIONS = new Set([
  'agentaiproviders',
  'agentaisettings',
]);

const EPHEMERAL_COLLECTIONS = new Set([
  'authsessions',
  'authchallenges',
  'usagerecords',
]);

const ADMIN_ROLES = new Set([
  'admin',
  'org_admin',
  'platform_admin',
]);

const UNSAFE_SECRET_PATTERN = /(placeholder|example|changeme|password|default|secret-key|123456)/i;

function idStr(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  return String(value);
}

function deriveCredentialKey(purpose, sourceKey) {
  if (!sourceKey || typeof sourceKey !== 'string') {
    throw new Error(`Missing encryption key for purpose "${purpose}"`);
  }
  return crypto.createHash('sha256').update(`genesis-${purpose}-credentials:v1:${sourceKey}`).digest();
}

function encryptSecretValue(plaintext, purpose, keySource) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveCredentialKey(purpose, keySource), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecretValue(secret, purpose, keySource) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveCredentialKey(purpose, keySource),
    Buffer.from(secret.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function reencryptSecret(secret, purpose, sourceKey, targetKey) {
  const plaintext = decryptSecretValue(secret, purpose, sourceKey);
  return encryptSecretValue(plaintext, purpose, targetKey);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateStrongSecret(byteLength = 36) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = crypto.randomBytes(byteLength).toString('base64url');
    if (
      candidate.length >= 32
      && new Set(candidate).size >= 16
      && !UNSAFE_SECRET_PATTERN.test(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error('Failed to generate strong random secret');
}

function classifyCollection(collectionName, sampleKeys = []) {
  if (collectionName === 'projects') return 'project';
  if (collectionName === 'users') return 'user';
  if (collectionName === 'integrationcredentials') return 'projectIdsScoped';
  if (collectionName === 'mailquotabuckets') return 'mailQuota';
  if (collectionName === 'agentautomationdays') return 'automationDay';
  if (SYSTEM_KEEP_COLLECTIONS.has(collectionName)) return 'system';
  if (AI_SECRET_COLLECTIONS.has(collectionName)) return 'aiSecret';
  if (EPHEMERAL_COLLECTIONS.has(collectionName)) return 'ephemeral';
  if (sampleKeys.includes('projectId')) return 'projectScoped';
  if (sampleKeys.includes('projectIds')) return 'projectIdsScoped';
  return 'unknown';
}

function reencryptFlatCredentialFields(doc, purpose, sourceKey, targetKey, auditHashes) {
  if (!doc.credentialCiphertext || !doc.credentialIv || !doc.credentialTag) {
    return doc;
  }
  const plaintext = decryptSecretValue({
    ciphertext: doc.credentialCiphertext,
    iv: doc.credentialIv,
    tag: doc.credentialTag,
  }, purpose, sourceKey);
  const next = encryptSecretValue(plaintext, purpose, targetKey);
  if (auditHashes) {
    auditHashes.push({
      purpose,
      docId: idStr(doc._id),
      field: 'credentialCiphertext',
      sourceSha256: sha256Hex(plaintext),
    });
  }
  return {
    ...doc,
    credentialCiphertext: next.ciphertext,
    credentialIv: next.iv,
    credentialTag: next.tag,
  };
}

function reencryptNestedSecret(doc, field, purpose, sourceKey, targetKey, auditHashes) {
  const val = doc[field];
  if (!val || !val.ciphertext || !val.iv || !val.tag) return doc;
  const plaintext = decryptSecretValue(val, purpose, sourceKey);
  const next = encryptSecretValue(plaintext, purpose, targetKey);
  if (auditHashes) {
    auditHashes.push({
      purpose,
      docId: idStr(doc._id),
      field,
      sourceSha256: sha256Hex(plaintext),
    });
  }
  return {
    ...doc,
    [field]: next,
  };
}

/**
 * Filter and transform a single MongoDB document for a single-project deployment bundle.
 * Returns null if the document does not belong to the target project.
 */
function transformDocumentForProject(collectionName, doc, ctx) {
  const targetPidStr = idStr(ctx.targetProjectId);
  const category = ctx.category || classifyCollection(collectionName, Object.keys(doc || {}));

  if (category === 'ephemeral') return null;
  if (category === 'system') return { ...doc };

  if (category === 'aiSecret') {
    return reencryptFlatCredentialFields(
      { ...doc },
      'ai',
      ctx.sourceEncryptionKey,
      ctx.targetEncryptionKey,
      ctx.auditHashes,
    );
  }

  if (category === 'project') {
    if (idStr(doc._id) !== targetPidStr) return null;
    return { ...doc, isDefault: true };
  }

  if (category === 'user') {
    const isAdminUser = ADMIN_ROLES.has(String(doc.role || ''));
    const assigned = Array.isArray(doc.projectIds)
      && doc.projectIds.some((pid) => idStr(pid) === targetPidStr);
    if (!isAdminUser && !assigned) return null;
    return {
      ...doc,
      projectIds: [ctx.targetProjectId],
      defaultProjectId: ctx.targetProjectId,
    };
  }

  if (category === 'projectIdsScoped') {
    const matched = Array.isArray(doc.projectIds)
      && doc.projectIds.some((pid) => idStr(pid) === targetPidStr);
    if (!matched) return null;
    return {
      ...doc,
      projectIds: [ctx.targetProjectId],
    };
  }

  if (category === 'mailQuota') {
    if (!ctx.keptMailAccountIds || !ctx.keptMailAccountIds.has(idStr(doc.mailAccountId))) {
      return null;
    }
    return { ...doc };
  }

  if (category === 'automationDay') {
    if (!ctx.keptAutomationRuleIds || !ctx.keptAutomationRuleIds.has(idStr(doc.ruleId))) {
      return null;
    }
    return { ...doc };
  }

  if (category === 'projectScoped') {
    if (idStr(doc.projectId) !== targetPidStr) return null;
    let out = { ...doc };
    if (collectionName === 'usermailaccounts') {
      out = reencryptFlatCredentialFields(
        out,
        'mail',
        ctx.sourceEncryptionKey,
        ctx.targetEncryptionKey,
        ctx.auditHashes,
      );
    } else if (collectionName === 'channelconfigs') {
      for (const field of ['accessTokenEncrypted', 'appSecretEncrypted', 'verifyTokenEncrypted']) {
        out = reencryptNestedSecret(
          out,
          field,
          'channel',
          ctx.sourceEncryptionKey,
          ctx.targetEncryptionKey,
          ctx.auditHashes,
        );
      }
    }
    return out;
  }

  // Unknown collection without projectId: exclude by default to prevent accidental cross-project leaks.
  return null;
}

function verifyNoCrossProjectLeaks(collectionName, docs, targetProjectId) {
  const targetPidStr = idStr(targetProjectId);
  const violations = [];
  for (const doc of docs) {
    if (collectionName === 'projects') {
      if (idStr(doc._id) !== targetPidStr) {
        violations.push(`projects doc ${idStr(doc._id)} != ${targetPidStr}`);
      }
      continue;
    }
    if (doc && Object.prototype.hasOwnProperty.call(doc, 'projectId') && doc.projectId != null) {
      if (idStr(doc.projectId) !== targetPidStr) {
        violations.push(`${collectionName} doc ${idStr(doc._id)} has foreign projectId ${idStr(doc.projectId)}`);
      }
    }
    if (doc && Array.isArray(doc.projectIds)) {
      for (const pid of doc.projectIds) {
        if (idStr(pid) !== targetPidStr) {
          violations.push(`${collectionName} doc ${idStr(doc._id)} has foreign projectIds entry ${idStr(pid)}`);
        }
      }
    }
    if (collectionName === 'users' && doc.defaultProjectId != null) {
      if (idStr(doc.defaultProjectId) !== targetPidStr) {
        violations.push(`users doc ${idStr(doc._id)} has foreign defaultProjectId ${idStr(doc.defaultProjectId)}`);
      }
    }
  }
  return violations;
}

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    env[key] = val;
  }
  return env;
}

function buildPerMachineEnv(sourceEnv, options) {
  const safeKey = String(options.bundleKey).toLowerCase().replace(/[^a-z0-9]/g, '');
  const httpPort = String(options.httpPort || sourceEnv.GLOBALCRM_HTTP_PORT || '5173');
  const appUrl = `http://localhost:${httpPort}`;
  const corsOrigin = `http://localhost:${httpPort},http://127.0.0.1:${httpPort}`;

  const mongoUser = options.mongoUser || `gcrm_${safeKey}_${crypto.randomBytes(4).toString('hex')}`;
  const mongoPassword = options.mongoPassword || generateStrongSecret(24);
  const jwtSecret = options.jwtSecret || generateStrongSecret(36);
  const adminPassword = options.adminPassword || generateStrongSecret(24);
  const mailEncryptionKey = options.mailEncryptionKey || generateStrongSecret(36);
  const appTitle = options.appTitle || `GlobalCRM - ${options.projectName}`;

  const encodedUser = encodeURIComponent(mongoUser);
  const encodedPass = encodeURIComponent(mongoPassword);
  const mongoUri = `mongodb://${encodedUser}:${encodedPass}@mongo:27017/cdlm?authSource=admin&replicaSet=rs0`;

  const lines = [
    `# GlobalCRM single-business local deployment configuration (${options.projectName} / ${options.bundleKey})`,
    '# Generated automatically with unique machine-local credentials. NEVER commit this file to Git.',
    'APP_ENV=production',
    `MONGO_ROOT_USERNAME=${mongoUser}`,
    `MONGO_ROOT_PASSWORD=${mongoPassword}`,
    `MONGODB_URI=${mongoUri}`,
    `JWT_SECRET=${jwtSecret}`,
    `JWT_ACCESS_EXPIRES_IN=${sourceEnv.JWT_ACCESS_EXPIRES_IN || '15m'}`,
    `JWT_REFRESH_EXPIRES_DAYS=${sourceEnv.JWT_REFRESH_EXPIRES_DAYS || '30'}`,
    'COOKIE_SECURE=false',
    `ADMIN_USERNAME=${sourceEnv.ADMIN_USERNAME || 'admin'}`,
    `ADMIN_PASSWORD=${adminPassword}`,
    `ADMIN_EMAIL=${sourceEnv.ADMIN_EMAIL || ''}`,
    `MAIL_CREDENTIAL_ENCRYPTION_KEY=${mailEncryptionKey}`,
    `TRACKING_BASE_URL=${appUrl}`,
    `PUBLIC_BASE_URL=${appUrl}`,
    `APP_BASE_URL=${appUrl}`,
    `CORS_ORIGIN=${corsOrigin}`,
    'VITE_API_BASE_URL=/api',
    `VITE_APP_TITLE=${appTitle}`,
    `GLOBALCRM_HTTP_PORT=${httpPort}`,
    `MAIL_TRANSPORT=${sourceEnv.MAIL_TRANSPORT || 'mock'}`,
    `SMTP_HOST=${sourceEnv.SMTP_HOST || ''}`,
    `SMTP_PORT=${sourceEnv.SMTP_PORT || '587'}`,
    `SMTP_SECURE=${sourceEnv.SMTP_SECURE || 'false'}`,
    `SMTP_USER=${sourceEnv.SMTP_USER || ''}`,
    `SMTP_PASS=${sourceEnv.SMTP_PASS || ''}`,
    `SMTP_REQUIRE_TLS=${sourceEnv.SMTP_REQUIRE_TLS || 'true'}`,
    `IMAP_ENABLED=${sourceEnv.IMAP_ENABLED || 'false'}`,
    `DEFAULT_ORGANIZATION_NAME=${sourceEnv.DEFAULT_ORGANIZATION_NAME || 'Default Organization'}`,
    `DEFAULT_ORGANIZATION_SLUG=${sourceEnv.DEFAULT_ORGANIZATION_SLUG || 'default'}`,
    'RUN_BACKGROUND_JOBS=false',
    `WORKER_HEALTH_PORT=${sourceEnv.WORKER_HEALTH_PORT || '5100'}`,
    'STORAGE_PROVIDER=local',
    `METRICS_ENABLED=${sourceEnv.METRICS_ENABLED || 'true'}`,
    `AI_REQUEST_TIMEOUT_MS=${sourceEnv.AI_REQUEST_TIMEOUT_MS || '110000'}`,
    `AI_MAX_OUTPUT_TOKENS=${sourceEnv.AI_MAX_OUTPUT_TOKENS || '4096'}`,
    `API_RATE_LIMIT_WINDOW_MS=${sourceEnv.API_RATE_LIMIT_WINDOW_MS || '60000'}`,
    `API_RATE_LIMIT_MAX=${sourceEnv.API_RATE_LIMIT_MAX || '600'}`,
    'OIDC_ENABLED=false',
    'OIDC_ALLOW_LOOPBACK=false',
  ];

  if (sourceEnv.KNOWLEDGE_PYTHON) {
    lines.push(`KNOWLEDGE_PYTHON=${sourceEnv.KNOWLEDGE_PYTHON}`);
    lines.push(`KNOWLEDGE_MODEL_DIR=${sourceEnv.KNOWLEDGE_MODEL_DIR || ''}`);
    lines.push(`KNOWLEDGE_RERANKER_DIR=${sourceEnv.KNOWLEDGE_RERANKER_DIR || ''}`);
    lines.push(`KNOWLEDGE_TOKENIZER_DIR=${sourceEnv.KNOWLEDGE_TOKENIZER_DIR || ''}`);
  }

  return {
    content: `${lines.join('\n')}\n`,
    secrets: {
      mongoUser,
      mongoPassword,
      jwtSecret,
      adminPassword,
      mailEncryptionKey,
    },
    httpPort,
    appTitle,
  };
}

module.exports = {
  ADMIN_ROLES,
  AI_SECRET_COLLECTIONS,
  EPHEMERAL_COLLECTIONS,
  SYSTEM_KEEP_COLLECTIONS,
  buildPerMachineEnv,
  classifyCollection,
  decryptSecretValue,
  deriveCredentialKey,
  encryptSecretValue,
  generateStrongSecret,
  idStr,
  parseEnvText,
  reencryptSecret,
  sha256Hex,
  transformDocumentForProject,
  verifyNoCrossProjectLeaks,
};
