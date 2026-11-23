'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPerMachineEnv,
  classifyCollection,
  decryptSecretValue,
  encryptSecretValue,
  generateStrongSecret,
  parseEnvText,
  transformDocumentForProject,
  verifyNoCrossProjectLeaks,
} = require('./project-bundle-lib.cjs');

test('classifyCollection partitions system, scoped, indirect, and ephemeral collections', () => {
  assert.equal(classifyCollection('projects', ['_id', 'slug']), 'project');
  assert.equal(classifyCollection('users', ['_id', 'projectIds']), 'user');
  assert.equal(classifyCollection('schema_migrations', ['_id', 'name']), 'system');
  assert.equal(classifyCollection('organizations', ['_id', 'slug']), 'system');
  assert.equal(classifyCollection('emailsuppressions', ['_id', 'email']), 'system');
  assert.equal(classifyCollection('agentaiproviders', ['_id', 'name']), 'aiSecret');
  assert.equal(classifyCollection('agentaisettings', ['_id', 'key']), 'aiSecret');
  assert.equal(classifyCollection('authsessions', ['_id', 'userId']), 'ephemeral');
  assert.equal(classifyCollection('usagerecords', ['_id', 'metric']), 'ephemeral');
  assert.equal(classifyCollection('customers', ['_id', 'projectId']), 'projectScoped');
  assert.equal(classifyCollection('mailquotabuckets', ['_id', 'mailAccountId']), 'mailQuota');
  assert.equal(classifyCollection('integrationcredentials', ['_id', 'projectIds']), 'projectIdsScoped');
  assert.equal(classifyCollection('unrelated_collection', ['_id', 'foo']), 'unknown');
});

test('transformDocumentForProject isolates project data, rewrites users, and re-encrypts secrets', () => {
  const sourceKey = generateStrongSecret(36);
  const targetKey = generateStrongSecret(36);
  const pGenesis = '6aa2360776ab59e92117bb18';
  const pIronhue = '6aa2360776ab59e92117bb19';
  const pVelaturo = '6ae43c9993474034512deb69';

  const ctx = {
    targetProjectId: pIronhue,
    sourceEncryptionKey: sourceKey,
    targetEncryptionKey: targetKey,
    keptMailAccountIds: new Set(['mail-ironhue']),
    keptAutomationRuleIds: new Set(),
    auditHashes: [],
  };

  // Projects: only target kept and forced isDefault=true
  assert.equal(transformDocumentForProject('projects', { _id: pGenesis, isDefault: true }, ctx), null);
  const keptProj = transformDocumentForProject('projects', { _id: pIronhue, isDefault: false }, ctx);
  assert.equal(keptProj.isDefault, true);

  // Users: admins kept & rewritten, assigned sales kept & rewritten, unassigned sales excluded
  const adminOut = transformDocumentForProject('users', {
    _id: 'u1', role: 'admin', projectIds: [pGenesis], defaultProjectId: pGenesis,
  }, ctx);
  assert.deepEqual(adminOut.projectIds, [pIronhue]);
  assert.equal(adminOut.defaultProjectId, pIronhue);

  const salesAssigned = transformDocumentForProject('users', {
    _id: 'u2', role: 'user', projectIds: [pGenesis, pIronhue], defaultProjectId: pGenesis,
  }, ctx);
  assert.deepEqual(salesAssigned.projectIds, [pIronhue]);
  assert.equal(salesAssigned.defaultProjectId, pIronhue);

  const salesUnassigned = transformDocumentForProject('users', {
    _id: 'u3', role: 'user', projectIds: [pGenesis, pVelaturo], defaultProjectId: pGenesis,
  }, ctx);
  assert.equal(salesUnassigned, null);

  // UserMailAccount: re-encrypted with purpose 'mail'
  const mailEnc = encryptSecretValue('smtp-app-pass-fixture', 'mail', sourceKey);
  const keptMail = transformDocumentForProject('usermailaccounts', {
    _id: 'mail-ironhue',
    projectId: pIronhue,
    credentialCiphertext: mailEnc.ciphertext,
    credentialIv: mailEnc.iv,
    credentialTag: mailEnc.tag,
  }, ctx);
  assert.notEqual(keptMail.credentialCiphertext, mailEnc.ciphertext);
  assert.equal(
    decryptSecretValue({
      ciphertext: keptMail.credentialCiphertext,
      iv: keptMail.credentialIv,
      tag: keptMail.credentialTag,
    }, 'mail', targetKey),
    'smtp-app-pass-fixture',
  );
  assert.equal(transformDocumentForProject('usermailaccounts', { _id: 'mail-gen', projectId: pGenesis }, ctx), null);

  // AgentAiProvider: kept across machines & re-encrypted with purpose 'ai'
  const aiEnc = encryptSecretValue('sk-fixture-test-value', 'ai', sourceKey);
  const keptAi = transformDocumentForProject('agentaiproviders', {
    _id: 'ai-1',
    name: 'DeepSeek',
    credentialCiphertext: aiEnc.ciphertext,
    credentialIv: aiEnc.iv,
    credentialTag: aiEnc.tag,
  }, ctx);
  assert.equal(
    decryptSecretValue({
      ciphertext: keptAi.credentialCiphertext,
      iv: keptAi.credentialIv,
      tag: keptAi.credentialTag,
    }, 'ai', targetKey),
    'sk-fixture-test-value',
  );

  // ChannelConfig: re-encrypted with purpose 'channel'
  const chEnc = encryptSecretValue('wa-token-fixture', 'channel', sourceKey);
  const keptCh = transformDocumentForProject('channelconfigs', {
    _id: 'ch-1',
    projectId: pIronhue,
    accessTokenEncrypted: chEnc,
  }, ctx);
  assert.equal(decryptSecretValue(keptCh.accessTokenEncrypted, 'channel', targetKey), 'wa-token-fixture');

  // MailQuotaBuckets: scoped by keptMailAccountIds
  assert.ok(transformDocumentForProject('mailquotabuckets', { _id: 'q1', mailAccountId: 'mail-ironhue' }, ctx));
  assert.equal(transformDocumentForProject('mailquotabuckets', { _id: 'q2', mailAccountId: 'mail-gen' }, ctx), null);

  // Ephemeral sessions excluded
  assert.equal(transformDocumentForProject('authsessions', { _id: 's1', userId: 'u1' }, ctx), null);

  // Leak verification
  assert.deepEqual(verifyNoCrossProjectLeaks('customers', [{ _id: 'c1', projectId: pIronhue }], pIronhue), []);
  assert.equal(
    verifyNoCrossProjectLeaks('customers', [{ _id: 'c2', projectId: pGenesis }], pIronhue).length,
    1,
  );
});

test('buildPerMachineEnv produces isolated credentials and preserves local knowledge paths', () => {
  const source = parseEnvText([
    'GLOBALCRM_HTTP_PORT=5173',
    'KNOWLEDGE_PYTHON=/opt/knowledge/bin/python',
    'KNOWLEDGE_MODEL_DIR=/opt/knowledge/model',
    'KNOWLEDGE_RERANKER_DIR=/opt/knowledge/reranker',
    'KNOWLEDGE_TOKENIZER_DIR=/opt/knowledge/model',
  ].join('\n'));

  const a = buildPerMachineEnv(source, { bundleKey: 'genesis', projectName: 'Genesis Bags' });
  const b = buildPerMachineEnv(source, { bundleKey: 'ironhue', projectName: 'IRONHUE' });

  assert.notEqual(a.secrets.jwtSecret, b.secrets.jwtSecret);
  assert.notEqual(a.secrets.mailEncryptionKey, b.secrets.mailEncryptionKey);
  assert.notEqual(a.secrets.mongoPassword, b.secrets.mongoPassword);
  assert.notEqual(a.secrets.jwtSecret, a.secrets.mailEncryptionKey);
  assert.match(a.content, /^VITE_APP_TITLE=GlobalCRM - Genesis Bags$/m);
  assert.match(b.content, /^VITE_APP_TITLE=GlobalCRM - IRONHUE$/m);
  assert.match(a.content, /^COOKIE_SECURE=false$/m);
  assert.match(a.content, /^KNOWLEDGE_PYTHON=\/opt\/knowledge\/bin\/python$/m);
  assert.match(a.content, /replicaSet=rs0/);
});
