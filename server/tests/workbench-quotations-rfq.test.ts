import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.MAIL_TRANSPORT = 'mock';
process.env.JWT_SECRET ||= ['wb', 'quote', 'fixture', 'jwt', 'secret', '0'.repeat(32)].join('-');
process.env.ADMIN_PASSWORD ||= 'wb-quote-fixture-admin-password';
process.env.API_RATE_LIMIT_MAX = '100000';

let memory: MongoMemoryServer;
let server: Server;
let base = '';
let projectId = '';
let customerId = '';
let adminJar: Record<string, string> = {};
let salesJar: Record<string, string> = {};

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

async function reqAs(jarRef: 'admin' | 'sales', method: string, path: string, body?: unknown) {
  const jar = jarRef === 'admin' ? adminJar : salesJar;
  const headers: Record<string, string> = {
    cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    'x-project-id': projectId,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && jar.cdlm_csrf) headers['x-csrf-token'] = jar.cdlm_csrf;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const updated = mergeCookies(response, jar);
  if (jarRef === 'admin') adminJar = updated;
  else salesJar = updated;
  return response;
}

before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri('wb_quotations_rfq_fixture'));
  const { createApp } = await import('../src/app');
  const models = await import('../src/models');
  const org = await models.Organization.create({
    name: 'WB Quote Org', slug: 'wb-quote-org', plan: 'starter',
    limits: { users: 10, projects: 5, monthlyEmails: 10000, monthlyAiTokens: 2_000_000, storageBytes: 5 * 1024 ** 3 },
    subscriptionStatus: 'active',
  });
  const project = await models.Project.create({
    organizationId: org._id, name: 'WB Quote Project', slug: 'wb-quote-project', code: 'WBQ',
    companyName: 'WB Quote Trading', mailProfileKey: 'default',
  });
  projectId = String(project._id);
  const [adminUser, salesUser] = await Promise.all([
    models.User.create({
      username: 'wbq-admin', passwordHash: await models.hashPassword('WBQ-Admin-Str0ng!'), displayName: 'WBQ Admin',
      role: 'admin', organizationId: org._id, projectIds: [project._id], defaultProjectId: project._id,
    }),
    models.User.create({
      username: 'wbq-sales', passwordHash: await models.hashPassword('WBQ-Sales-Str0ng!'), displayName: 'WBQ Sales',
      role: 'user', organizationId: org._id, projectIds: [project._id], defaultProjectId: project._id,
    }),
  ]);
  const customer = await models.Customer.create({
    projectId: project._id, organizationId: org._id, name: 'Astrid Mazry', company: 'A.S. Avenue LLC',
    country: 'United States', email: 'astrid@example.test', ownerId: salesUser._id,
  });
  customerId = String(customer._id);
  await Promise.all([models.Product.init(), models.Quotation.init(), models.CustomerRfq.init()]);

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  base = `http://127.0.0.1:${address.port}/api`;

  const loginAdmin = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wbq-admin', password: 'WBQ-Admin-Str0ng!' }),
  });
  assert.equal(loginAdmin.status, 200);
  adminJar = mergeCookies(loginAdmin);

  const loginSales = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wbq-sales', password: 'WBQ-Sales-Str0ng!' }),
  });
  assert.equal(loginSales.status, 200);
  salesJar = mergeCookies(loginSales);
  void adminUser;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await memory?.stop();
});

test('standard quotation with Incoterms, freight, margin check, historical ref, approval workflow & PDF', async () => {
  // 1. Create product with internal unitCost & targetMarginPct
  const pRes = await reqAs('admin', 'POST', '/products', {
    sku: 'KNT-25108',
    name: 'Cable Knit Cardigan',
    category: 'Knitwear',
    moq: '50 pcs',
    leadTime: '20-25 days',
    unitCost: 26,
    targetMarginPct: 20,
    priceTiers: [
      { minQuantity: 50, maxQuantity: 99, unitPrice: 38, currency: 'USD' },
      { minQuantity: 100, unitPrice: 35, currency: 'USD' },
    ],
  });
  assert.equal(pRes.status, 201);
  const prod = (await pRes.json() as any).data;

  // 2. Real-time quote-check detects low margin (< 20%)
  const lowMargin = await reqAs('sales', 'POST', '/agent/quote-checks', {
    customerId,
    items: [{ name: 'KNT-25108', quantity: 100, unitPrice: 28 }],
  });
  assert.equal(lowMargin.status, 200);
  const lowData = (await lowMargin.json() as any).data;
  assert.equal(lowData.items[0].margin.belowTarget, true);
  assert.ok(lowData.items[0].margin.marginPct < 20);

  // 3. Create foreign-trade quotation as sales user
  const qRes = await reqAs('sales', 'POST', '/quotations', {
    customerId,
    title: 'Autumn Knitwear FOB Offer',
    currency: 'USD',
    incoterm: 'FOB',
    shippingMethod: 'sea',
    destinationPort: 'Los Angeles (LAX)',
    estimatedFreight: 350,
    items: [{ productId: prod.id, sku: prod.sku, productName: prod.name, quantity: 100, unitPrice: 36, pricingStatus: 'approved' }],
    status: 'draft',
  });
  assert.equal(qRes.status, 201);
  const quote = (await qRes.json() as any).data;
  assert.equal(quote.totalAmount, 3600);
  assert.equal(quote.estimatedFreight, 350);
  assert.equal(quote.grandTotal, 3950);
  assert.equal(quote.incoterm, 'FOB');

  // 4. Summary & product history endpoints work
  const sumRes = await reqAs('sales', 'GET', '/quotations/summary');
  assert.equal(sumRes.status, 200);
  assert.equal((await sumRes.json() as any).data.draft, 1);

  const histRes = await reqAs('sales', 'GET', '/quotations/history-by-product?q=KNT-25108');
  assert.equal(histRes.status, 200);
  const hist = (await histRes.json() as any).data;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].unitPrice, 36);

  // 5. Approval workflow: sales submits, sales cannot approve (403), admin approves (200)
  const subRes = await reqAs('sales', 'POST', `/quotations/${quote.id}/submit-approval`, { note: 'Please review freight' });
  assert.equal(subRes.status, 200);
  assert.equal((await subRes.json() as any).data.approvalStatus, 'pending_approval');

  const selfApprove = await reqAs('sales', 'POST', `/quotations/${quote.id}/review-approval`, { decision: 'approved' });
  assert.equal(selfApprove.status, 403);

  const adminApprove = await reqAs('admin', 'POST', `/quotations/${quote.id}/review-approval`, { decision: 'approved', note: 'Approved' });
  assert.equal(adminApprove.status, 200);
  assert.equal((await adminApprove.json() as any).data.approvalStatus, 'approved');

  // 6. PDF download returns valid PDF bytes
  const pdfRes = await reqAs('sales', 'GET', `/quotations/${quote.id}/pdf`);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString('utf8'), '%PDF-');
});

test('custom RFQ evaluates craft & US anti-dumping risks, exports xlsx, and converts to quotation', async () => {
  const createRes = await reqAs('sales', 'POST', '/workbench/rfqs', {
    customerId,
    title: 'US Paper Bag + Velvet Pouch System',
    destination: 'USA New York',
    incoterm: 'FOB Xiamen',
    lines: [
      { product: 'Paper shopping bag', material: 'Kraft', size: '25x30x10 cm', qty: '300/500/1000', logo: 'Gold foil', color: 'PMS 186C', approvedUnitPrice: 1.45, approvedCurrency: 'USD', pricingStatus: 'approved' },
      { product: 'Velvet pouch', material: 'Velvet', size: '6x8 cm', qty: '300/500', logo: 'Fine foil', color: 'Black', pricingStatus: 'pending' },
    ],
  });
  assert.equal(createRes.status, 201);
  const rfq = (await createRes.json() as any).data;
  assert.deepEqual(rfq.evaluation.breaks, [300, 500, 1000]);
  assert.ok(rfq.evaluation.issues.some((i: string) => i.includes('反倾销')));
  assert.ok(rfq.evaluation.issues.some((i: string) => i.includes('小尺寸')));

  // Export costing xlsx
  const xlsxRes = await reqAs('sales', 'GET', `/workbench/rfqs/${rfq.id}/costing-xlsx`);
  assert.equal(xlsxRes.status, 200);
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  // ZIP/XLSX magic header PK\x03\x04
  assert.equal(xlsxBuf[0], 0x50);
  assert.equal(xlsxBuf[1], 0x4b);

  // Convert RFQ to formal quotation keeping pending line status
  const convRes = await reqAs('sales', 'POST', `/workbench/rfqs/${rfq.id}/convert-quotation`, {});
  assert.equal(convRes.status, 201);
  const conv = (await convRes.json() as any).data;
  assert.equal(conv.rfq.status, 'quoted');
  assert.equal(conv.quotation.items.length, 2);
  assert.equal(conv.quotation.items[0].pricingStatus, 'approved');
  assert.equal(conv.quotation.items[1].pricingStatus, 'pending');
});
