import { after, before, test, type TestContext } from 'node:test';
import { runWithTenant } from '../src/models/tenant-context';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AuthUser } from '../src/types/express';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.OPENAI_API_KEY = '';
process.env.JWT_SECRET ||= 'fixture-jwt-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
process.env.ADMIN_PASSWORD ||= 'fixture-password';

let memory: MongoMemoryServer;
let mongoose: typeof import('mongoose');
let settings: typeof import('../src/services/agent/ai-settings.service');
let model: typeof import('../src/models/AgentAiSettings');
let crypto: typeof import('../src/services/credential-crypto');

const admin: AuthUser = { id: new Types.ObjectId().toString(), username: 'admin', displayName: 'Admin', role: 'admin', projectId: new Types.ObjectId().toString() };
const salesperson: AuthUser = { ...admin, id: new Types.ObjectId().toString(), role: 'user' };
const baseUrl = 'https://124.222.23.70/v1';
const tenantContext = { organizationId: new Types.ObjectId().toString(), source: 'ai-settings-test' };
function tenantTest(name: string, fn: (context: TestContext) => Promise<void> | void): void {
  test(name, (context) => runWithTenant(tenantContext, () => fn(context)));
}

before(async () => {
  memory = await MongoMemoryServer.create();
  mongoose = await import('mongoose');
  await mongoose.default.connect(memory.getUri(), { dbName: 'ai-settings-tests' });
  model = await import('../src/models/AgentAiSettings');
  await model.AgentAiSettings.init();
  settings = await import('../src/services/agent/ai-settings.service');
  crypto = await import('../src/services/credential-crypto');
});

after(async () => {
  await mongoose.default.disconnect();
  await memory.stop();
});

tenantTest('only admin can inspect, test or save global AI settings', async () => {
  const input = { provider: 'mock' as const, model: 'mock', baseUrl: 'https://api.example.com/v1' };
  await assert.rejects(settings.getAiSettings(salesperson), { statusCode: 403 });
  await assert.rejects(settings.testAiSettings(input, salesperson), { statusCode: 403 });
  await assert.rejects(settings.saveAiSettings(input, salesperson), { statusCode: 403 });
  assert.equal((await settings.getAiSettings(admin)).source, 'environment');
});

tenantTest('rejects private and credential-bearing endpoints before any network call', async () => {
  for (const url of ['http://169.254.169.254/v1', 'http://10.0.0.1/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=x', 'file:///etc/passwd']) {
    await assert.rejects(settings.validateAiBaseUrl(url), { statusCode: 400 });
  }
  assert.equal(await settings.validateAiBaseUrl(baseUrl), baseUrl);
  await assert.rejects(settings.validateAiBaseUrl('http://124.222.23.70/v1', true), { statusCode: 400 });
});

tenantTest('verified save encrypts key; read API and provider status never return it', async () => {
  const originalFetch = global.fetch;
  let probes = 0;
  global.fetch = (async (_url, options) => {
    probes += 1;
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer local-secret-fixture');
    const body = JSON.parse(String(options?.body)) as { model: string; input: unknown[] };
    assert.equal(body.model, 'model-a');
    assert.ok(body.input.length);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 2, output_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const input = { provider: 'openai' as const, model: 'model-a', baseUrl, apiKey: 'local-secret-fixture' };
    assert.equal((await settings.testAiSettings(input, admin)).ok, true);
    const saved = await settings.saveAiSettings(input, admin);
    assert.equal(probes, 2);
    assert.equal(saved.source, 'database');
    assert.equal(saved.keySource, 'database');
    assert.doesNotMatch(JSON.stringify(saved), /local-secret-fixture|apiKey|credentialCiphertext/);
    const current = await settings.getAiSettings(admin);
    assert.equal(current.model, 'model-a');
    assert.doesNotMatch(JSON.stringify(current), /local-secret-fixture|apiKey|credentialCiphertext/);
    const document = await model.AgentAiSettings.findOne({ key: 'global' }).select('+credentialCiphertext +credentialIv +credentialTag');
    assert.ok(document?.credentialCiphertext && document.credentialIv && document.credentialTag);
    assert.notEqual(document.credentialCiphertext, 'local-secret-fixture');
    assert.equal(crypto.decryptAiCredential({ ciphertext: document.credentialCiphertext, iv: document.credentialIv, tag: document.credentialTag }), 'local-secret-fixture');
    assert.throws(() => crypto.decryptCredential({ ciphertext: document.credentialCiphertext!, iv: document.credentialIv!, tag: document.credentialTag! }));
    const active = await settings.resolveAgentProvider();
    assert.equal(active.name, 'openai');
    assert.equal(active.model, 'model-a');
    assert.equal(active.isAvailable(), true);
  } finally { global.fetch = originalFetch; }
});

tenantTest('failed provider test never overwrites the working configuration', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(settings.saveAiSettings({ provider: 'openai', model: 'broken', baseUrl, apiKey: 'replacement' }, admin), { statusCode: 400 });
    assert.equal((await settings.getAiSettings(admin)).model, 'model-a');
    assert.equal((await settings.resolveAgentProvider()).model, 'model-a');
  } finally { global.fetch = originalFetch; }
});

tenantTest('mock mode switches without a network call and preserves encrypted key for later use', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => { throw new Error('mock mode must not fetch'); }) as typeof fetch;
  try {
    const saved = await settings.saveAiSettings({ provider: 'mock', model: 'model-a', baseUrl }, admin);
    assert.equal(saved.provider, 'mock');
    assert.equal(saved.keyConfigured, true);
    assert.equal((await settings.resolveAgentProvider()).name, 'mock');
  } finally { global.fetch = originalFetch; }
});

tenantTest('admin can replace an unreadable stored key without exposing it', async () => {
  await model.AgentAiSettings.updateOne({ key: 'global' }, { $set: { provider: 'openai', credentialTag: 'corrupt' } });
  const current = await settings.getAiSettings(admin);
  assert.equal(current.keyConfigured, true);
  assert.equal(current.keySource, 'database');
  assert.doesNotMatch(JSON.stringify(current), /credentialTag|apiKey/);
  await assert.rejects(settings.resolveAgentProvider(), { statusCode: 500 });

  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 2, output_tokens: 1 },
  }), { status: 200 })) as typeof fetch;
  try {
    const saved = await settings.saveAiSettings({ provider: 'openai', model: 'replacement-model', baseUrl, apiKey: 'replacement-secret' }, admin);
    assert.equal(saved.model, 'replacement-model');
    assert.equal((await settings.resolveAgentProvider()).model, 'replacement-model');
  } finally { global.fetch = originalFetch; }
});

tenantTest('dual-edition: self_hosted allows exact whitelisted internal AI gateway while blocking non-whitelisted LAN and cloud metadata', async () => {
  const editionMod = await import('../src/config/edition');
  const cookieMod = await import('../src/utils/auth-cookies');

  // 1. saas edition ignores internal allowlist and keeps strict HTTPS + public-address policy
  await assert.rejects(
    settings.validateAiBaseUrl('http://127.0.0.1:7863/v1', true, {
      edition: 'saas',
      allowedInternalOrigins: ['http://127.0.0.1:7863'],
    }),
    { statusCode: 400 },
  );

  // 2. self_hosted allows exact whitelisted internal gateway (even in production over HTTP)
  const allowed = await settings.validateAiBaseUrl('http://127.0.0.1:7863/v1', true, {
    edition: 'self_hosted',
    allowedInternalOrigins: ['http://127.0.0.1:7863'],
  });
  assert.equal(allowed, 'http://127.0.0.1:7863/v1');

  // 3. self_hosted rejects different port / non-whitelisted LAN IP
  await assert.rejects(
    settings.validateAiBaseUrl('http://127.0.0.1:9999/v1', true, {
      edition: 'self_hosted',
      allowedInternalOrigins: ['http://127.0.0.1:7863'],
    }),
    { statusCode: 400 },
  );
  await assert.rejects(
    settings.validateAiBaseUrl('http://192.168.1.50:7863/v1', true, {
      edition: 'self_hosted',
      allowedInternalOrigins: ['http://127.0.0.1:7863'],
    }),
    { statusCode: 400 },
  );

  // 4. Cloud metadata & link-local are ALWAYS blocked even if mistakenly added to allowlist
  for (const metadataUrl of ['http://169.254.169.254/v1', 'http://metadata.google.internal/v1']) {
    await assert.rejects(
      settings.validateAiBaseUrl(metadataUrl, true, {
        edition: 'self_hosted',
        allowedInternalOrigins: [new URL(metadataUrl).origin],
      }),
      { statusCode: 400 },
    );
  }
  assert.deepEqual(
    editionMod.parseAllowedInternalOrigins('http://host.docker.internal:7863, http://169.254.169.254, http://user:pass@127.0.0.1:7863, ftp://127.0.0.1:7863'),
    ['http://host.docker.internal:7863'],
  );

  // 5. Cookie Secure flag: saas production always enforces Secure; self_hosted respects COOKIE_SECURE
  assert.equal(cookieMod.secureCookieFlag({ isProd: true, edition: 'saas', cookieSecure: false }), true);
  assert.equal(cookieMod.secureCookieFlag({ isProd: true, edition: 'self_hosted', cookieSecure: false }), false);
  assert.equal(cookieMod.secureCookieFlag({ isProd: true, edition: 'self_hosted', cookieSecure: true }), true);

  // 6. Mail tracking skips private/loopback URLs in self_hosted mode only
  assert.equal(editionMod.shouldSkipMailTrackingForUrl('http://192.168.1.100:5173', 'self_hosted'), true);
  assert.equal(editionMod.shouldSkipMailTrackingForUrl('http://localhost:5000', 'self_hosted'), true);
  assert.equal(editionMod.shouldSkipMailTrackingForUrl('https://crm.example.com', 'self_hosted'), false);
  assert.equal(editionMod.shouldSkipMailTrackingForUrl('http://localhost:5000', 'saas'), false);

  // 7. Deployment feature profile defaults
  const saasProfile = editionMod.resolveDeploymentProfile({ edition: 'saas', allowedInternalOrigins: [] });
  assert.equal(saasProfile.features.billing, true);
  assert.equal(saasProfile.features.multiOrg, true);
  assert.equal(saasProfile.features.enforcePlanLimits, true);
  assert.equal(saasProfile.features.internalAiGateway, false);

  const selfHostedProfile = editionMod.resolveDeploymentProfile({
    edition: 'self_hosted',
    allowedInternalOrigins: ['http://host.docker.internal:7863'],
  });
  assert.equal(selfHostedProfile.features.billing, false);
  assert.equal(selfHostedProfile.features.multiOrg, false);
  assert.equal(selfHostedProfile.features.publicPricing, false);
  assert.equal(selfHostedProfile.features.enforcePlanLimits, false);
  assert.equal(selfHostedProfile.features.internalAiGateway, true);
});
