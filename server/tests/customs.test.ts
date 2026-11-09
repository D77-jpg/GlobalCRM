import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.MAIL_TRANSPORT = 'mock';
process.env.JWT_SECRET = randomUUID();

let db: typeof import('mongoose');
let models: typeof import('../src/models');
let server: Server;
let base: string;
let adminToken: string;
let salesToken: string;
let projectId: string;
let sourceId: string;
const suffix = Date.now();

async function request(method: string, url: string, token: string, body?: unknown, expected = 200) {
  const response = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { 'X-Project-Id': projectId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json() as { data: any; error?: { message: string } };
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(json)}`);
  return json.data;
}

before(async () => {
  const memoryServer = await import('mongodb-memory-server').then(({ MongoMemoryServer }) => MongoMemoryServer.create());
  db = await import('mongoose');
  await db.default.connect(memoryServer.getUri(), { dbName: `customs_tests_${suffix}` });
  models = await import('../src/models');
  const projectService = await import('../src/services/project.service');
  await projectService.bootstrapProjects();
  projectId = String((await models.Project.findOne({ slug: 'genesis-bags' }))!._id);
  const auth = await import('../src/services/auth.service');
  const admin = await models.User.create({
    username: `customs-admin-${suffix}`,
    passwordHash: await models.hashPassword('fixture-password'),
    role: 'admin',
    status: 'active',
    projectIds: [projectId],
    defaultProjectId: projectId,
  });
  const sales = await models.User.create({
    username: `customs-sales-${suffix}`,
    passwordHash: await models.hashPassword('fixture-password'),
    role: 'user',
    status: 'active',
    projectIds: [projectId],
    defaultProjectId: projectId,
  });
  adminToken = (await auth.login(admin.username, 'fixture-password')).token;
  salesToken = (await auth.login(sales.username, 'fixture-password')).token;
  const app = (await import('../src/app')).createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  // Keep the memory server alive for the duration of the test.
  (server as Server & { __memoryServer?: MongoMemoryServer }).__memoryServer = memoryServer;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) {
    try { await db.default.connection.dropDatabase(); } catch { /* cleanup */ }
    await db.default.disconnect();
  }
  const memoryServer = (server as Server & { __memoryServer?: MongoMemoryServer })?.__memoryServer;
  if (memoryServer) await memoryServer.stop();
});

test('customs source and import normalize and search records', async () => {
  const source = await request('POST', '/customs/sources', adminToken, {
    name: 'Fixture US customs',
    provider: `fixture-${suffix}`,
    kind: 'csv',
    coverageCountries: ['United States', 'Germany'],
  }, 201);
  sourceId = source.id;
  assert.deepEqual(source.coverageCountries, ['US', 'DE']);

  const rows = [
    {
      sourceRecordId: `fixture-${suffix}-1`,
      importerName: 'Acme Trading Ltd.',
      importerCountry: 'United States',
      exporterName: 'Genesis Bags Co., Ltd.',
      exporterCountry: 'China',
      hsCode: '4202.22.00',
      productDescription: 'Jewellery packaging pouches',
      quantity: 1200,
      quantityUnit: 'pcs',
      amount: 18400,
      currency: 'USD',
      amountUsd: 18400,
      shipmentDate: '2026-10-15',
      portOfLoading: 'Ningbo',
      portOfDischarge: 'Los Angeles',
    },
    {
      sourceRecordId: `fixture-${suffix}-2`,
      importerName: 'Acme Trading Ltd.',
      importerCountry: 'US',
      exporterName: 'Genesis Bags Co., Ltd.',
      exporterCountry: 'CN',
      hsCode: '420222',
      productDescription: 'Gift boxes',
      amountUsd: 9200,
      shipmentDate: '2026-11-01',
      portOfLoading: 'Shanghai',
      portOfDischarge: 'New York',
    },
  ];
  const imported = await request('POST', '/customs/import', adminToken, { sourceId, rows }, 200);
  assert.equal(imported.read, 2);
  assert.equal(imported.written, 2);
  assert.equal(imported.skipped, 0);
  assert.equal(imported.errors.length, 0);

  const duplicate = await request('POST', '/customs/import', adminToken, { sourceId, rows }, 200);
  assert.equal(duplicate.skipped, 2);
  assert.equal(duplicate.written, 0);

  const search = await request('GET', '/customs/search?q=Acme&page=1&limit=10', salesToken);
  assert.equal(search.total, 2);
  assert.equal(search.items[0].importerCompanyId.canonicalName, 'Acme Trading Ltd.');

  const companies = await request('GET', '/customs/companies?q=Acme&page=1&limit=10', salesToken);
  assert.equal(companies.total, 1);
  assert.equal(companies.items[0].country, 'US');
  assert.equal(companies.items[0].shipmentCount, 2);

  const detail = await request('GET', `/customs/companies/${companies.items[0]._id}`, salesToken);
  assert.equal(detail.company.normalizedName, 'acme');
  assert.equal(detail.recentShipments.length, 2);
  assert.ok(detail.topSuppliers.length >= 1);
});

test('customs import is admin only and rejects unknown sources', async () => {
  await request('POST', '/customs/import', salesToken, { sourceId, rows: [] }, 403);
  await request('POST', '/customs/import', adminToken, { sourceId: '000000000000000000000000', rows: [{ importerName: 'X', importerCountry: 'US', shipmentDate: '2026-01-01' }] }, 404);
});
