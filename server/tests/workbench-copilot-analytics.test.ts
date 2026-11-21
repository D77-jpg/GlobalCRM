import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.MAIL_TRANSPORT = 'mock';
process.env.JWT_SECRET ||= ['wb', 'analytics', 'fixture', 'jwt', 'secret', '0'.repeat(32)].join('-');
process.env.ADMIN_PASSWORD ||= 'wb-analytics-fixture-admin-password';
process.env.API_RATE_LIMIT_MAX = '100000';

let memory: MongoMemoryServer;
let server: Server;
let base = '';
let projectId = '';
let customerId = '';
let cookieJar: Record<string, string> = {};

function mergeCookies(response: Response, previous: Record<string, string> = {}): Record<string, string> {
  const jar = { ...previous };
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
  for (const cookie of raw) {
    const pair = cookie.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return jar;
}

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    cookie: Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '),
    'x-project-id': projectId,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && cookieJar.cdlm_csrf) headers['x-csrf-token'] = cookieJar.cdlm_csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  cookieJar = mergeCookies(response, cookieJar);
  return { status: response.status, json: await response.json() as { success?: boolean; data?: any; error?: any } };
}

before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri('wb_analytics_fixture'));
  const { createApp } = await import('../src/app');
  const models = await import('../src/models');
  const org = await models.Organization.create({
    name: 'WB Analytics Org', slug: 'wb-analytics-org', plan: 'starter',
    limits: { users: 10, projects: 5, monthlyEmails: 10000, monthlyAiTokens: 2_000_000, storageBytes: 5 * 1024 ** 3 },
    subscriptionStatus: 'active',
  });
  const project = await models.Project.create({
    organizationId: org._id, name: 'WB Analytics Project', slug: 'wb-analytics-project', code: 'WBA',
    companyName: 'WB Analytics Co', mailProfileKey: 'default',
  });
  projectId = String(project._id);
  const admin = await models.User.create({
    username: 'wba-admin', passwordHash: await models.hashPassword('WBA-Admin-Str0ng!'), displayName: 'WBA Admin',
    role: 'admin', organizationId: org._id, projectIds: [project._id], defaultProjectId: project._id,
  });
  const [c1] = await Promise.all([
    models.Customer.create({
      projectId: project._id, organizationId: org._id, name: 'Anna US', company: 'US Brand LLC',
      country: 'United States', status: 'quoting', priority: 'high', intentScore: 86, sampleStatus: 'making',
      nextFollowUpAt: new Date(Date.now() - 86400_000), ownerId: admin._id,
    }),
    models.Customer.create({
      projectId: project._id, organizationId: org._id, name: 'Sophie AU', company: 'AU Studio',
      country: 'Australia', status: 'won', priority: 'medium', ownerId: admin._id,
    }),
  ]);
  customerId = String(c1._id);
  await models.Product.create({
    projectId: project._id, organizationId: org._id, sku: 'VLV-100', name: 'Velvet Drawstring Pouch',
    category: 'Pouches', status: 'active', moq: '100 pcs', leadTime: '10-20 days',
    specs: [{ code: 'MAT', name: 'Material', value: 'Dense velvet' }],
    priceTiers: [{ minQuantity: 100, unitPrice: 0.95, currency: 'USD' }],
  });
  await Promise.all([models.CustomerWorkbenchItem.init(), models.ProjectPolicy.init()]);

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  base = `http://127.0.0.1:${address.port}/api`;

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wba-admin', password: 'WBA-Admin-Str0ng!' }),
  });
  assert.equal(login.status, 200);
  cookieJar = mergeCookies(login);
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await memory?.stop();
});

test('customer workbench items CRUD + draft buyer update + dashboard decision analytics', async () => {
  // 1. Create open question + commitment
  const qItem = await req('POST', '/workbench/items', {
    customerId,
    kind: 'open_question',
    title: '确认丝绒布袋洗护标与烫金工艺',
    ownerRole: 'Engineering',
  });
  assert.equal(qItem.status, 201);
  const itemId = qItem.json.data.id;

  // 2. Fill verification result and draft buyer update
  const patched = await req('PATCH', `/workbench/items/${itemId}`, {
    resultNote: 'Engineering confirmed dense short-pile velvet supports gold hot foil cleanly for logos >= 2mm stroke.',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.status, 'result_ready');

  const updateDraft = await req('POST', `/workbench/items/${itemId}/draft-update`, {});
  assert.equal(updateDraft.status, 200);
  assert.ok(updateDraft.json.data.body.includes('gold hot foil'));

  // 3. Dashboard overview returns decision analytics with range, countries, funnel, priority follow-ups
  const stats = await req('GET', '/stats/overview?range=30d');
  assert.equal(stats.status, 200);
  const analytics = stats.json.data.analytics;
  assert.equal(analytics.range.preset, '30d');
  assert.ok(analytics.countryDistribution.length >= 2);
  assert.equal(analytics.openQuestionsCount, 1);
  assert.ok(analytics.conversionFunnel.length === 5);
  assert.ok(analytics.priorityFollowUps.length >= 1);
  assert.equal(analytics.priorityFollowUps[0].customerId, customerId);
  assert.ok(analytics.priorityFollowUps[0].score >= 80);
});

test('knowledge QA returns linked product card & policies; markdown import rejects path traversal', async () => {
  await req('POST', '/workbench/policies/seed-preset', { preset: 'genesis' });
  const qa = await req('POST', '/workbench/knowledge-qa', { question: 'Velvet Pouch MOQ 和打样交期是多少？' });
  assert.equal(qa.status, 200);
  assert.ok(qa.json.data.matchedProducts.some((p: any) => p.sku === 'VLV-100'));
  assert.ok(qa.json.data.matchedPolicies.some((p: any) => p.code === 'P-MOQ'));
  assert.ok(qa.json.data.suggestedQuestions.length >= 3);

  // Valid Obsidian Markdown import creates unapproved draft entries
  const imp = await req('POST', '/workbench/knowledge-import-markdown', {
    files: [{
      path: '报价政策/MOQ与起订量.md',
      content: '---\ntitle: 定制布袋起订量说明\n---\n所有定制包装统一 MOQ 100 件，关联 [[打样周期|打样规范]]。',
    }],
  });
  assert.equal(imp.status, 201);
  assert.equal(imp.json.data.imported, 1);

  // Path traversal attempt is strictly rejected (400)
  const traversal = await req('POST', '/workbench/knowledge-import-markdown', {
    files: [{ path: '../etc/passwd.md', content: 'malicious content test' }],
  });
  assert.equal(traversal.status, 400);
});
