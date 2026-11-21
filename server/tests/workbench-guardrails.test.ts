import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.MAIL_TRANSPORT = 'mock';
process.env.JWT_SECRET ||= ['wb', 'guard', 'fixture', 'jwt', 'secret', '0'.repeat(32)].join('-');
process.env.ADMIN_PASSWORD ||= 'wb-guard-fixture-admin-password';
process.env.API_RATE_LIMIT_MAX = '100000';

let memory: MongoMemoryServer;
let server: Server;
let base = '';
let projectIdA = '';
let projectIdB = '';
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

async function request(method: string, path: string, body?: unknown, projectOverride?: string) {
  const headers: Record<string, string> = {
    cookie: Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '),
    'x-project-id': projectOverride || projectIdA,
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
  await mongoose.connect(memory.getUri('wb_guardrails_fixture'));
  const { createApp } = await import('../src/app');
  const models = await import('../src/models');
  const org = await models.Organization.create({
    name: 'WB Guard Org', slug: 'wb-guard-org', plan: 'starter',
    limits: { users: 10, projects: 5, monthlyEmails: 10000, monthlyAiTokens: 2_000_000, storageBytes: 5 * 1024 ** 3 },
    subscriptionStatus: 'active',
  });
  const [projA, projB] = await Promise.all([
    models.Project.create({
      organizationId: org._id, name: 'Genesis Bags', slug: 'genesis-bags', code: 'GB',
      companyName: 'Genesis Bags Xiamen', mailProfileKey: 'default', brandProfile: { brandKey: 'genesis' },
    }),
    models.Project.create({
      organizationId: org._id, name: 'Other Brand', slug: 'other-brand', code: 'OB',
      companyName: 'Other Brand Co', mailProfileKey: 'default',
    }),
  ]);
  projectIdA = String(projA._id);
  projectIdB = String(projB._id);
  await models.User.create({
    username: 'wb-admin', passwordHash: await models.hashPassword('WB-Admin-Str0ng!'), displayName: 'WB Admin',
    role: 'admin', organizationId: org._id, projectIds: [projA._id, projB._id], defaultProjectId: projA._id,
  });
  await Promise.all([models.ProjectPolicy.init(), models.CustomerWorkbenchItem.init()]);

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  base = `http://127.0.0.1:${address.port}/api`;

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wb-admin', password: 'WB-Admin-Str0ng!' }),
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

test('seeds Genesis V6 preset policies & redlines idempotently with project isolation', async () => {
  const seeded = await request('POST', '/workbench/policies/seed-preset', { preset: 'genesis' });
  assert.equal(seeded.status, 200);
  assert.ok(seeded.json.data.policiesInserted >= 18);
  assert.ok(seeded.json.data.redlinesAdded >= 25);
  assert.equal(seeded.json.data.pricingMode, 'costing_approved');

  // Re-seeding is idempotent and does not overwrite existing policies
  const second = await request('POST', '/workbench/policies/seed-preset', { preset: 'genesis' });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.policiesInserted, 0);

  // Project B remains completely isolated
  const listB = await request('GET', '/workbench/policies', undefined, projectIdB);
  assert.equal(listB.status, 200);
  assert.equal(listB.json.data.length, 0);

  // Confirm an unconfirmed policy (P-CERTS)
  const listA = await request('GET', '/workbench/policies?confirmed=false');
  assert.equal(listA.status, 200);
  assert.ok(listA.json.data.length >= 1);
  const targetId = listA.json.data[0].id;
  const confirmed = await request('POST', `/workbench/policies/${targetId}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.data.confirmed, true);
});

test('all 24 deterministic guardrail self-test cases pass via real HTTP', async () => {
  const res = await request('GET', '/workbench/guardrails/selftest');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.total, 24);
  assert.equal(res.json.data.failed, 0, JSON.stringify(res.json.data.results.filter((r: any) => !r.ok)));
  assert.equal(res.json.data.passed, 24);
});

test('multi-channel inquiry drafting produces K/B/A drafts, scam signals, and tone rewrite', async () => {
  const res = await request('POST', '/workbench/draft-inquiry', {
    channel: 'whatsapp',
    inboundText: 'Hi, what is your MOQ and sample lead time for 500 black velvet pouches 10x12 cm with gold foil logo shipped to USA?',
    destination: 'USA',
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.drafts.K.body.includes('100 pieces'));
  assert.ok(res.json.data.drafts.B.score.score > 0);
  assert.ok(Array.isArray(res.json.data.analysis.preSendChecklist));

  const checkBad = await request('POST', '/workbench/guardrails/check', {
    subject: 'Custom pouches',
    body: 'Hi John,\n\nPlease find attached our quotation for USD 0.65 each. Our MOQ is 500 pcs.',
  });
  assert.equal(checkBad.status, 200);
  const badCodes = checkBad.json.data.checks.filter((c: any) => c.severity === 'bad').map((c: any) => c.code);
  assert.ok(badCodes.includes('fake_attachment'));
  assert.ok(badCodes.includes('unapproved_amount'));
  assert.ok(badCodes.includes('guessed_name'));

  const learn = await request('POST', '/workbench/learn-from-edit', {
    inboundText: 'What is your MOQ?',
    aiDraft: 'Hello,\n\nThank you very much for reaching out to our team today regarding your inquiry about minimum order quantity and production details. Our MOQ is 100 pieces for all custom products and we would be happy to discuss further details whenever you are ready.',
    finalSent: 'Hello,\n\nOur MOQ is 100 pieces for all custom products. Please share your size and quantity.',
    autoAdoptWritingRules: true,
  });
  assert.equal(learn.status, 200);
  assert.ok(learn.json.data.candidates.length >= 1);
  assert.equal(learn.json.data.adoptedCount, 1);

  // Ongoing follow-up thread should NOT treat the customer as a first-time inquiry
  const followupRes = await request('POST', '/workbench/draft-inquiry', {
    channel: 'email',
    scenario: 'auto',
    subject: 'Re: Sample confirmation for black velvet pouch',
    inboundText: 'Thanks! We received the sample yesterday and the logo looks great. Please let us know next steps.',
    threadText: 'Us: We sent out the sample via DHL.\n\nBuyer: Thanks! We received the sample yesterday.',
  });
  assert.equal(followupRes.status, 200);
  assert.ok(!followupRes.json.data.drafts.K.body.includes('reaching out with your inquiry'));
  assert.ok(!followupRes.json.data.drafts.K.body.includes('prepare an accurate quotation'));

  // Email with a long quoted reply chain must score against ONLY the customer's latest message
  const quotedInbound = [
    'Dear Lisa,',
    '',
    'Thank you for the 1000 pcs offer, we will pass for now and revisit after finalizing our brand color palette.',
    '',
    'Best,',
    'Sohta',
    '',
    '2026年10月13日(火) 16:52 jellyfish <lisa@genesisbags.com>:',
    '- Box 10x12cm 200 pcs USD 1.20',
    '- Pre production sample USD 80',
    '- Sample shipping USD 45',
    '- WhatsApp +86 153 0600 1357',
    '- FSC mark on exterior bottom',
    'Could you also confirm your MOQ and target timeline?',
  ].join('\n');
  const quotedDraft = await request('POST', '/workbench/draft-inquiry', {
    channel: 'email',
    scenario: 'auto',
    subject: 'Re: Concept Design - Custom Rigid Jewelry Box',
    inboundText: quotedInbound,
  });
  assert.equal(quotedDraft.status, 200);
  assert.ok(!quotedDraft.json.data.drafts.K.body.includes('detailed list'));

  const scoredFollowup = await request('POST', '/workbench/guardrails/check', {
    subject: 'Re: Concept Design - Custom Rigid Jewelry Box',
    threadSubject: 'Re: Concept Design - Custom Rigid Jewelry Box',
    body: 'Hi Sohta,\n\nThank you for letting us know. We completely understand and have paused sampling for now while keeping your artwork and pearl white box specifications on file. Whenever your updated brand color palette is ready, just reach out and we will be glad to resume.\n\nBest regards,\nGenesis Bags',
    inboundText: quotedInbound,
  });
  assert.equal(scoredFollowup.status, 200);
  assert.ok(scoredFollowup.json.data.score.score >= 90, `expected >= 90, got ${scoredFollowup.json.data.score.score}`);
});
