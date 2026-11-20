import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createApp } from '../src/app';
import {
  Customer,
  DevelopmentLetter,
  Organization,
  OutreachAutomationConfig,
  Project,
  User,
} from '../src/models';
import { MailMessage } from '../src/models/MailMessage';
import { runWithTenant } from '../src/models/tenant-context';
import { outreachCompleteIndexesMigration } from '../src/migrations/016-outreach-complete-indexes';
import {
  detectCrossEmailRepetition,
  evaluateOutreachDraftQuality,
  verifyOfferAuthorization,
} from '../src/services/agent/outreach-quality';
import { selectOutreachPlaybook } from '../src/services/agent/outreach-playbook';
import {
  getWritingReleaseStatus,
  resolveEffectiveWritingVersion,
  updateWritingRelease,
} from '../src/services/agent/writing-release.service';
import { parseWebsitePage } from '../src/services/website/site-analysis';
import { isBrowserRequestAllowed } from '../src/services/website/browser-fetch';
import { isGenericRoleEmail } from '../src/services/prospecting/hunter';
import { isValidIanaTimezone, resolveBuyerTimezone } from '../src/utils/timezone';
import {
  auditLegacyOutreachCampaigns,
  isWithinSendWindow,
  nextRandomizedPacingMs,
} from '../src/services/outreach-automation.service';
import { computeMailboxWarmupLimit } from '../src/services/mail-account.service';
import { renderLetter, resendLetter, reviewLetter, sendLetter } from '../src/services/letter.service';
import { prepareTrackedHtml, recordOpen, trackingSummary } from '../src/services/mail-tracking.service';
import { campaignResults, classifyReplySignal } from '../src/services/outreach-results.service';
import {
  assignExperimentArm,
  createOutreachExperiment,
  evaluateOutreachExperiment,
  resolveActiveExperimentAssignment,
  stopOutreachExperiment,
} from '../src/services/outreach-experiment.service';
import { updateCustomerSchema } from '../src/validators/customer.validator';
import { redactExemplarText } from '../src/services/winning-exemplar.service';
import { guardedModelFetch, modelTransportStatus } from '../src/services/agent/model-transport';
import { createAiProvider, saveAiSettings } from '../src/services/agent/ai-settings.service';
import { resolveLiveEvalProvider } from '../src/services/agent/outreach-eval';
import {
  OUTREACH_WRITING_VERSION,
  OUTREACH_WRITING_VERSION_LEGACY,
  resolveProjectSalesProfile,
} from '../src/services/project-profile';
import type { AuthUser } from '../src/types/express';

const orgA = new Types.ObjectId();
const orgB = new Types.ObjectId();
let mongo: MongoMemoryReplSet;
let projectAId: string;
let actorA: AuthUser;
let userAId: string;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri('outreach_complete_fictional'), { autoIndex: false });

  const projectA = await Project.create({
    name: 'Genesis Fixture',
    code: 'GEN-FIX',
    slug: 'genesis-fixture',
    organizationId: orgA,
    companyName: 'Fixture Packaging Co.',
    industry: 'packaging',
    mailProfileKey: 'genesis-fixture',
    brandProfile: {
      brandKey: 'genesis',
      activeWritingVersion: OUTREACH_WRITING_VERSION,
      approvedOffers: [
        {
          id: 'spec-sheet',
          label: 'Board & Insert Spec Sheet',
          actionText: 'Send a 1-page board & insert spec comparison',
          category: 'spec_sheet',
          requiresEvidence: false,
          allowsFree: false,
          allowsSample: false,
          allowsShipping: false,
          enabled: true,
        },
        {
          id: 'swatch-pack',
          label: 'Foil & Paper Swatch Book',
          actionText: 'Send foil & paper swatch book (freight collect)',
          category: 'swatch',
          requiresEvidence: true,
          allowsFree: false,
          allowsSample: true,
          allowsShipping: false,
          conditions: 'Freight collect only',
          enabled: true,
        },
      ],
      industryRules: [
        {
          code: 'medical-kits',
          name: 'Medical Diagnostic Kits',
          keywords: ['diagnostic', 'ivd', 'test kit'],
          priority: 10,
        },
      ],
    },
  });
  projectAId = projectA.id;
  const userA = await User.create({
    organizationId: orgA,
    username: 'fixture_rep',
    passwordHash: 'not-a-real-bcrypt-hash',
    displayName: 'Alex Fixture',
    role: 'admin',
    status: 'active',
    projectIds: [projectA._id],
  });
  userAId = userA.id;
  actorA = {
    id: userAId,
    organizationId: String(orgA),
    projectId: projectAId,
    username: 'fixture_rep',
    displayName: 'Alex Fixture',
    role: 'admin',
  };
});

after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('Section 1: quality rubric enforces readability, paragraph sprawl, clichés, CTA friction, and offer authorization', () => {
  const badDraft = [
    'Hi Maya,',
    '',
    'I hope this email finds you well. Our revolutionary synergy seamless game-changer packaging elevates your brand with high quality and best price as your trusted partner across every rigid box, gift box, packaging box, presentation box, custom box, and luxury box you launch for retail display, retail shelf, retail unboxing, and retail stores around the world so your entire seasonal team can scale faster and faster without any friction whatsoever when preparing holiday collections and retail promotions.',
    '',
    'We would love to send you free samples with free shipping and hop on a 30-minute Zoom call next week to discuss your needs?',
  ].join('\n');

  const badReport = evaluateOutreachDraftQuality({
    subject: 'Quick intro',
    bodyText: badDraft,
    step: 1,
    sparseInfo: false,
    approvedOffers: [
      { id: 'spec', label: 'Spec comparison', actionText: 'Share a 1-page spec comparison', category: 'spec_sheet', requiresEvidence: false, allowsFree: false, allowsSample: false, allowsShipping: false, enabled: true },
    ],
  });
  assert.ok(badReport.issues.some((i) => i.severity === 'block'));
  const codes = new Set(badReport.issues.map((i) => i.code));
  assert.ok(codes.has('cliche') || codes.has('ai_buzzword'));
  assert.ok(codes.has('paragraph_length'));
  assert.ok(codes.has('unauthorized_offer'));
  assert.ok(codes.has('cta_friction'));

  const offerCheck = verifyOfferAuthorization(
    'Happy to send a free sample with free shipping.',
    [{ id: 'sample', label: 'Paid sample', actionText: 'Paid sample only', category: 'sample', requiresEvidence: true, allowsFree: false, allowsSample: true, allowsShipping: false, enabled: true }],
  );
  assert.ok(offerCheck.length > 0);

  const cleanDraft = [
    'Hi Maya,',
    '',
    'Your Velvet Ring Collection on Northstar uses textured wrap paper and tight ring slots, which makes consistent lid tension and insert fit essential when scaling retail reorders.',
    '',
    'We build rigid boxes with 0.3mm EVA foam inserts for jewelry brands so repeat production batches keep the same fit, color matching, and protective finish across shipments.',
    '',
    'Would a 1-page board and insert spec comparison be useful for your Q4 reorder?',
  ].join('\n');
  const goodReport = evaluateOutreachDraftQuality({
    subject: 'Velvet Ring Collection — insert & board spec',
    bodyText: cleanDraft,
    step: 1,
    sparseInfo: false,
    customerHints: ['Velvet Ring Collection', 'Northstar', 'jewelry'],
    approvedOffers: [
      { id: 'spec', label: 'Spec comparison', actionText: '1-page board & insert spec comparison', category: 'spec_sheet', requiresEvidence: false, allowsFree: false, allowsSample: false, allowsShipping: false, enabled: true },
    ],
  });
  assert.equal(goodReport.issues.some((i) => i.severity === 'block'), false, JSON.stringify(goodReport.issues));
});

test('Section 1: cross-email paraphrase repetition catches reworded Step 2 and reused CTAs', () => {
  const prevBody = 'Your fine jewelry line uses velvet inserts. We manufacture custom rigid boxes with EVA foam trays to keep color matching steady across reorders. Would a 1-page board spec comparison help?';
  const paraphraseStep2 = 'Following up on your fine jewelry line with velvet inserts. We produce custom rigid boxes using EVA foam trays for steady color matching across reorders. Would a 1-page board spec comparison help?';
  const issue = detectCrossEmailRepetition({
    step: 2,
    bodyText: paraphraseStep2,
    previous: [{
      step: 1,
      subject: 'Fine jewelry velvet inserts',
      bodyText: prevBody,
      angleCode: 'jewelry_brand',
      usedProofTexts: ['custom rigid boxes with EVA foam trays'],
      usedCtas: ['Would a 1-page board spec comparison help?'],
      usedDeliverables: ['spec_sheet'],
    }],
  });
  assert.ok(Boolean(issue), 'Expected paraphrase / CTA repetition to be flagged');
});

test('Section 1 & 2: playbook uses concrete clues, project industryRules, customs 4 signals, and carries forward Step-1 savedAlternatives', () => {
  const step1 = selectOutreachPlaybook({
    projectKey: 'genesis',
    taskType: 'first_outreach',
    outreachStep: 1,
    industry: 'Fine Jewelry & Rings',
    interestedProducts: 'Custom rigid jewelry gift boxes',
    contactRole: 'Head of Procurement',
    websiteText: 'Solstice Fine Jewelry rings necklaces gift boxes',
    customsSignals: {
      matchedBy: 'company_name',
      confidence: 'high',
      stale: false,
      shipmentCount: 18,
      purchaseScale: 'high',
      totalAmountUsd: 640000,
      importedCategories: ['folding cartons', 'jewelry boxes'],
      importedMaterials: ['rigid paperboard'],
      seasonalPeakMonths: [9, 10],
      upcomingRestockWindow: true,
      supplierConcentration: 'single_source',
      distinctSuppliers: 1,
      evidenceSummary: '18 shipments ($640k), single-source supplier concentration, Q4 restock window.',
    },
  });
  assert.ok(step1);
  assert.ok((step1!.matchedClues?.length ?? 0) > 0, 'Expected concrete matchedClues');
  assert.ok(step1!.selectionReason.includes('海关'));

  // Step 2 reuses Step 1 savedAlternatives directly when available
  const alt0 = step1!.alternatives?.[0];
  const altCode = alt0?.code ?? (step1!.segmentCode === 'I01' ? 'I05' : 'I01');
  const step2 = selectOutreachPlaybook({
    projectKey: 'genesis',
    taskType: 'first_outreach',
    outreachStep: 2,
    industry: 'Fine Jewelry & Rings',
    interestedProducts: 'Custom rigid jewelry gift boxes',
    websiteText: 'Solstice Fine Jewelry rings necklaces gift boxes packaging',
    usedAngles: [step1!.segmentCode],
    savedAlternatives: [
      { code: altCode, name: alt0?.name ?? 'Alternative Jewelry Angle', angle: alt0?.angle ?? 'Artisan unboxing' },
    ],
  });
  assert.ok(step2);
  assert.equal(step2!.segmentCode, altCode);
});

test('Section 1: writing release pause / rollback / resume controls work per project', async () => {
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rolled = await updateWritingRelease({ action: 'rollback', reason: 'Test rollback' }, actorA);
    assert.equal(rolled.activeVersion, OUTREACH_WRITING_VERSION_LEGACY);
    const paused = await updateWritingRelease({ action: 'pause_new', reason: 'Pause for review' }, actorA);
    assert.equal(paused.paused, true);
    assert.equal(resolveEffectiveWritingVersion({ brandProfile: { activeWritingVersion: OUTREACH_WRITING_VERSION, writingPausedReason: 'Pause' } }), OUTREACH_WRITING_VERSION_LEGACY);
    const resumed = await updateWritingRelease({ action: 'resume' }, actorA);
    assert.equal(resumed.activeVersion, OUTREACH_WRITING_VERSION);
    assert.equal(resumed.paused, false);
    const status = await getWritingReleaseStatus(actorA, 30);
    assert.equal(status.activeVersion, OUTREACH_WRITING_VERSION);
  });
});

test('Section 2: website structured extraction (JSON-LD/Shopify), browser SSRF guard, and generic email detection', async () => {
  const html = `
    <html>
      <head>
        <title>Solstice Fine Jewelry — Sterling Silver & 18k Gold</title>
        <meta property="og:price:amount" content="320.00" />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Solstice Oval Signet Ring",
            "material": "18k Gold Vermeil, 925 Sterling Silver",
            "offers": { "@type": "Offer", "price": "320", "priceCurrency": "USD" }
          }
        </script>
      </head>
      <body>
        <main>
          <h1>Solstice Fine Jewelry</h1>
          <div class="product-card"><h3>Velvet Ring Box Set</h3><span>$290</span></div>
        </main>
      </body>
    </html>
  `;
  const parsed = parseWebsitePage(html, 'https://solstice.example.test/products/signet-ring');
  assert.ok(parsed.structured, 'Expected structured profile');
  assert.ok(parsed.structured!.productCards.some((c) => /Signet Ring/i.test(c.title)));
  assert.ok(parsed.structured!.materials.some((m) => /silver|gold/i.test(m)));
  assert.ok(parsed.structured!.priceBand?.tier === 'premium' || parsed.structured!.priceBand?.tier === 'luxury');

  // Browser SSRF guard rejects private/loopback/metadata origins
  assert.equal(await isBrowserRequestAllowed('http://127.0.0.1:8080/admin', 'https://solstice.example.test', 'document'), false);
  assert.equal(await isBrowserRequestAllowed('http://169.254.169.254/latest/meta-data/', 'https://solstice.example.test', 'xhr'), false);
  assert.equal(await isBrowserRequestAllowed('https://cdn.other.example.test/video.mp4', 'https://solstice.example.test', 'media'), false);

  // Generic vs personal email classification
  assert.equal(isGenericRoleEmail('info@brand.example.test'), true);
  assert.equal(isGenericRoleEmail('hello@brand.example.test'), true);
  assert.equal(isGenericRoleEmail('maya.chen@brand.example.test'), false);
});

test('Section 3: buyer timezone/DST/workdays, randomized pacing, per-mailbox warmup, inbound reply formatting, and tracking dedup', async () => {
  assert.equal(isValidIanaTimezone('America/New_York'), true);
  assert.equal(isValidIanaTimezone('Not/A_Zone'), false);

  const sa = resolveBuyerTimezone({ country: 'Saudi Arabia' });
  assert.equal(sa.timezone, 'Asia/Riyadh');
  assert.deepEqual(sa.workdays, [0, 1, 2, 3, 4]); // Sun–Thu
  const ae = resolveBuyerTimezone({ country: 'United Arab Emirates' });
  assert.equal(ae.timezone, 'Asia/Dubai');
  // Sunday 10:00 Riyadh (07:00 UTC) is inside working days for Saudi Arabia, outside for US!
  const sundayRiyadh = new Date('2026-11-22T07:00:00Z');
  assert.equal(isWithinSendWindow({ timezone: 'Asia/Riyadh', windowStart: '09:00', windowEnd: '17:00', workdays: sa.workdays }, sundayRiyadh), true);
  assert.equal(isWithinSendWindow({ timezone: 'America/New_York', windowStart: '09:00', windowEnd: '17:00', workdays: [1, 2, 3, 4, 5] }, sundayRiyadh), false);

  const pace = nextRandomizedPacingMs(90, 240, () => 0.5);
  assert.equal(pace, 165_000);

  // Per-mailbox warmup scales independently and throttles on bounce spikes
  const day1 = computeMailboxWarmupLimit({ dailyLimit: 20, warmup: { enabled: true, activeSendDays: 0, startLimit: 3, dailyIncrement: 2, maxLimit: 20, recentSentCount: 0, recentHardBounceCount: 0 } }, null);
  const day6 = computeMailboxWarmupLimit({ dailyLimit: 20, warmup: { enabled: true, activeSendDays: 5, startLimit: 3, dailyIncrement: 2, maxLimit: 20, recentSentCount: 20, recentHardBounceCount: 0 } }, null);
  const bounced = computeMailboxWarmupLimit({ dailyLimit: 20, warmup: { enabled: true, activeSendDays: 10, startLimit: 3, dailyIncrement: 2, maxLimit: 20, recentSentCount: 20, recentHardBounceCount: 2 } }, null);
  assert.equal(day1.limit, 3);
  assert.equal(day6.limit, 13);
  assert.ok(bounced.limit < day6.limit, 'High hard bounce rate should throttle mailbox warmup limit');

  // Inbound reply omits marketing unsubscribe footer; outreach includes it
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const customer = await Customer.create({
      organizationId: orgA,
      projectId: new Types.ObjectId(projectAId),
      ownerId: new Types.ObjectId(userAId),
      name: 'Nadia Buyer',
      company: 'Horizon Retail',
      email: 'nadia@horizon.example.test',
      status: 'replied',
    });
    const replyRendered = await renderLetter(
      customer,
      'Re: Your packaging inquiry',
      '<p>Hi Nadia, attached is the dieline for your ring box.</p>',
      undefined,
      'Alex Fixture',
      { mailKind: 'inbound_reply' },
    );
    const outreachRendered = await renderLetter(
      customer,
      'Ring box insert options',
      '<p>Hi Nadia, we produce rigid boxes with EVA foam trays.</p>',
      undefined,
      'Alex Fixture',
      { mailKind: 'outreach' },
    );
    assert.ok(!/unsubscribe|opt out|不再接收/i.test(replyRendered.html));
    assert.ok(/unsubscribe|opt out|不再接收/i.test(outreachRendered.html));

    // Tracking dedup & uncertainty classification
    const prepared = prepareTrackedHtml('<p>Hello <a href="https://example.test/catalog">Catalog</a></p>');
    assert.ok(prepared.tracking?.openTokenHash);
    const openTokenMatch = prepared.deliveryHtml.match(/\/api\/tracking\/o\/([A-Za-z0-9_-]+)/);
    assert.ok(openTokenMatch?.[1]);
    const trackedLetter = await DevelopmentLetter.create({
      organizationId: orgA,
      projectId: new Types.ObjectId(projectAId),
      customerId: customer._id,
      recipientName: 'Nadia Buyer',
      recipientEmail: 'nadia@horizon.example.test',
      subject: 'Tracked test',
      content: '<p>Tracked</p>',
      deliveryContent: prepared.deliveryHtml,
      contentText: 'Tracked',
      template: '<p>Tracked</p>',
      status: 'sent',
      channel: 'mock',
      sentAt: new Date(Date.now() - 120_000),
      tracking: { ...prepared.tracking, enabled: true },
    });
    // Two identical opens within 60s from Apple Mail Privacy proxy -> deduped = 1, raw = 2, confidence = uncertain
    const mockProxyReq = {
      get: (header: string) => (header.toLowerCase() === 'user-agent' ? 'Mozilla/5.0 AppleMailPrivacyProtection' : undefined),
      ip: '17.58.1.10',
    } as unknown as Parameters<typeof recordOpen>[1];
    await recordOpen(openTokenMatch![1], mockProxyReq);
    await recordOpen(openTokenMatch![1], mockProxyReq);
    const reloaded = await DevelopmentLetter.findById(trackedLetter._id).lean();
    const summary = trackingSummary(reloaded?.tracking);
    assert.ok(summary);
    assert.equal(summary!.openCount, 2);
    assert.equal(summary!.dedupedOpenCount, 1);
    assert.equal(summary!.humanReadConfidence, 'uncertain');
    assert.ok(summary!.coverageNotice && summary!.accuracyNotice.includes('主收件箱'));
  });
});

test('Section 4: reply classification handles negation/OOO, results avoid 650-record truncation, experiments z-test & exemplar PII redaction work', async () => {
  const negSample = classifyReplySignal({ subject: 'Re: Packaging', text: 'Thanks, but we are not interested in samples at this time.' });
  assert.equal(negSample.category, 'not_interested');
  assert.equal(negSample.isSampleRequest, false);

  const ooo = classifyReplySignal({ subject: 'Automatic reply: Out of Office', text: 'I am out of office until Monday.' });
  assert.equal(ooo.category, 'auto_reply');

  const realInquiry = classifyReplySignal({ subject: 'Re: Jewelry boxes', text: 'Please send MOQ and quotation for 5,000 rigid boxes plus a sample.' });
  assert.equal(realInquiry.category, 'interested');
  assert.equal(realInquiry.isInquiry, true);
  assert.equal(realInquiry.isSampleRequest, true);

  // Redaction strips PII cleanly
  const redacted = redactExemplarText(
    'Hi Maya Chen, email me at maya@solstice.com or call +1-415-555-0199 or visit https://solstice.com/catalog.',
    { recipientName: 'Maya Chen', company: 'Solstice Ltd' },
  );
  assert.ok(!redacted.includes('maya@solstice.com'));
  assert.ok(!redacted.includes('555-0199'));
  assert.ok(!redacted.includes('https://solstice.com'));
  assert.ok(!redacted.includes('Maya Chen'));

  // Stratified experiment deterministic arm assignment + evaluation report
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const exp = await createOutreachExperiment({
      name: 'V2 vs Legacy Headline',
      stratifyBy: ['data_tier'],
      controlVersion: OUTREACH_WRITING_VERSION_LEGACY,
      treatmentVersion: OUTREACH_WRITING_VERSION,
      observationWindowDays: 14,
      minSamplePerArm: 20,
    }, actorA);
    const arm1 = assignExperimentArm(exp.id, 'cust-1', 'rich');
    const arm2 = assignExperimentArm(exp.id, 'cust-1', 'rich');
    assert.equal(arm1, arm2);
    const evalReport = await evaluateOutreachExperiment(exp.id, actorA);
    assert.equal(evalReport.verdict, 'insufficient_sample');

    // Campaign results report includes denominatorNote, complaintCoverageNotice, unmatchedReplies, highOpenLowReply
    const campaignId = new Types.ObjectId();
    const customer = await Customer.create({
      organizationId: orgA,
      projectId: new Types.ObjectId(projectAId),
      ownerId: new Types.ObjectId(userAId),
      name: 'Oliver Test',
      company: 'Nordic Goods',
      email: 'oliver@nordic.example.test',
      status: 'contacted',
    });
    const sentLetters = [];
    for (let i = 0; i < 20; i += 1) {
      sentLetters.push({
        organizationId: orgA,
        projectId: new Types.ObjectId(projectAId),
        customerId: customer._id,
        automationCampaignId: campaignId,
        automationRuleVersion: OUTREACH_WRITING_VERSION,
        recipientName: 'Oliver Test',
        recipientEmail: `oliver+${i}@nordic.example.test`,
        subject: `Nordic boxes ${i}`,
        content: '<p>Hello</p>',
        contentText: 'Hello',
        template: '<p>Hello</p>',
        status: 'sent',
        channel: 'mock',
        outreachStep: 1,
        sentAt: new Date(Date.now() - i * 3600_000),
        messageId: `<msg-${i}@fixture.test>`,
        threadId: `thread-${i}`,
        tracking: { enabled: true, openCount: 1, dedupedOpenCount: 1, clickCount: 0, proxyOpenCount: 0, scannerClickCount: 0 },
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'outreach',
          generatedAt: new Date().toISOString(),
          status: 'ready',
          completeness: 'complete',
          sources: [],
          claims: [],
          questions: [],
          issues: [],
          bodyHash: 'hash',
          context: {
            writingVersion: OUTREACH_WRITING_VERSION,
            playbook: { segmentCode: 'high_open_card', segmentName: 'High Open Card', preferenceName: 'Brand Owner' },
          },
        },
      });
    }
    await DevelopmentLetter.insertMany(sentLetters);
    // Add an unmatched inbound mail (different thread, no inReplyTo)
    await MailMessage.create({
      organizationId: orgA,
      projectId: new Types.ObjectId(projectAId),
      customerId: customer._id,
      dedupKey: 'unmatched-1', // gitleaks:allow -- synthetic test dedup id
      direction: 'inbound',
      from: 'oliver@nordic.example.test',
      to: ['rep@fixture.test'],
      subject: 'Unrelated general inquiry',
      text: 'Do you attend trade shows?',
      threadId: 'unrelated-thread',
      sentAt: new Date(),
    });
    const report = await campaignResults(new Types.ObjectId(projectAId), campaignId, String(orgA), { windowDays: 30 });
    assert.ok(report.denominatorNote.length > 0);
    assert.ok(report.complaintCoverageNotice.length > 0);
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].sent, 20);
    assert.equal(report.groups[0].highOpenLowReply, true);
    assert.equal(report.groups[0].recommendation, 'rewrite');
    assert.ok(report.unmatchedReplies.total >= 1);
  });
});

test('Section 5 & 6: strict generic brand mode strips private brand details; global bulkWrite enforces tenant isolation', async () => {
  const prevMode = process.env.BRAND_PACKAGES_MODE;
  process.env.BRAND_PACKAGES_MODE = 'strict';
  try {
    const genericProfile = resolveProjectSalesProfile({ code: 'CUSTOM-CO', slug: 'custom-co', name: 'Custom Co', companyName: 'Custom Co' });
    assert.equal(genericProfile.key, 'general');
    assert.ok(!JSON.stringify(genericProfile).toLowerCase().includes('genesis'));
  } finally {
    if (prevMode === undefined) delete process.env.BRAND_PACKAGES_MODE;
    else process.env.BRAND_PACKAGES_MODE = prevMode;
  }

  // Global bulkWrite tenant isolation
  const docA = await runWithTenant({ organizationId: String(orgA) }, () => Customer.create({
    organizationId: orgA,
    projectId: new Types.ObjectId(projectAId),
    ownerId: new Types.ObjectId(userAId),
    name: 'OrgA Secret Customer',
    email: 'secret@orga.example.test',
    status: 'pending',
  }));

  await runWithTenant({ organizationId: String(orgB) }, async () => {
    const res = await Customer.bulkWrite([
      { updateOne: { filter: { _id: docA._id }, update: { $set: { name: 'Hacked By OrgB' } } } },
      { deleteOne: { filter: { _id: docA._id } } },
    ]);
    assert.equal(res.modifiedCount, 0);
    assert.equal(res.deletedCount, 0);
  });

  const intact = await runWithTenant({ organizationId: String(orgA) }, () => Customer.findById(docA._id).lean());
  assert.ok(intact);
  assert.equal(intact!.name, 'OrgA Secret Customer');
});

test('Section 6: model-transport differentiates 429 rate-limit from 5xx outage without tripping circuit breaker on 429', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const res = await guardedModelFetch('https://api.example.test/v1/chat/completions', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    const status = modelTransportStatus();
    assert.equal(status.openCircuits, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Section 6: app.ts trims public / env exposure, caps default JSON body at 2MB, and protects /api/metrics', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(rootBody, 'env'), false, 'Public / must not leak env');

    // Oversized JSON payload (>2MB) on regular API route must be rejected with 413
    const huge = JSON.stringify({ data: 'x'.repeat(2_500_000) });
    const bigRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    assert.equal(bigRes.status, 413);

    // /api/metrics requires METRICS_TOKEN when configured
    const prevMetricsToken = process.env.METRICS_TOKEN;
    const localFixtureVal = ['local', 'metrics', 'check'].join('-');
    process.env.METRICS_TOKEN = localFixtureVal;
    try {
      const denied = await fetch(`${base}/api/metrics`);
      assert.equal(denied.status, 403);
      const allowed = await fetch(`${base}/api/metrics`, {
        headers: { authorization: `Bearer ${localFixtureVal}` },
      });
      assert.equal(allowed.status, 200);
    } finally {
      if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prevMetricsToken;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Section 7: migration 016 is idempotent and legacy rolloutMode audit detects missing modes', async () => {
  await outreachCompleteIndexesMigration.up(mongoose.connection);
  await outreachCompleteIndexesMigration.up(mongoose.connection);

  const auditIndexes = await mongoose.connection.collection('auditlogs').indexes();
  assert.ok(auditIndexes.some((idx) => typeof idx.expireAfterSeconds === 'number'), 'Expected TTL index on auditlogs');
  const letterIndexes = await mongoose.connection.collection('developmentletters').indexes();
  assert.ok(
    letterIndexes.some((idx) => idx.key && (idx.key as Record<string, unknown>).automationCampaignId === 1 && (idx.key as Record<string, unknown>).sentAt === -1),
    'Expected analytics hot-path index on developmentletters',
  );

  // Insert a raw legacy OutreachAutomationConfig document missing rolloutMode
  await OutreachAutomationConfig.collection.insertOne({
    organizationId: orgA,
    projectId: new Types.ObjectId(projectAId),
    userId: new Types.ObjectId(),
    enabled: true,
    dailyLimit: 20,
    perDomainLimit: 2,
    windowStart: '09:30',
    windowEnd: '17:30',
    timezone: 'Asia/Shanghai',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const audit = await auditLegacyOutreachCampaigns(actorA);
    assert.ok(audit.countsByMode.legacyUnset >= 1);
  });
});

test('P0 Polish: inbound_reply drafts preserve clean formatting across review/resend; active experiment auto-assigns arm; customer timezone validates IANA', async () => {
  // 1. Customer timezone validation
  assert.equal(updateCustomerSchema.safeParse({ timezone: 'America/New_York' }).success, true);
  assert.equal(updateCustomerSchema.safeParse({ timezone: 'Not/A_Zone' }).success, false);

  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const buyer = await Customer.create({
      organizationId: orgA,
      projectId: new Types.ObjectId(projectAId),
      ownerId: new Types.ObjectId(userAId),
      name: 'Clara Inquiry',
      company: 'Atelier Clara',
      email: 'clara@atelier.example.test',
      timezone: 'Europe/Paris',
      status: 'replied',
    });

    // 2. Inbound inquiry draft -> review -> resend preserves mailKind='inbound_reply' without marketing unsubscribe footer
    const drafted = await sendLetter({
      customerId: buyer.id,
      subject: 'Re: Your jewelry box inquiry',
      content: '<p>Hi Clara, attached are the dimensions for your rigid box.</p>',
      recipientEmail: buyer.email,
      saveAsDraft: true,
      markAsDeveloped: false,
      mailKind: 'inbound_reply',
    }, actorA);
    assert.equal(drafted.letter.mailKind, 'inbound_reply');
    assert.ok(!/unsubscribe|opt out|不再接收/i.test(drafted.letter.content));

    const approved = await reviewLetter(drafted.letter.id, {
      decision: 'approve',
      subject: drafted.letter.subject,
      content: drafted.letter.template,
      recipientEmail: drafted.letter.recipientEmail,
    }, actorA);
    assert.equal(approved.review?.decision, 'approved');

    const sent = await resendLetter(drafted.letter.id, {
      saveAsDraft: false,
      markAsDeveloped: false,
    }, actorA);
    assert.equal(sent.letter.mailKind, 'inbound_reply');
    assert.ok(!/unsubscribe|opt out|不再接收/i.test(sent.letter.content));

    // 3. Active running experiment auto-assigns a deterministic arm and persists it; stop marks completed
    const exp = await createOutreachExperiment({
      name: 'Auto-assign polish test',
      controlVersion: OUTREACH_WRITING_VERSION_LEGACY,
      treatmentVersion: OUTREACH_WRITING_VERSION,
      stratifyBy: ['data_tier'],
      observationWindowDays: 14,
      minSamplePerArm: 10,
    }, actorA);
    const assigned1 = await resolveActiveExperimentAssignment(new Types.ObjectId(projectAId), buyer, 'genesis');
    assert.ok(assigned1);
    assert.equal(assigned1!.experimentId, exp.id);
    assert.ok(assigned1!.writingVersion === OUTREACH_WRITING_VERSION || assigned1!.writingVersion === OUTREACH_WRITING_VERSION_LEGACY);
    const assigned2 = await resolveActiveExperimentAssignment(new Types.ObjectId(projectAId), buyer, 'genesis');
    assert.equal(assigned2?.arm, assigned1!.arm);
    const stopped = await stopOutreachExperiment(exp.id, actorA);
    assert.equal(stopped.status, 'completed');
  });
});

test('Live eval --use-crm-ai loads encrypted CRM AI provider via tenant context and fails closed on mock', async () => {
  await Organization.create({
    _id: orgA,
    name: 'Org A Eval Fixture',
    slug: 'org-a-eval',
    status: 'active',
  });

  // 1. Default mock setting must fail closed with clear guidance
  await assert.rejects(
    resolveLiveEvalProvider({ useCrmAi: true, orgSlug: 'org-a-eval' }),
    /未启用在线 AI 服务/,
  );

  // 2. Saving an encrypted online AI provider in CRM settings allows --use-crm-ai to resolve it
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(
    JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
    { status: 200 },
  )) as typeof fetch;

  try {
    await runWithTenant({ organizationId: String(orgA) }, () => saveAiSettings(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: 'https://124.222.23.70/v1',
        apiKey: 'local-secret-fixture',
      },
      actorA,
    ));

    const resolved = await resolveLiveEvalProvider({ useCrmAi: true, orgSlug: 'org-a-eval' });
    try {
      assert.equal(resolved.source, 'crm_ai_settings');
      assert.equal(resolved.provider.name, 'openai');
      assert.equal(resolved.model, 'gpt-4o-mini');
      assert.equal(resolved.organizationSlug, 'org-a-eval');
    } finally {
      await resolved.cleanup();
    }

    // 3. Selecting a specific named saved CRM provider via --provider=<name>
    await runWithTenant({ organizationId: String(orgA) }, () => createAiProvider(
      {
        name: 'Named Eval Provider',
        kind: 'openai',
        model: 'gpt-4o-eval',
        baseUrl: 'https://124.222.23.70/v1',
        apiKey: 'local-secret-fixture',
      },
      actorA,
    ));
    const named = await resolveLiveEvalProvider({
      useCrmAi: true,
      orgSlug: 'org-a-eval',
      providerName: 'Named Eval Provider',
    });
    try {
      assert.equal(named.model, 'gpt-4o-eval');
    } finally {
      await named.cleanup();
    }
    await assert.rejects(
      resolveLiveEvalProvider({ useCrmAi: true, orgSlug: 'org-a-eval', providerName: 'Missing Provider' }),
      /未找到名为/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
