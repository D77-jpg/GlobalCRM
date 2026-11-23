import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'channels-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'Channels-Admin-Str0ng!99';
process.env.CORS_ORIGINS = 'http://127.0.0.1:5173';
process.env.AI_PROVIDER = 'mock';

let memory: MongoMemoryServer | undefined;
let server: Server | undefined;
let base = '';
let cookieJar = '';
let projectIdA = '';
let projectIdB = '';
let customerIdA = '';

function mergeCookies(res: Response, current = ''): string {
  const map = new Map<string, string>();
  for (const part of current.split(';').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim();
    const idx = first?.indexOf('=') ?? -1;
    if (first && idx > 0) map.set(first.slice(0, idx), first.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrfFromJar(jar: string): string {
  const m = /(?:^|;\s*)cdlm_csrf=([^;]+)/.exec(jar);
  return m ? decodeURIComponent(m[1]) : '';
}

async function request(method: string, path: string, body?: unknown, projectId = projectIdA) {
  const headers: Record<string, string> = {
    cookie: cookieJar,
    'x-project-id': projectId,
  };
  if (method !== 'GET') headers['x-csrf-token'] = csrfFromJar(cookieJar);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, text, json };
}

before(async () => {
  memory = await MongoMemoryServer.create();
  process.env.MONGODB_URI = memory.getUri();
  await mongoose.connect(process.env.MONGODB_URI);
  const { createApp } = await import('../src/app');
  const models = await import('../src/models');

  const org = await models.Organization.create({ name: 'Omnichannel Org', slug: 'omni-org', plan: 'starter', status: 'active' });
  const [projA, projB] = await Promise.all([
    models.Project.create({
      organizationId: org._id, name: 'Genesis Bags', slug: 'genesis-omni', code: 'GO',
      companyName: 'Genesis Bags Xiamen', mailProfileKey: 'default',
    }),
    models.Project.create({
      organizationId: org._id, name: 'Isolated Brand', slug: 'isolated-omni', code: 'IO',
      companyName: 'Isolated Co', mailProfileKey: 'default',
    }),
  ]);
  projectIdA = String(projA._id);
  projectIdB = String(projB._id);

  const admin = await models.User.create({
    username: 'omni-admin', passwordHash: await models.hashPassword('Omni-Admin-Str0ng!'), displayName: 'Omni Admin',
    role: 'admin', organizationId: org._id, projectIds: [projA._id, projB._id], defaultProjectId: projA._id,
  });
  const customer = await models.Customer.create({
    organizationId: org._id,
    projectId: projA._id,
    name: 'Astrid Mazry',
    company: 'A.S. Avenue LLC',
    country: 'USA',
    phone: '+1 415 555 8890',
    email: 'astrid@asavenue.example',
    status: 'replied',
    ownerId: admin._id,
  });
  customerIdA = String(customer._id);
  await Promise.all([
    models.ChannelConfig.createIndexes(),
    models.ChannelConversation.createIndexes(),
    models.ChannelMessage.createIndexes(),
  ]);

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  base = `http://127.0.0.1:${address.port}/api`;

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'omni-admin', password: 'Omni-Admin-Str0ng!' }),
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

test('Meta WhatsApp Cloud API config encrypts secrets and verifies webhook challenge + HMAC + dedupe + status updates', async () => {
  const appSecret = 'meta-app-secret-test-9999';
  const verifyToken = 'meta-verify-token-xyz-123';

  const saved = await request('PUT', '/channels/config', {
    whatsappEnabled: true,
    phoneNumberId: '104298374651234',
    businessAccountId: '9988776655',
    displayPhoneNumber: '+86 153 0600 1357',
    accessToken: 'EAAG-test-permanent-token-secret',
    appSecret,
    verifyToken,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.data.whatsappEnabled, true);
  assert.equal(saved.json.data.hasAccessToken, true);
  assert.equal(saved.json.data.hasAppSecret, true);
  assert.equal(saved.json.data.hasVerifyToken, true);
  // Secrets must never leak back in response
  assert.ok(!saved.text.includes('EAAG-test-permanent-token-secret'));
  assert.ok(!saved.text.includes(appSecret));
  assert.ok(!saved.text.includes(verifyToken));

  // Wrong verify token -> 403
  const badChallenge = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL-123`);
  assert.equal(badChallenge.status, 403);

  // Correct verify token -> returns challenge verbatim
  const okChallenge = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=CHAL-123`);
  assert.equal(okChallenge.status, 200);
  assert.equal(await okChallenge.text(), 'CHAL-123');

  // Webhook POST with invalid HMAC -> 401
  const payload = JSON.stringify({
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          contacts: [{ wa_id: '14155558890', profile: { name: 'Astrid Mazry' } }],
          messages: [{
            id: 'wamid.TEST001',
            from: '14155558890',
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'Hi, what is your MOQ for 10x12cm black velvet pouches?' },
          }],
        },
      }],
    }],
  });

  const badSig = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=0000' },
    body: payload,
  });
  assert.equal(badSig.status, 401);

  // Valid HMAC -> creates conversation, auto-binds Astrid by phone, stores message
  const validSig = `sha256=${createHmac('sha256', appSecret).update(payload, 'utf8').digest('hex')}`;
  const okPost = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': validSig },
    body: payload,
  });
  assert.equal(okPost.status, 200);
  const okJson = await okPost.json();
  assert.equal(okJson.data.processedMessages, 1);

  // Replaying same wamid is idempotently deduplicated
  const dupPost = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': validSig },
    body: payload,
  });
  assert.equal(dupPost.status, 200);
  const dupJson = await dupPost.json();
  assert.equal(dupJson.data.processedMessages, 0);

  // Conversation appears in project A (auto-linked to Astrid) and is invisible in project B
  const listA = await request('GET', '/channels/conversations?channel=whatsapp');
  assert.equal(listA.status, 200);
  assert.equal(listA.json.data.items.length, 1);
  assert.equal(listA.json.data.items[0].customerId, customerIdA);
  assert.equal(listA.json.data.items[0].mode, 'api_live');

  const listB = await request('GET', '/channels/conversations', undefined, projectIdB);
  assert.equal(listB.status, 200);
  assert.equal(listB.json.data.items.length, 0);

  // Delivery status update webhook
  const statusPayload = JSON.stringify({
    entry: [{
      changes: [{
        field: 'messages',
        value: { statuses: [{ id: 'wamid.TEST001', status: 'read' }] },
      }],
    }],
  });
  const statusSig = `sha256=${createHmac('sha256', appSecret).update(statusPayload, 'utf8').digest('hex')}`;
  const statusRes = await fetch(`${base}/channels/whatsapp/webhook/${projectIdA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': statusSig },
    body: statusPayload,
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.data.processedStatuses, 1);
});

test('manual multi-channel conversation logs bilingual bubbles, syncs FollowUp timeline, and converts contact to CRM customer', async () => {
  const created = await request('POST', '/channels/conversations', {
    channel: 'alibaba',
    contactName: 'Leo Long',
    contactCompany: 'Long Studio GmbH',
    contactCountry: 'Germany',
    initialInboundText: 'Can you send the size chart and MOQ for cotton drawstring bags?',
  });
  assert.equal(created.status, 201);
  const convId = created.json.data.conversation.id;
  assert.ok(convId);

  // Convert unlinked Alibaba contact to CRM customer
  const converted = await request('POST', `/channels/conversations/${convId}/create-customer`, {});
  assert.equal(converted.status, 201);
  const newCustomerId = converted.json.data.customerId;
  assert.ok(newCustomerId);

  // Log outbound manual reply and verify FollowUp synced
  const replied = await request('POST', `/channels/conversations/${convId}/messages`, {
    direction: 'outbound',
    text: 'Hi Leo, our MOQ for custom cotton pouches is 100 pcs and sample lead time is 3-5 days.',
  });
  assert.equal(replied.status, 201);
  assert.equal(replied.json.data.message.deliveryStatus, 'logged_manual');

  const detail = await request('GET', `/channels/conversations/${convId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.messages.length, 2);
  assert.equal(detail.json.data.customer.id, newCustomerId);

  // Verify FollowUp timeline record was created for the customer
  const followUpRes = await request('GET', `/customers/${newCustomerId}/follow-ups`);
  assert.equal(followUpRes.status, 200);
  const followUps = followUpRes.json.data.items ?? followUpRes.json.data ?? [];
  assert.ok(Array.isArray(followUps) && followUps.some((f: any) => String(f.content).includes('[Alibaba 我方回复]')));
});

test('Alibaba inquiry mail parser cleans boilerplate, skips Trade Assurance/promo notices, and syncs idempotently via HTTP', async () => {
  const { parseAlibabaInquiryMail } = await import('../src/services/alibaba-mail-ingest.service');
  const { MailMessage } = await import('../src/models/MailMessage');
  const { runWithTenant } = await import('../src/models/tenant-context');

  // 1. Standard inquiry email with header/footer boilerplate
  const parsedStandard = parseAlibabaInquiryMail({
    from: 'feedback@email.alibaba.com',
    fromName: 'feedback@service.alibaba.com',
    subject: '【Alibaba Inquiry Notification】Elena Vance from Canada has sent you an inquiry',
    text: [
      'Trade Center',
      '重要提示 Notice',
      '该买家隐藏了邮箱号码， 请勿直接回复该邮件！',
      'Message Origin does not match Registered Location',
      '【阿里巴巴提醒您】及时、专业的回复有助于买家再次与您沟通，提升交易机会！',
      '立即回复',
      'Elena Vance',
      'Hi there, what is your MOQ for 8x10cm velvet jewelry pouches with gold foil logo?',
      'Email Setting | Customer Services |',
      'Alibaba.com Hong Kong Limited.',
      '=={"feedbackid":"9900112233"}==',
    ].join('\n'),
  });
  assert.ok(parsedStandard);
  assert.equal(parsedStandard.buyerName, 'Elena Vance');
  assert.equal(parsedStandard.buyerCountry, 'Canada');
  assert.equal(parsedStandard.feedbackId, '9900112233');
  assert.equal(
    parsedStandard.messageText,
    'Hi there, what is your MOQ for 8x10cm velvet jewelry pouches with gold foil logo?',
  );

  // 2. Trade Assurance and marketing emails must be skipped
  assert.equal(
    parseAlibabaInquiryMail({
      from: 'credit@notice.alibaba.com',
      subject: '【Alibaba.com】Trade Assurance order payment notice',
      text: 'Your buyer has submitted payment.',
    }),
    null,
  );
  assert.equal(
    parseAlibabaInquiryMail({
      from: 'supplier@service.alibaba.com',
      subject: '【阿里国际站】物流首单立减50元',
      text: '推广活动通知',
    }),
    null,
  );

  // 3. Seed fictional MailMessage rows in Project A (2 follow-ups from same buyer + 2 skipped notices)
  const { Project } = await import('../src/models');
  const projA = await runWithTenant({ bypass: true, source: 'test-alibaba-seed' }, () =>
    Project.findById(projectIdA).select('organizationId').lean(),
  );
  assert.ok(projA?.organizationId);

  const now = Date.now();
  await runWithTenant({ organizationId: String(projA.organizationId), source: 'test-alibaba-seed' }, async () => {
    await MailMessage.create([
      {
        projectId: projectIdA,
        visibility: 'project_shared',
        dedupKey: 'test-ali-dedup-1',
        threadId: 'test-ali-thread-1',
        messageId: '<ali-msg-1@email.alibaba.com>',
        subject: '【Alibaba Inquiry Notification】Elena Vance from Canada has sent you an inquiry',
        normalizedSubject: 'alibaba inquiry notification elena vance',
        from: 'feedback@email.alibaba.com',
        fromName: 'feedback@service.alibaba.com',
        to: ['sales@example.test'],
        text: 'Trade Center\n立即回复\nElena Vance\nHi, can you quote 500 pcs custom cotton drawstring bags?\nAlibaba.com Hong Kong Limited.\n=={"feedbackid":"9900112233"}==',
        sentAt: new Date(now - 60_000),
      },
      {
        projectId: projectIdA,
        visibility: 'project_shared',
        dedupKey: 'test-ali-dedup-2',
        threadId: 'test-ali-thread-1',
        messageId: '<ali-msg-2@email.alibaba.com>',
        subject: '【Alibaba Notification】Elena Vance from Canada',
        normalizedSubject: 'alibaba notification elena vance',
        from: 'feedback@email.alibaba.com',
        fromName: 'feedback@service.alibaba.com',
        to: ['sales@example.test'],
        text: 'Trade Center\n立即回复\nElena Vance\nSize is 12x15cm with black ribbon and gold logo.\nFAQ:\n1. 询盘标题变任务提醒\n=={"feedbackid":"9900112233"}==',
        sentAt: new Date(now - 30_000),
      },
      {
        projectId: projectIdA,
        visibility: 'project_shared',
        dedupKey: 'test-ali-dedup-3',
        threadId: 'test-ali-thread-2',
        messageId: '<ali-promo-1@service.alibaba.com>',
        subject: '【阿里国际站】物流首单立减50元',
        normalizedSubject: '物流首单立减50元',
        from: 'supplier@service.alibaba.com',
        to: ['sales@example.test'],
        text: '活动提醒',
        sentAt: new Date(now - 20_000),
      },
      {
        projectId: projectIdA,
        visibility: 'project_shared',
        dedupKey: 'test-ali-dedup-4',
        threadId: 'test-ali-thread-3',
        messageId: '<ali-ta-1@notice.alibaba.com>',
        subject: 'Trade Assurance Order Update',
        normalizedSubject: 'trade assurance order update',
        from: 'credit@notice.alibaba.com',
        to: ['sales@example.test'],
        text: 'Order paid',
        sentAt: new Date(now - 10_000),
      },
    ]);
  });

  // 4. Trigger HTTP 1-click sync
  const sync1 = await request('POST', '/channels/alibaba/sync-from-mail', { limit: 50 });
  assert.equal(sync1.status, 200);
  assert.equal(sync1.json.data.imported, 2);
  assert.equal(sync1.json.data.conversationsTouched, 1);

  // 5. Re-running sync is 100% idempotent
  const sync2 = await request('POST', '/channels/alibaba/sync-from-mail', { limit: 50 });
  assert.equal(sync2.status, 200);
  assert.equal(sync2.json.data.imported, 0);

  // 6. Verify Elena Vance conversation has both messages cleanly grouped in Project A, and invisible in Project B
  const listA = await request('GET', '/channels/conversations?channel=alibaba&search=Elena');
  assert.equal(listA.status, 200);
  assert.equal(listA.json.data.items.length, 1);
  const elenaConv = listA.json.data.items[0];
  assert.equal(elenaConv.contactName, 'Elena Vance');
  assert.equal(elenaConv.contactCountry, 'Canada');
  assert.ok(elenaConv.tags.includes('Alibaba 询盘'));

  const detail = await request('GET', `/channels/conversations/${elenaConv.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.messages.length, 2);
  assert.equal(detail.json.data.messages[0].text, 'Hi, can you quote 500 pcs custom cotton drawstring bags?');
  assert.equal(detail.json.data.messages[1].text, 'Size is 12x15cm with black ribbon and gold logo.');

  const listB = await request('GET', '/channels/conversations?channel=alibaba&search=Elena', undefined, projectIdB);
  assert.equal(listB.status, 200);
  assert.equal(listB.json.data.items.length, 0);
});
