import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Customer, DevelopmentLetter, EmailSuppression, Organization, OutreachAutomationConfig, OutreachAutomationEnrollment, Project, ProjectPlaybook, User } from '../src/models';
import { indexSynchronizationMigration } from '../src/migrations/007-sync-indexes';
import { productionIndexesMigration } from '../src/migrations/014-production-indexes';
import { projectBrandPackagesMigration } from '../src/migrations/015-project-brand-packages';
import { KnowledgeChunk } from '../src/models/KnowledgeDocument';
import { MailMessage } from '../src/models/MailMessage';
import { runWithTenant } from '../src/models/tenant-context';
import { checkSemanticResults, type CustomerCheckContext } from '../src/services/agent/fact-verifier';
import { automatedReviewIssue, repeatedOutreachIssue } from '../src/services/agent/knowledge-send-gate';
import { draftHash } from '../src/services/agent/knowledge-grounding';
import type { KnowledgeBundle, KnowledgeReview } from '../src/services/agent/knowledge-types';
import { selectOutreachPlaybook } from '../src/services/agent/outreach-playbook';
import { newMessageId, processMailJob } from '../src/services/mail-queue.service';
import { importMail } from '../src/services/mail-sync.service';
import { applyBrandPackage, builtinBrandPackage, previewBrandPackage, rollbackBrandPackage } from '../src/services/playbook-import.service';
import { resolveProjectSalesProfile } from '../src/services/project-profile';
import type { AuthUser } from '../src/types/express';
import env from '../src/config/env';

const organizationId = new Types.ObjectId();
let mongo: MongoMemoryReplSet;
let actor: AuthUser;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri('outreach_fictional'), { autoIndex: false });
  const project = await Project.create({ name: 'Outreach fixture', code: 'FIXTURE', slug: 'outreach-fixture',
    organizationId, companyName: 'Fixture company', mailProfileKey: 'fixture' });
  actor = { id: new Types.ObjectId().toString(), organizationId: String(organizationId), projectId: project.id,
    username: 'fixture', displayName: 'Fixture', role: 'admin' };
});

after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('production migration builds core unique and TTL indexes and recovers tenant visibility of legacy chunks', async () => {
  await indexSynchronizationMigration.up(mongoose.connection);
  assert.equal((await User.collection.indexes()).length, 1);
  await KnowledgeChunk.collection.insertOne({ _id: 'fictional-legacy-chunk', projectId: new Types.ObjectId(actor.projectId), content: 'Fixture.' });
  await productionIndexesMigration.up(mongoose.connection);
  assert.ok((await User.collection.indexes()).some(index => index.unique));
  assert.ok((await mongoose.connection.collection('authsessions').indexes()).some(index => index.expireAfterSeconds === 0));
  assert.ok((await DevelopmentLetter.collection.indexes()).some(index => index.unique && Object.hasOwn(index.key, 'requestKey')));
  const own = () => KnowledgeChunk.findById('fictional-legacy-chunk').exec();
  assert.ok(await runWithTenant({ organizationId: actor.organizationId }, own));
  assert.equal(await runWithTenant({ organizationId: new Types.ObjectId().toString() }, own), null);
  await productionIndexesMigration.up(mongoose.connection);
});

test('catalog line supports a natural opening while it cannot substantiate supplier promises', () => {
  const source = 'The Oval Ring 925';
  const website = { sourceId: 'website:fixture', text: source, url: 'https://buyer.example.test', sha256: 'fixture', collectedAt: '2026-11-01' };
  const customer: CustomerCheckContext = { id: 'fixture', profile: { name: 'Fixture', company: 'Fixture', country: '', industry: '', interestedProducts: '' }, websites: [website] };
  const bundle: KnowledgeBundle = { projectId: 'fixture', status: 'ready', sources: [], issues: [], topics: [] };
  const verdict = [{ id: 's0', status: 'supported' as const, reason: 'fixture', quotes: [{ sourceId: website.sourceId, quote: source, start: 0, end: source.length }] }];
  assert.equal(checkSemanticResults('Loved The Oval Ring 925.', bundle, verdict, customer)[0]?.status, 'supported');
  assert.equal(checkSemanticResults('I noticed your ring and we guarantee delivery.', bundle, verdict, customer)[0]?.status, 'unsupported');
  assert.equal(checkSemanticResults('When buyers review strength equipment, consistent specifications can make comparison easier.', bundle, [])[0]?.status, 'non_claim');
});

test('one relevant alternative can lead step two without treating sales cards as facts', () => {
  const bundle = builtinBrandPackage('genesis');
  const cards = { segments: bundle.playbook.cards.filter(card => card.kind === 'segment'), preferences: bundle.playbook.cards.filter(card => card.kind === 'preference') };
  const candidates = { segments: cards.segments.slice(0, 2).map(card => ({ ...card, keywords: ['fixture handcraft'] })), preferences: cards.preferences };
  const input = { projectKey: 'genesis', cards: candidates, websiteText: 'fixture handcraft', contactRole: 'Procurement Director' };
  const first = selectOutreachPlaybook(input)!;
  assert.equal(first.contactRole, 'procurement');
  assert.equal(first.alternatives?.length, 1);
  const second = selectOutreachPlaybook({ ...input, outreachStep: 2, usedAngles: [first.segmentCode] });
  assert.equal(second?.segmentCode, first.alternatives?.[0]?.code);
});

test('automatic gate checks evidence and never inherits a human override for unverified drafts', () => {
  const review: KnowledgeReview = { version: 1, projectId: 'fixture', taskType: 'first_outreach', generatedAt: '2026-11-01', status: 'ready',
    completeness: 'complete', bodyHash: 'fixture', context: {}, sources: [], claims: [], questions: [], issues: [],
    factAudit: { contract: 's4.1', mode: 'semantic', attempts: 1, facts: [], checks: [
      { id: 's1', text: 'Could you share the sizes?', status: 'non_claim', reason: 'Fixture', sourceIds: [] },
    ] } };
  assert.ok(automatedReviewIssue(review, 1));
  assert.equal(automatedReviewIssue(review, 2), undefined);
  assert.ok(repeatedOutreachIssue(review, ['Could you share the sizes?']));
  assert.ok(automatedReviewIssue({ ...review, manualApprovedAt: '2026-11-01', issues: [{ code: 'draft_unverified', message: 'fixture' }] }, 2));
  assert.match(newMessageId('sender@mailer.example.test'), /@mailer\.example\.test>$/);
});

function mime(key: string, lines: string[]) {
  return Buffer.from([`From: ${key}@example.test`, 'To: team@example.test', 'Subject: Re: Size comparison',
    `Message-ID: <${key}@example.test>`, 'Content-Type: text/plain; charset=utf-8', '', ...lines].join('\r\n'));
}

test('quoted unsubscribe text is ignored and an interrupted real unsubscribe survives reimport', async t => {
  const projectId = actor.projectId!;
  await importMail(mime('quoted', ['Could you send a quote?', '', 'On Monday Sales wrote:', '> Unsubscribe to stop future outreach.']), 'fixture', projectId);
  assert.equal(await EmailSuppression.countDocuments({ email: 'quoted@example.test' }), 0);
  const update = t.mock.method(EmailSuppression, 'updateOne', () => { throw new Error('fictional write interruption'); });
  const request = mime('stop', ['Please unsubscribe me.']);
  await assert.rejects(() => importMail(request, 'fixture', projectId));
  update.mock.restore();
  await importMail(request, 'fixture', projectId);
  assert.equal(await EmailSuppression.countDocuments({ email: 'stop@example.test', reason: 'unsubscribe' }), 1);
  assert.equal(await MailMessage.countDocuments({ pendingCompliance: { $exists: true } }), 0);
});

test('all three private brand packages preview, import idempotently and roll back on isolated projects', async () => {
  let originalVersion = 0;
  for (const key of ['genesis', 'ironhue', 'velaturo'] as const) {
    const bundle = builtinBrandPackage(key);
    const preview = await previewBrandPackage(bundle, actor);
    assert.equal(preview.expectedVersion, originalVersion);
    const result = await applyBrandPackage({ bundle, expectedVersion: preview.expectedVersion }, actor);
    const repeat = await applyBrandPackage({ bundle, expectedVersion: preview.expectedVersion }, actor);
    assert.equal(repeat.version, result.version);
    assert.equal(repeat.unchanged, true);
    const project = await Project.findById(actor.projectId).lean();
    assert.equal(resolveProjectSalesProfile(project).key, key);
    assert.ok((await rollbackBrandPackage(result.version, actor)).version > result.version);
    originalVersion = result.version + 1;
  }
  await assert.rejects(() => previewBrandPackage(builtinBrandPackage('genesis'), { ...actor, organizationId: new Types.ObjectId().toString() }), /项目不存在/);
});

test('brand migration binds only the three default-organization workspaces, preserving existing card edits', async () => {
  const organization = await Organization.create({ name: 'Fixture default organization', slug: env.DEFAULT_ORGANIZATION_SLUG });
  const foreign = await Organization.create({ name: 'Another fictional organization', slug: 'outreach-other-fixture' });
  const createProject = (slug: string, code: string, id: Types.ObjectId) => Project.create({ name: 'Fixture workspace', slug, code,
    organizationId: id, companyName: 'Fixture seller', mailProfileKey: slug });
  const workspaces = await Promise.all([createProject('genesis-bags', 'GENESIS', organization._id), createProject('ironhue', 'IRONHUE', organization._id),
    createProject('velaturo', 'VELATURO', organization._id)]);
  const unrelated = await createProject('genesis-bags', 'GENESIS', foreign._id);
  const edit = { id: 'FIXTURE-CUSTOM', name: 'Fixture edited card' };
  await ProjectPlaybook.create({ projectId: workspaces[0]._id, segments: [edit], version: 3 });
  await projectBrandPackagesMigration.up(mongoose.connection);
  await projectBrandPackagesMigration.up(mongoose.connection);
  const packaged = await ProjectPlaybook.find({ projectId: { $in: workspaces.map(project => project._id) } }).lean();
  assert.equal(packaged.length, 3);
  assert.equal(packaged.find(row => row.projectId.equals(workspaces[0]._id))?.segments[0]?.id, edit.id);
  assert.equal(packaged.find(row => row.projectId.equals(workspaces[0]._id))?.version, 4);
  assert.equal(await ProjectPlaybook.exists({ projectId: unrelated._id }), null);
});

test('the actual queue blocks shadow mode and prevents a queued follow-up after an inbound reply', async () => {
  const projectId = new Types.ObjectId(actor.projectId);
  const user = await User.create({ username: 'queue-fixture', displayName: 'Fixture', passwordHash: 'test-only', role: 'user',
    status: 'active', organizationId, projectIds: [projectId] });
  const customer = await Customer.create({ projectId, organizationId, name: 'Fixture buyer', email: 'queue@example.test', ownerId: user._id });
  const campaign = await OutreachAutomationConfig.create({ projectId, userId: user._id, actorRole: 'user', enabled: true, rolloutMode: 'shadow' });
  const enrollment = await OutreachAutomationEnrollment.create({ projectId, campaignId: campaign._id, userId: user._id,
    customerId: customer._id, status: 'active', nextRunAt: new Date(0) });
  const contentText = 'Thank you for your time.';
  const make = () => DevelopmentLetter.create({ projectId, customerId: customer._id, sentBy: user._id, recipientEmail: customer.email,
    subject: 'Fixture sequence', content: contentText, contentText, status: 'scheduled', channel: 'mock', nextAttemptAt: new Date(0),
    automationCampaignId: campaign._id, automationEnrollmentId: enrollment._id, outreachStep: 3, knowledgeReview: {
      version: 1, projectId: String(projectId), taskType: 'first_outreach', generatedAt: new Date().toISOString(), status: 'ready', completeness: 'complete',
      bodyHash: draftHash(contentText), context: { customerId: customer.id }, sources: [], claims: [], questions: [], issues: [],
      factAudit: { contract: 's4.1', mode: 'semantic', attempts: 1, facts: [], checks: [
        { id: 's0', text: contentText, status: 'non_claim', sourceIds: [], reason: 'Fictional courtesy' },
      ] },
    } });
  let calls = 0;
  const fakeDeliver = async () => { calls++; return { accepted: true, channel: 'mock' as const, durationMs: 0 }; };
  const shadow = await make();
  await processMailJob(shadow.id, fakeDeliver);
  assert.equal(calls, 0);
  assert.equal((await DevelopmentLetter.findById(shadow.id))?.status, 'cancelled');
  await OutreachAutomationConfig.updateOne({ _id: campaign._id }, { $set: { rolloutMode: 'pilot' } });
  const allowed = await make();
  await processMailJob(allowed.id, fakeDeliver);
  assert.equal(calls, 1);
  await MailMessage.create({ projectId, customerId: customer._id, threadId: 'fictional', dedupKey: 'fixture-reply', from: customer.email,
    text: 'Could you send details?', sentAt: new Date(Date.now() + 1000) });
  const afterReply = await make();
  await processMailJob(afterReply.id, fakeDeliver);
  assert.equal(calls, 1);
  assert.equal((await DevelopmentLetter.findById(afterReply.id))?.status, 'cancelled');
});
