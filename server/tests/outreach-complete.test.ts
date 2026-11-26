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

test('Section 8: admin can batch-reverify a paused rep unverified/partial drafts without enabling sending or touching replied blocks', async () => {
  const {
    OutreachAutomationEnrollment,
  } = await import('../src/models');
  const { AgentTask } = await import('../src/models/AgentTask');
  const {
    getOutreachAutomationOverview,
    reverifyUnverifiedOutreachDrafts,
    inspectOutreachDraftAudit,
  } = await import('../src/services/outreach-automation.service');

  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rep = await User.create({
      organizationId: orgA,
      username: 'fictional_carlos_rep',
      passwordHash: 'not-a-real-bcrypt-hash',
      displayName: 'Carlos Fixture',
      role: 'user',
      status: 'active',
      projectIds: [new Types.ObjectId(projectAId)],
    });

    const repActor: AuthUser = {
      id: rep.id,
      organizationId: String(orgA),
      projectId: projectAId,
      username: rep.username,
      displayName: rep.displayName,
      role: 'user',
    };

    const campaign = await OutreachAutomationConfig.create({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      actorRole: 'user',
      enabled: false,
      pausedReason: '修复正文核验中，暂时暂停正式发送',
      rolloutMode: 'active',
      dailyLimit: 20,
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
    });

    const [cUnavail, cPartial, cReplied] = await Customer.create([
      {
        projectId: new Types.ObjectId(projectAId),
        ownerId: rep._id,
        name: 'Fictional Gym Alpha',
        company: 'Alpha Fitness Co.',
        email: 'alpha@example.test',
        status: 'pending',
        source: 'manual',
      },
      {
        projectId: new Types.ObjectId(projectAId),
        ownerId: rep._id,
        name: 'Fictional Gym Beta',
        company: 'Beta Sports AB',
        email: 'beta@example.test',
        status: 'pending',
        source: 'manual',
      },
      {
        projectId: new Types.ObjectId(projectAId),
        ownerId: rep._id,
        name: 'Fictional Gym Replied',
        company: 'Gamma Fitness Ltd',
        email: 'gamma@example.test',
        status: 'contacted',
        outreachRepliedAt: new Date(),
        source: 'manual',
      },
    ]);

    const staleDate = new Date('2026-11-09T08:00:00.000Z');
    const [draftUnavail, draftPartial] = await DevelopmentLetter.create([
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: cUnavail._id,
        recipientName: cUnavail.name,
        recipientEmail: cUnavail.email!,
        subject: 'Outreach Alpha',
        content: '<p>Old draft alpha</p>',
        contentText: 'Old draft alpha',
        template: 'Old draft alpha',
        status: 'draft',
        channel: 'mock',
        outreachStep: 1,
        createdAt: staleDate,
        updatedAt: staleDate,
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'first_outreach',
          generatedAt: staleDate.toISOString(),
          status: 'ready',
          completeness: 'partial',
          sources: [],
          claims: [],
          questions: [],
          issues: [
            { code: 'semantic_unverified', message: '语义核验暂时失败' },
            { code: 'draft_unverified', message: '正文是模型原稿，逐项核验没有完成' },
          ],
          context: {},
          bodyHash: 'stale-hash-1',
          factAudit: {
            contract: 's4.1',
            mode: 'unavailable',
            attempts: 1,
            checks: [{ id: 's0', text: 'Old draft alpha', status: 'unverifiable', sourceIds: [], reason: 'unverified' }],
            facts: [],
          },
        },
      },
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: cPartial._id,
        recipientName: cPartial.name,
        recipientEmail: cPartial.email!,
        subject: 'Outreach Beta',
        content: '<p>Old draft beta</p>',
        contentText: 'Old draft beta',
        template: 'Old draft beta',
        status: 'draft',
        channel: 'mock',
        outreachStep: 1,
        createdAt: staleDate,
        updatedAt: staleDate,
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'first_outreach',
          generatedAt: staleDate.toISOString(),
          status: 'ready',
          completeness: 'partial',
          sources: [],
          claims: [],
          questions: [],
          issues: [{ code: 'semantic_partial', message: '部分核验' }],
          context: {},
          bodyHash: 'stale-hash-2',
          factAudit: {
            contract: 's4.1',
            mode: 'semantic',
            attempts: 2,
            checks: [{ id: 's0', text: 'Old draft beta', status: 'unverifiable', sourceIds: [], reason: 'missing evidence' }],
            facts: [],
          },
        },
      },
    ]);

    assert.equal(inspectOutreachDraftAudit(draftUnavail).needsReverify, true);
    assert.equal(inspectOutreachDraftAudit(draftPartial).needsReverify, true);

    await OutreachAutomationEnrollment.create([
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: cUnavail._id,
        status: 'paused',
        currentStep: 0,
        nextRunAt: staleDate,
        lastError: '自动发送已阻止：正文尚未完成核验',
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: cPartial._id,
        status: 'blocked',
        currentStep: 0,
        nextRunAt: staleDate,
        lastError: '模拟校验未完成：正文仍含缺少依据或冲突的内容',
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: cReplied._id,
        status: 'blocked',
        currentStep: 1,
        nextRunAt: staleDate,
        lastError: '客户已回复，自动开发已停止',
        taskIds: [],
      },
    ]);

    // 1. Admin inspecting rep overview sees exactly 2 unverified drafts
    const before = await getOutreachAutomationOverview(actorA, rep.id);
    assert.equal(before.stats.unverifiedDrafts, 2);
    assert.equal(before.queue.filter((r) => r.draftNeedsReverify).length, 2);

    // 2. Non-admin cannot reverify another user's drafts
    await assert.rejects(
      reverifyUnverifiedOutreachDrafts(repActor, {}, userAId),
      /只有管理员可以管理其他业务员/,
    );

    // 3. Admin batch-reverifies rep's unverified drafts while campaign stays PAUSED
    const res = await reverifyUnverifiedOutreachDrafts(actorA, {}, rep.id);
    assert.equal(res.queued, 2, `Expected 2 queued, skippedDetails=${JSON.stringify(res.skippedDetails)}`);
    assert.equal(res.taskIds.length, 2);
    assert.equal(res.overview.config.enabled, false, 'Formal sending must remain paused');

    // Old stale drafts archived as cancelled (never deleted)
    const old1 = await DevelopmentLetter.findById(draftUnavail._id).lean();
    const old2 = await DevelopmentLetter.findById(draftPartial._id).lean();
    assert.equal(old1?.status, 'cancelled');
    assert.equal(old2?.status, 'cancelled');

    // New tasks are created under rep's own userId with outreachStep: 1
    const newTasks = await AgentTask.find({ _id: { $in: res.taskIds } }).lean();
    assert.equal(newTasks.length, 2);
    for (const t of newTasks) {
      assert.equal(String(t.userId), rep.id);
      assert.equal(t.outreachStep, 1);
      assert.equal(t.status, 'queued');
    }

    // Replied/blocked customer was NOT touched
    const repliedRow = await OutreachAutomationEnrollment.findOne({ campaignId: campaign._id, customerId: cReplied._id }).lean();
    assert.equal(repliedRow?.status, 'blocked');
    assert.equal(repliedRow?.lastError, '客户已回复，自动开发已停止');

    // 4. Verify providerFactVerifier parses fenced JSON + zero offsets cleanly against live tenant DB
    const { providerFactVerifier } = await import('../src/services/agent/fact-verifier');
    const fenced = '```json\n{"checks":[{"id":"s0","status":"supported","quotes":[{"sourceId":"knowledge:free-weight:v1","quote":"IRONHUE manufactures free-weight equipment.","start":0,"end":0}],"reason":"exact"}]}\n```';
    const fakeProvider = {
      name: 'openai' as const,
      model: 'gpt-6.2-sol-fixture',
      isAvailable: () => true,
      async createTurn() { return { text: fenced, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }; },
    };
    const verifier = providerFactVerifier(fakeProvider as never, repActor);
    assert.ok(verifier);
    const checks = await verifier!.check({
      segments: [{ id: 's0', text: 'IRONHUE manufactures free-weight equipment.' }],
      evidence: [{ sourceId: 'knowledge:free-weight:v1', text: 'Catalog note: IRONHUE manufactures free-weight equipment.' }],
    });
    assert.equal(checks[0].status, 'supported');
    assert.equal(checks[0].quotes[0].start, 14);
  });
});

test('Section 9: outreach diagnostics, task stage separation, drain-queued-tasks, buyer timezone, and batched sentence check', async () => {
  const { OutreachAutomationEnrollment } = await import('../src/models');
  const { AgentTask } = await import('../src/models/AgentTask');
  const {
    drainQueuedOutreachTasks,
    getOutreachAutomationOverview,
    getOutreachEnrollmentDiagnostics,
  } = await import('../src/services/outreach-automation.service');
  const { verifyGroundedEmail } = await import('../src/services/agent/fact-verifier');

  // 1. Batched sentence refinement uses 1 single check call for multiple multi-sentence failed paragraphs (not N serial calls)
  let sentenceCheckCalls = 0;
  const mockBundle = {
    projectId: projectAId,
    status: 'ready' as const,
    sources: [{
      sourceId: 'knowledge:ironhue:v1',
      title: 'Ironhue Catalog',
      version: 1,
      kind: 'knowledge' as const,
      category: 'product' as const,
      content: 'IRONHUE builds calibrated plates and Olympic barbells.',
      source: 'fixture',
      applicability: '',
      products: [],
      validFrom: '2020-01-01',
      terms: [],
    }],
    topics: [],
    issues: [],
    facts: [],
  };
  const batchedVerifier = {
    model: 'batched-fixture',
    async check({ segments }: { segments: { id: string; text: string }[] }) {
      sentenceCheckCalls += 1;
      return segments.map((s) => ({
        id: s.id,
        status: 'unsupported' as const,
        quotes: [],
        reason: 'unsupported in fixture',
      }));
    },
  };
  await verifyGroundedEmail(
    'First bad claim. Second bad claim.\n\nThird bad claim. Fourth bad claim.',
    mockBundle,
    { taskType: 'first_outreach' },
    batchedVerifier,
  );
  // 1 paragraph-level check + 1 single batched sentence-level check = 2 total (previously 3+)
  assert.equal(sentenceCheckCalls, 2);

  // 2. Diagnostics, stage separation, buyer timezone, and draining queued backlog
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rep = await User.create({
      organizationId: orgA,
      username: 'fictional_ironhue_diag_rep',
      passwordHash: 'not-a-real-bcrypt-hash',
      displayName: 'Diag Rep',
      role: 'user',
      status: 'active',
      projectIds: [new Types.ObjectId(projectAId)],
    });
    const campaign = await OutreachAutomationConfig.create({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      actorRole: 'user',
      enabled: false,
      rolloutMode: 'active',
      dailyLimit: 20,
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
      useBuyerTimezone: true,
    });
    const swedenBuyer = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Nordic Gym Fixture',
      company: 'Nordic Fitness AB',
      country: 'Sweden',
      email: 'nordic@example.test',
      status: 'pending',
      source: 'manual',
    });
    const enrollment = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: swedenBuyer._id,
      status: 'active',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 5 * 60_000),
      taskIds: [],
    });

    const sessionId = new Types.ObjectId();
    // Create 1 failed task + 2 excess queued tasks + 1 running task
    await AgentTask.create([
      {
        projectId: new Types.ObjectId(projectAId),
        userId: rep._id,
        sessionId,
        actorRole: 'user',
        goal: 'Step 1',
        requestKey: 'diag-failed-1',
        customerId: swedenBuyer._id,
        kind: 'first_outreach',
        outreachStep: 1,
        status: 'failed',
        currentStep: 'analyze_customer',
        attempts: 1,
        error: { code: 'OPENAI_TIMEOUT', message: '模型响应超时', retryable: true },
        workflowActiveMs: 75200,
        workflowRecords: [{
          key: 'generate_email',
          epoch: 0,
          inputHash: 'h1',
          state: 'failed',
          startedAt: new Date().toISOString(),
          attempts: 1,
          reused: 0,
          durationMs: 75200,
          error: 'OPENAI_TIMEOUT',
        }],
        events: [{ at: new Date(), step: 'analyze_customer', message: '模型响应超时' }],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        userId: rep._id,
        sessionId,
        actorRole: 'user',
        goal: 'Step 1 queued backlog 1',
        requestKey: 'diag-queued-1',
        customerId: new Types.ObjectId(),
        kind: 'first_outreach',
        outreachStep: 1,
        status: 'queued',
      },
      {
        projectId: new Types.ObjectId(projectAId),
        userId: rep._id,
        sessionId,
        actorRole: 'user',
        goal: 'Step 1 queued backlog 2',
        requestKey: 'diag-queued-2',
        customerId: new Types.ObjectId(),
        kind: 'first_outreach',
        outreachStep: 1,
        status: 'queued',
      },
    ]);

    const overview = await getOutreachAutomationOverview(actorA, rep.id);
    assert.equal(overview.stats.queuedTasks, 2);
    assert.equal(overview.stats.failedTasks, 1);
    const row = overview.queue.find((q) => q.id === enrollment.id);
    assert.ok(row);
    assert.equal(row!.draftStage, 'task_failed');
    assert.equal(row!.taskErrorCode, 'OPENAI_TIMEOUT');
    assert.equal(row!.effectiveTimezone, 'Europe/Stockholm');
    assert.equal(row!.timezoneSource, 'country');

    const diag = await getOutreachEnrollmentDiagnostics(actorA, enrollment.id, rep.id);
    assert.equal(diag.timezone.effectiveTimezone, 'Europe/Stockholm');
    assert.equal(diag.timezone.source, 'country');
    assert.equal(diag.latestTask?.errorCode, 'OPENAI_TIMEOUT');
    assert.equal(diag.latestTask?.steps[0]?.error, 'OPENAI_TIMEOUT');
    assert.equal(diag.latestTask?.steps[0]?.durationMs, 75200);
    assert.equal(diag.latestDraft, null);

    const drained = await drainQueuedOutreachTasks(actorA, rep.id);
    assert.equal(drained.cancelled, 2);
    assert.equal(drained.overview.stats.queuedTasks, 0);
  });
});

test('P1-A/P1-B: circuit-breaker never burns customer retries, selective recovery skips SMTP/upstream failures, and diagnostics separate send-readiness states', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const {
    OutreachAutomationConfig,
    OutreachAutomationEnrollment,
  } = await import('../src/models/OutreachAutomation');
  const { AgentTask } = await import('../src/models/AgentTask');
  const {
    getOutreachAutomationOverview,
    getOutreachEnrollmentDiagnostics,
    recoverCircuitFailedEnrollments,
    tickOutreachAutomation,
  } = await import('../src/services/outreach-automation.service');
  const {
    guardedModelFetch,
    modelCircuitState,
    resetModelCircuitsForTest,
  } = await import('../src/services/agent/model-transport');
  const { draftHash } = await import('../src/services/agent/knowledge-grounding');

  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rep = await User.create({
      organizationId: orgA,
      username: 'fictional_p1_circuit_rep',
      passwordHash: 'not-a-real-bcrypt-hash',
      displayName: 'Circuit Rep',
      role: 'user',
      status: 'active',
      projectIds: [new Types.ObjectId(projectAId)],
    });
    const campaign = await OutreachAutomationConfig.create({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      actorRole: 'user',
      enabled: true,
      rolloutMode: 'shadow',
      dailyLimit: 20,
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
      useBuyerTimezone: true,
    });

    const [custCircuitActive, custCircuitFailed, custUpstreamFailed, custSmtpFailed, custBlocked] = await Customer.create([
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'Circuit Active Buyer', company: 'CA Co', country: 'United Kingdom', email: 'ca@example.test', status: 'pending', source: 'manual' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'Circuit Failed Buyer', company: 'CF Co', country: 'Germany', email: 'cf@example.test', status: 'pending', source: 'manual' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'Upstream Timeout Buyer', company: 'UT Co', country: 'France', email: 'ut@example.test', status: 'pending', source: 'manual' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'SMTP Failed Buyer', company: 'SF Co', country: 'Spain', email: 'sf@example.test', status: 'contacted', outreachStep: 1, letterCount: 1, source: 'manual' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'Replied Blocked Buyer', company: 'RB Co', country: 'Italy', email: 'rb@example.test', status: 'replied', outreachRepliedAt: new Date(), source: 'manual' },
    ]);

    const past = new Date(Date.now() - 120_000);
    const [enrCircuitActive, enrCircuitFailed, enrUpstreamFailed, enrSmtpFailed, enrBlocked] = await OutreachAutomationEnrollment.create([
      { projectId: new Types.ObjectId(projectAId), campaignId: campaign._id, userId: rep._id, customerId: custCircuitActive._id, status: 'active', currentStep: 0, nextRunAt: past, taskIds: [] },
      { projectId: new Types.ObjectId(projectAId), campaignId: campaign._id, userId: rep._id, customerId: custCircuitFailed._id, status: 'failed', currentStep: 0, nextRunAt: new Date(Date.now() + 86_400_000), lastError: 'AI 任务连续失败 3 次（AI 通道暂时熔断保护中），已停止自动重建', taskIds: [] },
      { projectId: new Types.ObjectId(projectAId), campaignId: campaign._id, userId: rep._id, customerId: custUpstreamFailed._id, status: 'failed', currentStep: 0, nextRunAt: new Date(Date.now() + 86_400_000), lastError: 'AI 任务连续失败 3 次（AI 请求超时），已停止自动重建', taskIds: [] },
      { projectId: new Types.ObjectId(projectAId), campaignId: campaign._id, userId: rep._id, customerId: custSmtpFailed._id, status: 'failed', currentStep: 1, nextRunAt: new Date(Date.now() + 86_400_000), lastError: '第 2 封状态异常：failed', taskIds: [] },
      { projectId: new Types.ObjectId(projectAId), campaignId: campaign._id, userId: rep._id, customerId: custBlocked._id, status: 'blocked', currentStep: 0, nextRunAt: past, lastError: '客户已回复，自动开发已停止', taskIds: [] },
    ]);

    // Historic SMTP failure letter on step 2
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custSmtpFailed._id,
      userId: rep._id,
      outreachStep: 2,
      subject: 'Step 2 SMTP fail fixture',
      content: '<p>Step 2</p>',
      contentText: 'Step 2',
      recipientEmail: 'sf@example.test',
      status: 'failed',
      error: 'SMTP 550',
    });

    const sessionId = new Types.ObjectId();
    // Seed 3 OPENAI_CIRCUIT_OPEN failures for custCircuitActive (older than 30s) — MUST NOT burn 3-retry cap!
    const oldFailAt = new Date(Date.now() - 90_000);
    await AgentTask.create([1, 2, 3].map((i) => ({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      sessionId,
      actorRole: 'user',
      goal: `Circuit fail ${i}`,
      requestKey: `p1-circuit-active-${i}`,
      customerId: custCircuitActive._id,
      kind: 'first_outreach',
      outreachStep: 1,
      status: 'failed',
      error: { code: 'OPENAI_CIRCUIT_OPEN', message: 'AI 通道暂时熔断保护中', retryable: true },
      updatedAt: oldFailAt,
    })));
    // Seed 3 OPENAI_CIRCUIT_OPEN failures for custCircuitFailed and 3 OPENAI_TIMEOUT for custUpstreamFailed
    await AgentTask.create([
      ...[1, 2, 3].map((i) => ({
        projectId: new Types.ObjectId(projectAId),
        userId: rep._id,
        sessionId,
        actorRole: 'user',
        goal: `CF ${i}`,
        requestKey: `p1-cf-${i}`,
        customerId: custCircuitFailed._id,
        kind: 'first_outreach',
        outreachStep: 1,
        status: 'failed',
        error: { code: 'OPENAI_CIRCUIT_OPEN', message: 'AI 通道暂时熔断保护中', retryable: true },
      })),
      ...[1, 2, 3].map((i) => ({
        projectId: new Types.ObjectId(projectAId),
        userId: rep._id,
        sessionId,
        actorRole: 'user',
        goal: `UT ${i}`,
        requestKey: `p1-ut-${i}`,
        customerId: custUpstreamFailed._id,
        kind: 'first_outreach',
        outreachStep: 1,
        status: 'failed',
        error: { code: 'OPENAI_TIMEOUT', message: 'AI 请求超时', retryable: true },
      })),
    ]);

    // 1. Trip real loopback 503 circuit -> verify tick creates ZERO new tasks and keeps enrollment active
    const failServer = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UPSTREAM_503' } }));
    });
    failServer.listen(0, '127.0.0.1');
    await once(failServer, 'listening');
    const port = (failServer.address() as import('node:net').AddressInfo).port;
    try {
      for (let i = 0; i < 3; i++) await guardedModelFetch(`http://127.0.0.1:${port}/v1/responses`, {});
      assert.equal(modelCircuitState().open, true);

      const tasksBefore = await AgentTask.countDocuments({ customerId: custCircuitActive._id });
      await tickOutreachAutomation(new Date());
      const tasksAfter = await AgentTask.countDocuments({ customerId: custCircuitActive._id });
      assert.equal(tasksAfter, tasksBefore, 'Must NOT spawn doomed AgentTasks while circuit is open');

      const reloadedActive = await OutreachAutomationEnrollment.findById(enrCircuitActive._id).lean();
      assert.equal(reloadedActive?.status, 'active', 'Circuit-open rejections must NEVER mark enrollment failed');
      assert.match(String(reloadedActive?.lastError ?? ''), /熔断冷却中/);

      const overviewWhileOpen = await getOutreachAutomationOverview(actorA, rep.id);
      assert.equal(overviewWhileOpen.circuit.open, true);
      assert.equal(overviewWhileOpen.stats.circuitFailed, 1);
    } finally {
      resetModelCircuitsForTest();
      failServer.closeAllConnections();
      await new Promise<void>((r) => failServer.close(() => r()));
    }

    // 2. Selective recovery recovers ONLY custCircuitFailed, leaving timeout/SMTP/blocked untouched
    const rec = await recoverCircuitFailedEnrollments(actorA, rep.id);
    assert.equal(rec.recovered, 1);
    assert.equal(rec.skipped, 2);
    assert.equal((await OutreachAutomationEnrollment.findById(enrCircuitFailed._id).lean())?.status, 'active');
    assert.equal((await OutreachAutomationEnrollment.findById(enrUpstreamFailed._id).lean())?.status, 'failed');
    assert.equal((await OutreachAutomationEnrollment.findById(enrSmtpFailed._id).lean())?.status, 'failed');
    assert.equal((await OutreachAutomationEnrollment.findById(enrBlocked._id).lean())?.status, 'blocked');
    const cancelledCircuitTasks = await AgentTask.countDocuments({ customerId: custCircuitFailed._id, status: 'cancelled' });
    assert.equal(cancelledCircuitTasks, 3);

    // 3. Diagnostics clearly separate: blocked_by_audit vs waiting_buyer_window vs blocked_by_send_gate vs ready_to_send
    const { AgentKnowledge } = await import('../src/models/AgentKnowledge');
    const kbContent = 'We manufacture rubber bumper plates for gym brands with strict weight checks and steady production runs. Our factory supports custom logo molding and steady repeat supply for commercial equipment buyers across Europe.';
    const kbDoc = await AgentKnowledge.create({
      projectId: new Types.ObjectId(projectAId),
      version: 1,
      approvedVersion: 1,
      revisions: [{
        version: 1,
        title: 'IRONHUE Product Fixture',
        category: 'product',
        content: kbContent,
        approved: true,
        validFrom: new Date(0),
        createdBy: rep._id,
        createdAt: new Date(),
      }],
    });
    const validBody = [
      'Dear CA Co team,',
      'Gym buyers often struggle with uneven plate bounce and slow restocks when scaling a commercial free-weight range.',
      'We manufacture rubber bumper plates for gym brands with strict weight checks and steady production runs. Our factory supports custom logo molding and steady repeat supply for commercial equipment buyers across Europe.',
      'Which bumper plate line would you like to look at first?',
    ].join('\n\n');
    const validKnowledgeSource = {
      sourceId: `knowledge:${String(kbDoc._id)}:v1`,
      knowledgeId: String(kbDoc._id),
      title: 'IRONHUE Product Fixture',
      version: 1,
      kind: 'knowledge' as const,
      category: 'product' as const,
      content: kbContent,
      source: 'fixture',
      applicability: '',
      products: ['bumper plates'],
      validFrom: new Date(0).toISOString(),
      terms: [],
    };
    const makePassingReview = (body: string) => ({
      version: 1 as const,
      projectId: projectAId,
      taskType: 'first_outreach',
      generatedAt: new Date().toISOString(),
      status: 'ready' as const,
      completeness: 'complete' as const,
      sources: [validKnowledgeSource],
      claims: [{ text: kbContent, sourceIds: [validKnowledgeSource.sourceId] }],
      questions: [],
      issues: [],
      context: {},
      bodyHash: draftHash(body),
      factAudit: {
        contract: 's4.1' as const,
        mode: 'semantic' as const,
        attempts: 1,
        facts: [],
        checks: [
          { id: 's0', text: 'Dear CA Co team,', status: 'non_claim' as const, sourceIds: [], reason: 'greeting' },
          { id: 's1', text: 'Gym buyers often struggle with uneven plate bounce and slow restocks when scaling a commercial free-weight range.', status: 'non_claim' as const, sourceIds: [], reason: 'category insight' },
          { id: 's2', text: kbContent, status: 'supported' as const, sourceIds: [validKnowledgeSource.sourceId], reason: 'exact' },
          { id: 's3', text: 'Which bumper plate line would you like to look at first?', status: 'non_claim' as const, sourceIds: [], reason: 'question' },
        ],
      },
    });

    // (a) Waiting for schedule / buyer window (audit passed + send gate passed + future nextRunAt)
    const draftWaiting = await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custCircuitActive._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Rubber bumper plates OEM supply',
      content: `<p>${validBody}</p>`,
      contentText: validBody,
      recipientEmail: 'ca@example.test',
      status: 'draft',
      needsReview: false,
      knowledgeReview: makePassingReview(validBody),
    });
    await OutreachAutomationEnrollment.updateOne(
      { _id: enrCircuitActive._id },
      { $set: { nextRunAt: new Date(Date.now() + 2 * 60 * 60_000), lastError: null } },
    );
    const diagWaiting = await getOutreachEnrollmentDiagnostics(actorA, enrCircuitActive.id, rep.id);
    assert.equal(diagWaiting.sendReadiness.auditPassed, true);
    assert.equal(diagWaiting.sendReadiness.sendGatePassed, true, JSON.stringify(diagWaiting.sendReadiness));
    assert.equal(diagWaiting.sendReadiness.status, 'waiting_buyer_window');

    // (b) Audit passed, BUT send gate failed (bodyHash tampered after verification)
    await DevelopmentLetter.updateOne(
      { _id: draftWaiting._id },
      { $set: { contentText: `${validBody}\n\nUnverified extra sentence.` } },
    );
    const diagGateBlocked = await getOutreachEnrollmentDiagnostics(actorA, enrCircuitActive.id, rep.id);
    assert.equal(diagGateBlocked.sendReadiness.auditPassed, true);
    assert.equal(diagGateBlocked.sendReadiness.sendGatePassed, false);
    assert.equal(diagGateBlocked.sendReadiness.status, 'blocked_by_send_gate');
    assert.equal(diagGateBlocked.sendReadiness.bodyHashValid, false);
    assert.ok(diagGateBlocked.sendReadiness.sendGateIssues.some((s) => s.includes('bodyHash')));

    // (c) Audit failed with layered failureCategory + failedChecks
    await DevelopmentLetter.updateOne(
      { _id: draftWaiting._id },
      {
        $set: {
          contentText: validBody,
          knowledgeReview: {
            ...makePassingReview(validBody),
            completeness: 'partial',
            issues: [
              { code: 'semantic_unverified', message: '生成稿经一次重写仍有无法支持的主张' },
              { code: 'draft_unverified', message: '正文已完成语义核验但仍存在未通过项' },
            ],
            factAudit: {
              contract: 's4.1',
              mode: 'semantic',
              attempts: 2,
              facts: [],
              failureCategory: 'unsupported_claims',
              failureCode: 'UNSUPPORTED_AFTER_REWRITE',
              failureStage: 'round1_check',
              failureDetail: '1 处正文主张缺少有效依据',
              checks: [
                { id: 's0', text: 'Dear CA Co team,', status: 'non_claim', sourceIds: [], reason: 'greeting' },
                { id: 's1', text: 'We offer lifetime warranty on all plates.', status: 'unsupported', sourceIds: [], reason: '知识库无终身质保依据' },
              ],
            },
          },
        },
      },
    );
    const diagAuditBlocked = await getOutreachEnrollmentDiagnostics(actorA, enrCircuitActive.id, rep.id);
    assert.equal(diagAuditBlocked.sendReadiness.auditPassed, false);
    assert.equal(diagAuditBlocked.sendReadiness.status, 'blocked_by_audit');
    assert.equal(diagAuditBlocked.latestDraft?.failureCategory, 'unsupported_claims');
    assert.equal(diagAuditBlocked.latestDraft?.failureStage, 'round1_check');
    assert.equal(diagAuditBlocked.latestDraft?.failedChecks.length, 1);
    assert.equal(diagAuditBlocked.latestDraft?.failedChecks[0]?.reason, '知识库无终身质保依据');

    // 4. Plan B: Project Approved Proof Blocks auto-extraction, save, and overview count
    const { getProjectProofBlocks, saveProjectProofBlocks } = await import('../src/services/outreach-automation.service');
    const initialProofs = await getProjectProofBlocks(actorA);
    assert.ok(initialProofs.suggested.length >= 2, 'Should auto-extract English proof blocks + default CTAs from published knowledge');
    assert.ok(initialProofs.suggested.some((b) => b.sourceKnowledgeId === String(kbDoc._id)));

    const savedProofs = await saveProjectProofBlocks(actorA, initialProofs.suggested.slice(0, 4));
    assert.equal(savedProofs.blocks.length, Math.min(4, initialProofs.suggested.length));
    const afterProofsOverview = await getOutreachAutomationOverview(actorA, rep.id);
    assert.equal(afterProofsOverview.stats.approvedProofBlocksCount, savedProofs.blocks.filter((b) => b.enabled).length);
    await assert.rejects(
      saveProjectProofBlocks(actorA, [{ id: 'bad', slot: 'proof', label: 'bad', text: 'Hi {{name}}, placeholder', enabled: true }]),
      /占位符/,
    );

    // 5. P1 Polish: Unverified draft NEVER reports draftReady=true or phase='ready' (no contradictory status);
    //    and includeUpstreamAiFailures recovers old-model timeout failures while STILL skipping SMTP & blocked rows!
    const overviewWithUnverified = await getOutreachAutomationOverview(actorA, rep.id);
    const caRow = overviewWithUnverified.queue.find((q) => q.id === enrCircuitActive.id);
    assert.ok(caRow);
    assert.equal(caRow!.draftStage, 'draft_audit_failed');
    assert.equal(caRow!.draftReady, false, 'Unverified draft must NEVER report draftReady=true');
    assert.notEqual(caRow!.phase, 'ready', 'Unverified draft must NEVER report phase=ready');
    assert.equal(overviewWithUnverified.stats.aiFailed, 1, 'Only timeout customer counts as aiFailed, not SMTP failure');

    const recAllAi = await recoverCircuitFailedEnrollments(actorA, rep.id, { includeUpstreamAiFailures: true });
    assert.equal(recAllAi.recovered, 1, 'Should recover the old-model timeout customer');
    assert.equal((await OutreachAutomationEnrollment.findById(enrUpstreamFailed._id).lean())?.status, 'active');
    assert.equal((await OutreachAutomationEnrollment.findById(enrSmtpFailed._id).lean())?.status, 'failed', 'Must NEVER touch historic SMTP failure');
    assert.equal((await OutreachAutomationEnrollment.findById(enrBlocked._id).lean())?.status, 'blocked', 'Must NEVER touch replied/blocked customer');

    // 6. Send-gate split stats, fix-send-gate (strip_offer / split_paragraphs / recheck),
    //    pausedReadyToResume stale error archival, delivery_failed & ruleStopped separation
    const {
      fixEnrollmentSendGate,
      reverifyUnverifiedOutreachDrafts,
    } = await import('../src/services/outreach-automation.service');

    // 6a) Paused row whose current draft already passes audit + send gate, but still has stale lastError
    const custPausedReady = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'REBEL Fixture',
      email: 'rebel@example.test',
      status: 'pending',
    });
    const enrPausedReady = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custPausedReady._id,
      status: 'paused',
      pauseOrigin: 'manual',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      lastError: '第 3 封字数超限（95/103 词）',
      taskIds: [],
    });
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custPausedReady._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Rubber bumper plates OEM supply',
      content: `<p>${validBody}</p>`,
      contentText: validBody,
      recipientEmail: 'rebel@example.test',
      status: 'draft',
      needsReview: false,
      knowledgeReview: makePassingReview(validBody),
    });

    // 6b) Send-gate blocked row: unauthorized sample offer
    const custOfferGate = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Offer Gate Co',
      email: 'offer-gate@example.test',
      status: 'pending',
    });
    const enrOfferGate = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custOfferGate._id,
      status: 'active',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      lastError: '寄样/色卡提议未获授权',
      taskIds: [],
    });
    const offerBody = [
      'Dear Offer Gate team,',
      'We manufacture rubber bumper plates for gym brands with strict weight checks and steady production runs. Our factory supports custom logo molding and steady repeat supply for commercial equipment buyers across Europe.',
      'We can send free samples to your team for evaluation.',
      'Which bumper plate line would you like to look at first?',
    ].join('\n\n');
    const offerReview = {
      ...makePassingReview(offerBody),
      factAudit: {
        contract: 's4.1' as const,
        mode: 'semantic' as const,
        attempts: 1,
        facts: [],
        checks: [
          { id: 's0', text: 'Dear Offer Gate team,', status: 'non_claim' as const, sourceIds: [], reason: 'greeting' },
          { id: 's1', text: kbContent, status: 'supported' as const, sourceIds: [validKnowledgeSource.sourceId], reason: 'exact' },
          { id: 's2', text: 'We can send free samples to your team for evaluation.', status: 'non_claim' as const, sourceIds: [], reason: 'offer' },
          { id: 's3', text: 'Which bumper plate line would you like to look at first?', status: 'non_claim' as const, sourceIds: [], reason: 'question' },
        ],
      },
    };
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custOfferGate._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Bumper plate inquiry',
      content: `<p>${offerBody.replace(/\n\n/g, '</p><p>')}</p>`,
      contentText: offerBody,
      recipientEmail: 'offer-gate@example.test',
      status: 'draft',
      needsReview: false,
      knowledgeReview: offerReview,
    });

    // 6c) Send-gate blocked row: single overly long paragraph (>68 words)
    const custLongPara = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Long Para Co',
      email: 'long-para@example.test',
      status: 'pending',
    });
    const enrLongPara = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custLongPara._id,
      status: 'active',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      taskIds: [],
    });
    const longSinglePara = `${kbContent} Our workshop also handles custom plate colors, weight stamping, and export pallet packing for regional fitness chains across multiple countries with reliable lead times. Which bumper plate line would you like to look at first?`;
    const longParaBody = `Dear Long Para team,\n\n${longSinglePara}`;
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custLongPara._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Custom bumper plates',
      content: `<p>${longParaBody.replace(/\n\n/g, '</p><p>')}</p>`,
      contentText: longParaBody,
      recipientEmail: 'long-para@example.test',
      status: 'draft',
      needsReview: false,
      knowledgeReview: {
        ...makePassingReview(longParaBody),
        factAudit: {
          contract: 's4.1',
          mode: 'semantic',
          attempts: 1,
          facts: [],
          checks: [
            { id: 's0', text: 'Dear Long Para team,', status: 'non_claim', sourceIds: [], reason: 'greeting' },
            { id: 's1', text: longSinglePara, status: 'supported', sourceIds: [validKnowledgeSource.sourceId], reason: 'exact' },
          ],
        },
      },
    });

    const splitOverview = await getOutreachAutomationOverview(actorA, rep.id);
    const rebelRow = splitOverview.queue.find((q) => q.id === enrPausedReady.id);
    assert.ok(rebelRow);
    assert.equal(rebelRow!.pausedReadyToResume, true);
    assert.equal(rebelRow!.lastError, undefined, 'Stale error should be cleared from active display');
    assert.ok(rebelRow!.errorHistory?.some((h) => h.message.includes('95/103') && h.resolvedAt), 'Stale error must move to errorHistory');
    assert.equal((await OutreachAutomationEnrollment.findById(enrPausedReady._id).lean())?.status, 'paused', 'Must NEVER auto-resume paused queue');

    const offerRow = splitOverview.queue.find((q) => q.id === enrOfferGate.id);
    assert.equal(offerRow?.sendGateDetail?.code, 'offer_unauthorized');
    assert.equal(offerRow?.sendGateDetail?.canStripOffer, true);

    const longParaRow = splitOverview.queue.find((q) => q.id === enrLongPara.id);
    assert.equal(longParaRow?.sendGateDetail?.code, 'paragraph_too_long');
    assert.equal(longParaRow?.sendGateDetail?.canSplitParagraphs, true);

    const smtpRow = splitOverview.queue.find((q) => q.id === enrSmtpFailed.id);
    assert.equal(smtpRow?.draftStage, 'delivery_failed');

    const blockedRow = splitOverview.queue.find((q) => q.id === enrBlocked.id);
    assert.equal(blockedRow?.isRuleStopped, true);

    assert.equal(splitOverview.stats.unverifiedDrafts, 1, 'Only CA Co is unverified');
    assert.equal(splitOverview.stats.rebuildableUnverifiedDrafts, 1);
    assert.ok(splitOverview.stats.sendGateBlockedDrafts >= 2);
    assert.equal(splitOverview.stats.pausedReadyCount, 1);
    assert.equal(splitOverview.stats.deliveryFailedCount, 1);
    assert.equal(splitOverview.stats.ruleStopped, 1);

    // Execute fixEnrollmentSendGate('strip_offer') and ('split_paragraphs')
    const stripRes = await fixEnrollmentSendGate(actorA, enrOfferGate.id, 'strip_offer', rep.id);
    assert.equal(stripRes.fixed, true, stripRes.summary);
    assert.ok(!stripRes.overview.queue.find((q) => q.id === enrOfferGate.id)?.sendGateDetail);

    const splitRes = await fixEnrollmentSendGate(actorA, enrLongPara.id, 'split_paragraphs', rep.id);
    assert.equal(splitRes.fixed, true, splitRes.summary);
    assert.ok(!splitRes.overview.queue.find((q) => q.id === enrLongPara.id)?.sendGateDetail);

    // Reverify only scans unverified drafts and reports skippedDetails / skippedReasons cleanly
    const reverifyRes = await reverifyUnverifiedOutreachDrafts(actorA, {}, rep.id);
    assert.equal(reverifyRes.scanned, 1);
    assert.equal(reverifyRes.queued, 1);
    assert.equal(reverifyRes.skipped, 0);
    assert.ok(Array.isArray(reverifyRes.skippedDetails));
    assert.ok(Array.isArray(reverifyRes.skippedReasons));
  });
});

test('Section 10: Grounding & Delivery Polish (Items 1-7: context gaps vs body audit, rebuild summary, cancelled delivery sync, Step-1 evidence, offer auth, auto paragraph split)', async () => {
  const { OutreachAutomationEnrollment } = await import('../src/models');
  const {
    getOutreachAutomationOverview,
    getOutreachEnrollmentDiagnostics,
    inspectOutreachDraftAudit,
    reverifyUnverifiedOutreachDrafts,
  } = await import('../src/services/outreach-automation.service');
  const {
    automatedReviewIssue,
    inspectBodyFactAudit,
  } = await import('../src/services/agent/knowledge-send-gate');
  const { selectStep1CapabilityEvidence } = await import('../src/services/agent/outreach-tiered-audit');
  const { buildOfferAuthorizationPromptRules } = await import('../src/services/agent/outreach-quality');
  const { verifyGroundedEmail } = await import('../src/services/agent/fact-verifier');
  const { draftHash } = await import('../src/services/agent/knowledge-grounding');
  const { AgentKnowledge } = await import('../src/models/AgentKnowledge');

  // --- Item 5 & 6 unit checks: Step-1 capability selector & offer authorization prompt rules ---
  const emptySelection = selectStep1CapabilityEvidence({
    bundle: {
      projectId: projectAId,
      status: 'ready',
      sources: [],
      issues: [],
      topics: [],
    },
    approvedProofBlocks: [],
    customerHintText: 'commercial bumper plates gym',
  });
  assert.equal(emptySelection.hasCapabilityEvidence, false);
  assert.ok(emptySelection.missingCategoryHint && emptySelection.missingCategoryHint.includes('公司简介'));

  const foundSelection = selectStep1CapabilityEvidence({
    bundle: {
      projectId: projectAId,
      status: 'ready',
      sources: [{
        sourceId: 'knowledge:cap1:v1',
        knowledgeId: 'cap1',
        title: 'Rubber Bumper Plate Manufacturing',
        version: 1,
        kind: 'knowledge',
        category: 'product',
        content: 'We manufacture commercial rubber bumper plates with strict weight checks and custom logo molding.',
        source: 'kb',
        applicability: 'gyms',
        products: ['bumper plates'],
        validFrom: new Date(0).toISOString(),
        terms: ['bumper', 'plates'] as never,
      }],
      issues: [],
      topics: [],
    },
    approvedProofBlocks: [],
    customerHintText: 'commercial bumper plates gym',
  });
  assert.equal(foundSelection.hasCapabilityEvidence, true);
  assert.equal(foundSelection.selectedSources[0]?.sourceId, 'knowledge:cap1:v1');

  // Default empty/non-sample approvedOffers: ordinary non-free sample inquiry is allowed,
  // while free/shipping commitments stay strictly blocked.
  assert.deepEqual(
    verifyOfferAuthorization('Would you like to arrange a sample for evaluation?', []),
    [],
    'Ordinary non-free sample/swatch inquiry must not be blocked when project has not disabled samples',
  );
  assert.ok(
    verifyOfferAuthorization('Happy to send a free sample with free shipping.', []).length > 0,
    'Free sample / free shipping must still stay strictly blocked',
  );
  const explicitDisableSample = [{
    id: 'sample-off',
    label: 'Sample disabled',
    actionText: 'Sample',
    category: 'sample' as const,
    requiresEvidence: false,
    allowsFree: false,
    allowsSample: true,
    allowsShipping: false,
    enabled: false,
  }];
  assert.ok(
    verifyOfferAuthorization('Would you like to arrange a sample?', explicitDisableSample).length > 0,
    'Explicitly disabled sample offer must stay blocked',
  );

  const defaultRules = buildOfferAuthorizationPromptRules([
    {
      id: 'spec',
      label: 'Spec sheet',
      actionText: 'Share a 1-page spec sheet',
      category: 'spec_sheet',
      requiresEvidence: false,
      allowsFree: false,
      allowsSample: false,
      allowsShipping: false,
      enabled: true,
    },
  ]);
  assert.equal(defaultRules.sampleAllowed, true);
  assert.equal(defaultRules.freeAllowed, false);
  assert.equal(defaultRules.shippingAllowed, false);
  const defaultJoined = defaultRules.lines.join('\n');
  assert.ok(defaultJoined.includes('免费承诺'));
  assert.ok(defaultJoined.includes('运费/快递/贸易术语承诺'));

  const disabledSampleRules = buildOfferAuthorizationPromptRules(explicitDisableSample);
  assert.equal(disabledSampleRules.sampleAllowed, false);
  assert.ok(disabledSampleRules.lines.join('\n').includes('寄样/色卡/打样'));

  // --- Item 1 & 7 unit check: verifyGroundedEmail auto-splits 91-word paragraph & returns complete when only background missing gap exists ---
  const capText = 'We manufacture rubber bumper plates for gym brands with strict weight checks and steady production runs. Our factory supports custom logo molding and steady repeat supply for commercial equipment buyers across Europe.';
  const longOneBlock = [
    'Hi Alex,',
    '',
    `${capText} Our workshop also supports custom color coding, embossed weight markings, and export pallet packing for commercial fitness distributors scaling regional restocks without altering your existing rack dimensions. Which plate specification would you like to review first?`,
  ].join('\n');
  const sourceContent = `${capText} Our workshop also supports custom color coding, embossed weight markings, and export pallet packing for commercial fitness distributors scaling regional restocks without altering your existing rack dimensions.`;
  const verifiedSplit = await verifyGroundedEmail(
    longOneBlock,
    {
      projectId: projectAId,
      status: 'ready',
      sources: [{
        sourceId: 'knowledge:split1:v1',
        knowledgeId: 'split1',
        title: 'Bumper Plate Capabilities',
        version: 1,
        kind: 'knowledge',
        category: 'product',
        content: sourceContent,
        source: 'kb',
        applicability: '',
        products: ['bumper plates'],
        validFrom: new Date(0).toISOString(),
        terms: [],
      }],
      facts: [],
      issues: [{ code: 'missing', message: '未找到适用报价单（本次正文未涉及报价）' }],
      topics: [],
    },
    {
      projectId: projectAId,
      taskType: 'first_outreach',
      outreachStep: 1,
      recipientName: 'Alex Buyer',
    },
    {
      model: 'test-verifier',
      check: async ({ segments }) => segments.map((seg) => {
        const trimmed = seg.text.trim();
        if (/^Hi\b|\?$/.test(trimmed)) {
          return { id: seg.id, status: 'non_claim' as const, quotes: [], reason: 'greeting_or_question' };
        }
        const idx = sourceContent.indexOf(trimmed);
        const start = idx >= 0 ? idx : 0;
        const quote = idx >= 0 ? trimmed : sourceContent.slice(0, Math.min(40, sourceContent.length));
        return {
          id: seg.id,
          status: 'supported' as const,
          quotes: [{ sourceId: 'knowledge:split1:v1', quote, start, end: start + quote.length }],
          reason: 'verified',
        };
      }),
      rewrite: async () => longOneBlock,
    },
  );
  const splitParagraphs = verifiedSplit.bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  assert.ok(splitParagraphs.length >= 3, `Expected auto-split into >= 3 paragraphs, got ${splitParagraphs.length}`);
  assert.equal(verifiedSplit.review.completeness, 'complete', 'All checks passed + only background missing gap -> completeness must be complete');
  assert.equal(inspectBodyFactAudit(verifiedSplit.review).passed, true);
  assert.equal(inspectBodyFactAudit(verifiedSplit.review).contextWarnings.length, 1);

  // --- Integration tests for Items 1, 2, 3 in OutreachAutomation ---
  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rep = await User.create({
      organizationId: orgA,
      username: 'fictional_polish_rep',
      passwordHash: 'not-a-real-bcrypt-hash',
      displayName: 'Polish Rep',
      role: 'user',
      status: 'active',
      projectIds: [new Types.ObjectId(projectAId)],
    });
    const campaign = await OutreachAutomationConfig.create({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      actorRole: 'user',
      enabled: false,
      pausedReason: '核验排查中',
      rolloutMode: 'active',
      dailyLimit: 20,
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
    });
    const kbDoc = await AgentKnowledge.create({
      projectId: new Types.ObjectId(projectAId),
      version: 1,
      approvedVersion: 1,
      revisions: [{
        version: 1,
        title: 'IRONHUE Bumper Capability',
        category: 'product',
        content: capText,
        approved: true,
        validFrom: new Date(0),
        createdBy: rep._id,
        createdAt: new Date(),
      }],
    });
    const kbSource = {
      sourceId: `knowledge:${String(kbDoc._id)}:v1`,
      knowledgeId: String(kbDoc._id),
      title: 'IRONHUE Bumper Capability',
      version: 1,
      kind: 'knowledge' as const,
      category: 'product' as const,
      content: capText,
      source: 'fixture',
      applicability: '',
      products: ['bumper plates'],
      validFrom: new Date(0).toISOString(),
      terms: [],
    };
    const cleanBody = [
      'Hi Sam,',
      '',
      capText,
      '',
      'Which bumper plate line would you like to review first?',
    ].join('\n');

    // Customer 1: Legacy partial completeness with ONLY background customer_research_gap (all checks passed!)
    const custGapOnly = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Apollo Gym Fixture',
      email: 'apollo@example.test',
      status: 'pending',
    });
    const enrGapOnly = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custGapOnly._id,
      status: 'paused',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      lastError: '正文仅为部分核验（partial），未达自动发送要求',
      taskIds: [],
    });
    const gapOnlyReview = {
      version: 1 as const,
      projectId: projectAId,
      taskType: 'first_outreach',
      generatedAt: new Date().toISOString(),
      status: 'ready' as const,
      completeness: 'partial' as const,
      sources: [kbSource],
      claims: [{ text: capText, sourceIds: [kbSource.sourceId] }],
      questions: [],
      issues: [{ code: 'customer_research_gap', message: '客户官网未能完整读取，正文未编造官网内容' }],
      context: {},
      bodyHash: draftHash(cleanBody),
      factAudit: {
        contract: 's4.1' as const,
        mode: 'semantic' as const,
        attempts: 1,
        facts: [],
        checks: [
          { id: 's0', text: 'Hi Sam,', status: 'non_claim' as const, sourceIds: [], reason: 'greeting' },
          { id: 's1', text: capText, status: 'supported' as const, sourceIds: [kbSource.sourceId], reason: 'exact' },
          { id: 's2', text: 'Which bumper plate line would you like to review first?', status: 'non_claim' as const, sourceIds: [], reason: 'question' },
        ],
      },
    };
    const draftGapOnly = await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custGapOnly._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Commercial bumper plates',
      content: `<p>${cleanBody.replace(/\n\n/g, '</p><p>')}</p>`,
      contentText: cleanBody,
      recipientEmail: 'apollo@example.test',
      status: 'draft',
      needsReview: false,
      knowledgeReview: gapOnlyReview,
    });
    assert.equal(inspectOutreachDraftAudit(draftGapOnly).needsReverify, false);
    assert.equal(inspectOutreachDraftAudit(draftGapOnly).contextWarnings.length, 1);
    assert.equal(automatedReviewIssue(gapOnlyReview, 1, { bodyText: cleanBody, subject: 'Commercial bumper plates' }), undefined);

    // Customer 2: Real body audit failure (unsupported price claim) -> MUST still block both audit & send gate
    const custBadPrice = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Price Claim Fixture',
      email: 'price-claim@example.test',
      status: 'pending',
    });
    const enrBadPrice = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custBadPrice._id,
      status: 'paused',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      taskIds: [],
    });
    const badPriceBody = 'Hi Sam,\n\nWe can offer USD 1.20/kg with 7-day express delivery.\n\nInterested?';
    const badPriceReview = {
      version: 1 as const,
      projectId: projectAId,
      taskType: 'first_outreach',
      generatedAt: new Date().toISOString(),
      status: 'ready' as const,
      completeness: 'partial' as const,
      sources: [kbSource],
      claims: [],
      questions: [],
      issues: [
        { code: 'missing', message: '未找到报价单' },
        { code: 'semantic_unverified', message: '正文存在无依据价格承诺' },
      ],
      context: {},
      bodyHash: draftHash(badPriceBody),
      factAudit: {
        contract: 's4.1' as const,
        mode: 'semantic' as const,
        attempts: 2,
        facts: [],
        checks: [
          { id: 's0', text: 'We can offer USD 1.20/kg with 7-day express delivery.', status: 'unsupported' as const, sourceIds: [], reason: '无报价依据' },
        ],
      },
    };
    const draftBadPrice = await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custBadPrice._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Pricing offer',
      content: `<p>${badPriceBody}</p>`,
      contentText: badPriceBody,
      recipientEmail: 'price-claim@example.test',
      status: 'draft',
      needsReview: true,
      knowledgeReview: badPriceReview,
    });
    assert.equal(inspectOutreachDraftAudit(draftBadPrice).needsReverify, true);
    assert.ok(automatedReviewIssue(badPriceReview, 1, { bodyText: badPriceBody, subject: 'Pricing offer' }));

    // Customer 3: Delta Fitness scenario — Step 3 cancelled with stale "发送任务已保存，可在邮件中心查看进度"
    const custDelta = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Delta Fitness Fixture',
      email: 'delta@example.test',
      status: 'contacted',
      outreachStep: 2,
      letterCount: 2,
    });
    const enrDelta = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custDelta._id,
      status: 'paused',
      currentStep: 2,
      nextRunAt: new Date(Date.now() + 60_000),
      lastError: '发送任务已保存，可在邮件中心查看进度',
      taskIds: [],
    });
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custDelta._id,
      userId: rep._id,
      outreachStep: 3,
      subject: 'Closing the loop',
      content: '<p>Closing the loop.</p>',
      contentText: 'Closing the loop.',
      recipientEmail: 'delta@example.test',
      status: 'cancelled',
      error: '已在邮件中心手动取消发送',
    });

    // Customer 4: Queued delivery letter -> waiting_delivery
    const custQueued = await Customer.create({
      projectId: new Types.ObjectId(projectAId),
      ownerId: rep._id,
      name: 'Queued Delivery Fixture',
      email: 'queued@example.test',
      status: 'pending',
    });
    const enrQueued = await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(projectAId),
      campaignId: campaign._id,
      userId: rep._id,
      customerId: custQueued._id,
      status: 'active',
      currentStep: 0,
      nextRunAt: new Date(Date.now() + 60_000),
      taskIds: [],
    });
    await DevelopmentLetter.create({
      projectId: new Types.ObjectId(projectAId),
      customerId: custQueued._id,
      userId: rep._id,
      outreachStep: 1,
      subject: 'Queued outreach',
      content: '<p>Queued outreach.</p>',
      contentText: 'Queued outreach.',
      recipientEmail: 'queued@example.test',
      status: 'queued',
    });

    const ov = await getOutreachAutomationOverview(actorA, rep.id);
    // Item 1 assertions
    const gapRow = ov.queue.find((q) => q.id === enrGapOnly.id);
    assert.ok(gapRow);
    assert.equal(gapRow!.draftStage, 'draft_saved_verified', 'Context-gap-only draft must be verified, NOT red');
    assert.equal(gapRow!.draftReady, true);
    assert.equal(gapRow!.pausedReadyToResume, true, 'Paused queue must stay paused with待手动恢复');
    assert.equal(gapRow!.contextWarnings?.length, 1);
    assert.equal(ov.stats.contextWarningDrafts, 1);
    assert.equal(ov.stats.unverifiedDrafts, 1, 'Only Price Claim draft is unverified');
    assert.equal(ov.stats.rebuildableUnverifiedDrafts, 1, 'Context-gap-only draft must NOT be counted as rebuildable');

    // Item 3 assertions (Delta Fitness cancelled & queued waiting_delivery)
    const deltaRow = ov.queue.find((q) => q.id === enrDelta.id);
    assert.ok(deltaRow);
    assert.equal(deltaRow!.draftStage, 'delivery_cancelled');
    assert.equal(deltaRow!.deliveryStatus, 'cancelled');
    assert.ok(deltaRow!.cancelledReason?.includes('手动取消'));
    assert.ok(!deltaRow!.lastError?.includes('发送任务已保存'), 'Must NOT keep stale waiting-to-send text');
    assert.ok(deltaRow!.errorHistory?.some((h) => h.message === '发送任务已保存，可在邮件中心查看进度' && h.resolvedAt));
    assert.equal(ov.stats.deliveryCancelledCount, 1);

    const deltaDiag = await getOutreachEnrollmentDiagnostics(actorA, enrDelta.id, rep.id);
    assert.equal(deltaDiag.sendReadiness.status, 'delivery_cancelled');

    const queuedRow = ov.queue.find((q) => q.id === enrQueued.id);
    assert.equal(queuedRow?.draftStage, 'waiting_delivery');
    assert.equal(queuedRow?.deliveryStatus, 'waiting_delivery');
    const queuedDiag = await getOutreachEnrollmentDiagnostics(actorA, enrQueued.id, rep.id);
    assert.equal(queuedDiag.sendReadiness.status, 'waiting_delivery');

    const gapDiag = await getOutreachEnrollmentDiagnostics(actorA, enrGapOnly.id, rep.id);
    assert.equal(gapDiag.sendReadiness.status, 'paused_ready_to_resume');
    assert.equal(gapDiag.latestDraft?.contextWarnings?.length, 1);

    // Item 2 assertions: batch rebuild skips context-gap-only draft and reports remaining + pausedReadyCount
    const reverifyOut = await reverifyUnverifiedOutreachDrafts(
      actorA,
      { enrollmentIds: [enrGapOnly.id, enrBadPrice.id] },
      rep.id,
    );
    assert.equal(reverifyOut.scanned, 2);
    assert.equal(reverifyOut.queued, 1);
    assert.equal(reverifyOut.skipped, 1);
    assert.ok(reverifyOut.skippedDetails[0]?.reason.includes('背景资料缺口提醒'));
    assert.equal(reverifyOut.pausedReadyCount, 1);
    assert.equal(typeof reverifyOut.remainingUnverified, 'number');
    assert.equal(typeof reverifyOut.remainingSendGateBlocked, 'number');
    assert.ok(Array.isArray(reverifyOut.remainingDetails));
    assert.equal((await OutreachAutomationEnrollment.findById(enrGapOnly._id).lean())?.status, 'paused', 'Never auto-resume paused queue');

    // --- Section 11: send_gate_blocked stage split, Step-1 self-heal proof block injection, and batch autoFixOutreachSendGates ---
    const { autoFixOutreachSendGates } = await import('../src/services/outreach-automation.service');

    // Step-1 self-healing: draft missing a knowledge claim automatically injects enabled approvedProofBlock in 0 LLM calls
    const step1SelfHeal = await verifyGroundedEmail(
      'Hi Jordan,\n\nCommercial gym teams often look for consistent plate durability across high-traffic zones.\n\nWhich plate line are you reviewing next?',
      {
        projectId: projectAId,
        status: 'ready',
        sources: [kbSource],
        facts: [],
        issues: [],
        topics: [],
      },
      {
        projectId: projectAId,
        taskType: 'first_outreach',
        outreachStep: 1,
        recipientName: 'Jordan',
        approvedProofBlocks: [{
          id: 'auto_cap_1',
          slot: 'proof',
          label: 'Factory capability',
          text: capText,
          sourceKnowledgeId: String(kbDoc._id),
          enabled: true,
        }],
      },
      {
        model: 'test-verifier',
        check: async ({ segments }) => segments.map((seg) => ({
          id: seg.id,
          status: 'non_claim' as const,
          quotes: [],
          reason: 'general',
        })),
        rewrite: async () => '',
      },
    );
    assert.ok(step1SelfHeal.bodyText.includes(capText), 'Step-1 self-heal must inject approved proof block');
    assert.equal(
      automatedReviewIssue(step1SelfHeal.review, 1, { bodyText: step1SelfHeal.bodyText, subject: 'Commercial plates' }),
      undefined,
      'Self-healed Step-1 draft must pass Step-1 supplier evidence send gate',
    );

    // Create two send_gate_blocked rows (1 paragraph_too_long + 1 missing_supplier_evidence) and verify stage split + batch autoFixOutreachSendGates
    const [custAutoSplit, custAutoStep1] = await Customer.create([
      {
        projectId: new Types.ObjectId(projectAId),
        ownerId: rep._id,
        name: 'AutoSplit Fitness',
        email: 'autosplit@example.test',
        status: 'pending',
      },
      {
        projectId: new Types.ObjectId(projectAId),
        ownerId: rep._id,
        name: 'AutoStep1 Fitness',
        email: 'autostep1@example.test',
        status: 'pending',
      },
    ]);
    const [enrAutoSplit, enrAutoStep1] = await OutreachAutomationEnrollment.create([
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custAutoSplit._id,
        status: 'paused',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custAutoStep1._id,
        status: 'paused',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
    ]);
    const longSingleBlock = `${capText} Our production team also supports custom embossed weight logos, protective export palletizing, and repeatable color matching for multi-site commercial gym expansions across regional markets. Which plate line would you like to review first?`;
    const longBodyText = `Hi AutoSplit team,\n\n${longSingleBlock}`;
    await DevelopmentLetter.create([
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: custAutoSplit._id,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Bumper plate supply',
        content: `<p>${longBodyText.replace(/\n\n/g, '</p><p>')}</p>`,
        contentText: longBodyText,
        recipientEmail: 'autosplit@example.test',
        status: 'draft',
        needsReview: false,
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'first_outreach',
          generatedAt: new Date().toISOString(),
          status: 'ready',
          completeness: 'complete',
          sources: [kbSource],
          claims: [{ text: longSingleBlock, sourceIds: [kbSource.sourceId] }],
          questions: [],
          issues: [],
          context: {},
          bodyHash: draftHash(longBodyText),
          factAudit: {
            contract: 's4.1',
            mode: 'semantic',
            attempts: 1,
            facts: [],
            checks: [
              { id: 's0', text: 'Hi AutoSplit team,', status: 'non_claim', sourceIds: [], reason: 'greeting' },
              { id: 's1', text: longSingleBlock, status: 'supported', sourceIds: [kbSource.sourceId], reason: 'supported' },
            ],
          },
        },
      },
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: custAutoStep1._id,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Quick hello',
        content: '<p>Hi AutoStep1 team,</p><p>Which free-weight product line are you focusing on this quarter?</p>',
        contentText: 'Hi AutoStep1 team,\n\nWhich free-weight product line are you focusing on this quarter?',
        recipientEmail: 'autostep1@example.test',
        status: 'draft',
        needsReview: false,
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'first_outreach',
          generatedAt: new Date().toISOString(),
          status: 'ready',
          completeness: 'complete',
          sources: [kbSource],
          claims: [],
          questions: [],
          issues: [],
          context: {},
          bodyHash: draftHash('Hi AutoStep1 team,\n\nWhich free-weight product line are you focusing on this quarter?'),
          factAudit: {
            contract: 's4.1',
            mode: 'semantic',
            attempts: 1,
            facts: [],
            checks: [
              { id: 's0', text: 'Hi AutoStep1 team,', status: 'non_claim', sourceIds: [], reason: 'greeting' },
              { id: 's1', text: 'Which free-weight product line are you focusing on this quarter?', status: 'non_claim', sourceIds: [], reason: 'question' },
            ],
          },
        },
      },
    ]);

    const preFixOv = await getOutreachAutomationOverview(actorA, rep.id);
    const splitPreRow = preFixOv.queue.find((q) => q.id === enrAutoSplit.id);
    const step1PreRow = preFixOv.queue.find((q) => q.id === enrAutoStep1.id);
    assert.equal(splitPreRow?.draftStage, 'send_gate_blocked', 'Send-gate rows must NOT use draft_audit_failed');
    assert.equal(step1PreRow?.draftStage, 'send_gate_blocked', 'Missing capability rows must use send_gate_blocked');

    const autoFixRes = await autoFixOutreachSendGates(actorA, rep.id);
    assert.equal(autoFixRes.scanned, 2);
    assert.equal(autoFixRes.fixed, 1, 'Paragraph sprawl draft should be fixed in-place');
    assert.equal(autoFixRes.requeued, 1, 'Missing Step-1 evidence draft should be requeued when project has published knowledge');
    assert.equal(autoFixRes.skipped, 0);
    assert.equal(
      autoFixRes.overview.queue.find((q) => q.id === enrAutoSplit.id)?.draftStage,
      'draft_saved_verified',
    );
    assert.equal(
      (await OutreachAutomationEnrollment.findById(enrAutoSplit._id).lean())?.status,
      'paused',
      'Batch auto-fix must NEVER auto-resume paused queue',
    );
  });
});

test('Section 12: safe auto-resume of system pauses, cancelOrigin recovery, uncertain delivery gating, and flaggedExcerpts', async () => {
  const { OutreachAutomationEnrollment } = await import('../src/models');
  const { AgentKnowledge } = await import('../src/models/AgentKnowledge');
  const { AgentTask } = await import('../src/models/AgentTask');
  const { draftHash } = await import('../src/services/agent/knowledge-grounding');
  const {
    getOutreachAutomationOverview,
    getOutreachEnrollmentDiagnostics,
    reconcileOutreachCampaign,
  } = await import('../src/services/outreach-automation.service');

  await runWithTenant({ organizationId: String(orgA) }, async () => {
    const rep = await User.create({
      organizationId: orgA,
      username: 'fictional_sales_reconcile_rep',
      passwordHash: 'not-a-real-bcrypt-hash',
      displayName: 'Reconcile Rep',
      role: 'user',
      status: 'active',
      projectIds: [new Types.ObjectId(projectAId)],
    });
    const campaign = await OutreachAutomationConfig.create({
      projectId: new Types.ObjectId(projectAId),
      userId: rep._id,
      actorRole: 'user',
      enabled: true,
      rolloutMode: 'active',
      dailyLimit: 20,
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
      useBuyerTimezone: true,
    });

    const capText = 'IRONHUE produces commercial Olympic barbells and bumper plates with ISO9001 quality control.';
    const kbDoc = await AgentKnowledge.create({
      projectId: new Types.ObjectId(projectAId),
      version: 1,
      approvedVersion: 1,
      revisions: [{
        version: 1,
        title: 'IRONHUE Reconcile Capability',
        category: 'company',
        content: capText,
        approved: true,
        validFrom: new Date(0),
        createdBy: rep._id,
        createdAt: new Date(),
      }],
    });
    const kbSource = {
      sourceId: `knowledge:${String(kbDoc._id)}:v1`,
      knowledgeId: String(kbDoc._id),
      kind: 'knowledge' as const,
      title: 'IRONHUE Reconcile Capability',
      category: 'company' as const,
      version: 1,
      content: capText,
      source: 'fixture',
      applicability: '',
      products: ['Olympic barbells', 'bumper plates'],
      validFrom: new Date(0).toISOString(),
      terms: [],
    };

    const makeVerifiedDraft = (customerId: Types.ObjectId, recipientEmail: string, bodyText?: string, extra?: Record<string, unknown>) => {
      const text = bodyText ?? `Hi team,\n\n${capText}\n\nWhich product line are you reviewing this quarter?`;
      return {
        projectId: new Types.ObjectId(projectAId),
        customerId,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Commercial gym equipment inquiry',
        aiSnapshot: { subject: 'Commercial gym equipment inquiry', contentText: text, at: new Date() },
        content: `<p>${text.replace(/\n\n/g, '</p><p>')}</p>`,
        contentText: text,
        recipientEmail,
        status: 'draft' as const,
        needsReview: false,
        knowledgeReview: {
          version: 1,
          projectId: projectAId,
          taskType: 'first_outreach' as const,
          generatedAt: new Date().toISOString(),
          status: 'ready' as const,
          completeness: 'complete' as const,
          sources: [kbSource],
          claims: [{ text: capText, sourceIds: [kbSource.sourceId] }],
          questions: [],
          issues: [],
          context: {},
          bodyHash: draftHash(text),
          factAudit: {
            contract: 's4.1' as const,
            mode: 'semantic' as const,
            attempts: 1,
            facts: [],
            checks: [
              { id: 's0', text: 'Hi team,', status: 'non_claim' as const, sourceIds: [], reason: 'greeting' },
              { id: 's1', text: capText, status: 'supported' as const, sourceIds: [kbSource.sourceId], reason: 'supported' },
              { id: 's2', text: 'Which product line are you reviewing this quarter?', status: 'non_claim' as const, sourceIds: [], reason: 'question' },
            ],
          },
        },
        ...extra,
      };
    };

    const [
      custSysPaused,
      custLegacySysPaused,
      custManualPaused,
      custUnknownPaused,
      custRepliedSysPaused,
      custTransientCancelled,
      custManualCancelled,
      custUncertain,
      custOfferHighlight,
    ] = await Customer.create([
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'SysPaused Gym', country: 'United States', email: 'syspaused@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'LegacySys Gym', country: 'United States', email: 'legacysys@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'ManualPaused Gym', country: 'United States', email: 'manualpaused@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'UnknownPaused Gym', country: 'United States', email: 'unknownpaused@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'RepliedSys Gym', country: 'United States', email: 'repliedsys@example.test', status: 'replied' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'TransientCancel Gym', country: 'United States', email: 'transientcancel@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'ManualCancel Gym', country: 'United States', email: 'manualcancel@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'Uncertain Gym', country: 'United States', email: 'uncertain@example.test', status: 'pending' },
      { projectId: new Types.ObjectId(projectAId), ownerId: rep._id, name: 'OfferHighlight Gym', country: 'United States', email: 'offerhighlight@example.test', status: 'pending' },
    ]);

    const [
      enrSysPaused,
      enrLegacySysPaused,
      enrManualPaused,
      enrUnknownPaused,
      enrRepliedSysPaused,
      enrTransientCancelled,
      enrManualCancelled,
      enrUncertain,
      enrOfferHighlight,
    ] = await OutreachAutomationEnrollment.create([
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custSysPaused._id,
        status: 'paused',
        pauseOrigin: 'system',
        pausedAt: new Date(Date.now() - 3600_000),
        pausedReason: '自动发送已阻止：首封缺少已发布我方能力依据',
        lastError: '自动发送已阻止：首封缺少已发布我方能力依据',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custLegacySysPaused._id,
        status: 'paused',
        lastError: '自动发送已阻止：单段过长',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custManualPaused._id,
        status: 'paused',
        pauseOrigin: 'manual',
        pausedAt: new Date(Date.now() - 3600_000),
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custUnknownPaused._id,
        status: 'paused',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custRepliedSysPaused._id,
        status: 'paused',
        pauseOrigin: 'system',
        lastError: '自动发送已阻止：草稿待核验',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custTransientCancelled._id,
        status: 'active',
        currentStep: 0,
        nextRunAt: new Date(Date.now() - 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custManualCancelled._id,
        status: 'active',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custUncertain._id,
        status: 'active',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
      {
        projectId: new Types.ObjectId(projectAId),
        campaignId: campaign._id,
        userId: rep._id,
        customerId: custOfferHighlight._id,
        status: 'paused',
        pauseOrigin: 'system',
        currentStep: 0,
        nextRunAt: new Date(Date.now() + 60_000),
        taskIds: [],
      },
    ]);

    const offerSentence = 'We can ship a free sample kit to your warehouse next week.';
    const offerBody = `Hi team,\n\n${capText} ${offerSentence}\n\nWhich product line are you reviewing?`;

    await DevelopmentLetter.create([
      makeVerifiedDraft(custSysPaused._id, 'syspaused@example.test'),
      makeVerifiedDraft(custLegacySysPaused._id, 'legacysys@example.test'),
      makeVerifiedDraft(custManualPaused._id, 'manualpaused@example.test'),
      makeVerifiedDraft(custUnknownPaused._id, 'unknownpaused@example.test'),
      makeVerifiedDraft(custRepliedSysPaused._id, 'repliedsys@example.test'),
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: custTransientCancelled._id,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Transient cancelled draft',
        content: '<p>Old cancelled content</p>',
        contentText: 'Old cancelled content',
        recipientEmail: 'transientcancel@example.test',
        status: 'cancelled',
        cancelOrigin: 'system_transient',
        error: '系统临时中断，邮件未发出',
        needsReview: false,
      },
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: custManualCancelled._id,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Manual cancelled draft',
        content: '<p>Manually cancelled content</p>',
        contentText: 'Manually cancelled content',
        recipientEmail: 'manualcancel@example.test',
        status: 'cancelled',
        cancelOrigin: 'manual',
        error: '已手动取消，未发送',
        needsReview: false,
      },
      {
        projectId: new Types.ObjectId(projectAId),
        customerId: custUncertain._id,
        userId: rep._id,
        outreachStep: 1,
        subject: 'Uncertain delivery draft',
        content: '<p>Uncertain content</p>',
        contentText: 'Uncertain content',
        recipientEmail: 'uncertain@example.test',
        status: 'failed',
        needsReview: true,
        error: '发送期间服务中断，投递结果未知；请核实，系统不会自动重发',
      },
      makeVerifiedDraft(custOfferHighlight._id, 'offerhighlight@example.test', offerBody),
    ]);

    // Trigger explicit reconciliation
    const rec = await reconcileOutreachCampaign(actorA, rep.id);
    assert.equal(rec.resumedPaused, 2, 'Both explicit system-paused and unambiguous legacy system-paused enrollments should auto-resume');
    assert.equal(rec.requeuedCancelled, 1, 'Only system_transient cancelled letter should be auto-reprepared');

    // Verify DB states directly
    const [dbSys, dbLegacy, dbManual, dbUnknown, dbReplied, dbManualCancel, dbUncertain] = await Promise.all([
      OutreachAutomationEnrollment.findById(enrSysPaused._id).lean(),
      OutreachAutomationEnrollment.findById(enrLegacySysPaused._id).lean(),
      OutreachAutomationEnrollment.findById(enrManualPaused._id).lean(),
      OutreachAutomationEnrollment.findById(enrUnknownPaused._id).lean(),
      OutreachAutomationEnrollment.findById(enrRepliedSysPaused._id).lean(),
      OutreachAutomationEnrollment.findById(enrManualCancelled._id).lean(),
      OutreachAutomationEnrollment.findById(enrUncertain._id).lean(),
    ]);
    assert.equal(dbSys?.status, 'active');
    assert.equal(dbLegacy?.status, 'active');
    assert.equal(dbManual?.status, 'paused', 'Manual pause must NEVER auto-resume');
    assert.equal(dbUnknown?.status, 'paused', 'Unknown legacy pause must NEVER guess-resume');
    assert.equal(dbReplied?.status, 'paused', 'Replied customer must NEVER auto-resume');
    assert.equal(dbManualCancel?.status, 'active');
    assert.equal(dbUncertain?.status, 'active');

    // Transient cancelled enrollment got a queued AgentTask to re-prepare step 1
    const transientTasks = await AgentTask.find({ customerId: custTransientCancelled._id, status: 'queued' }).lean();
    assert.equal(transientTasks.length, 1, 'Transient cancelled enrollment should enqueue fresh draft preparation');

    // Verify overview classification, counters, and flaggedExcerpts
    const ov = await getOutreachAutomationOverview(actorA, rep.id);
    const sysRow = ov.queue.find((q) => q.id === enrSysPaused.id);
    const manualRow = ov.queue.find((q) => q.id === enrManualPaused.id);
    const manualCancelRow = ov.queue.find((q) => q.id === enrManualCancelled.id);
    const uncertainRow = ov.queue.find((q) => q.id === enrUncertain.id);
    const offerRow = ov.queue.find((q) => q.id === enrOfferHighlight.id);

    assert.equal(sysRow?.status, 'active');
    assert.equal(sysRow?.draftStage, 'draft_saved_verified');
    assert.ok(sysRow?.nextSendLocalLabel, 'Active verified row should carry nextSendLocalLabel');

    assert.equal(manualRow?.status, 'paused');
    assert.equal(manualRow?.pauseOrigin, 'manual');

    assert.equal(manualCancelRow?.draftStage, 'delivery_cancelled');
    assert.equal(manualCancelRow?.cancelOrigin, 'manual');

    assert.equal(uncertainRow?.draftStage, 'delivery_uncertain');
    assert.equal(uncertainRow?.deliveryUncertain, true);

    assert.equal(offerRow?.draftStage, 'send_gate_blocked');
    assert.ok(
      offerRow?.flaggedExcerpts?.some((s) => s.text.includes('free sample kit')),
      'Offer-blocked draft must expose exact flaggedExcerpts sentence for editor locator',
    );

    // Action-needed counter MUST include uncertain delivery + offer blocked, and EXCLUDE manual pause, unknown pause, manual cancelled, replied, and active verified
    assert.equal(ov.stats.deliveryUncertainCount, 1);
    assert.equal(ov.stats.actionNeededCount, 2, 'Only uncertain delivery + offer-blocked draft require salesperson action');

    const uncertainDiag = await getOutreachEnrollmentDiagnostics(actorA, enrUncertain.id, rep.id);
    assert.equal(uncertainDiag.sendReadiness.status, 'delivery_uncertain');

    // Exercise the actual authenticated route against the isolated replica-set fixture.
    const { hashPassword } = await import('../src/models/User');
    const password = 'Local-Fictional-Recovery-Password!1';
    await Organization.updateOne({ _id: orgA }, { $setOnInsert: { name: 'Recovery Fixture', slug: 'recovery-fixture', subscriptionStatus: 'active' } }, { upsert: true });
    await User.updateOne({ _id: rep._id }, { $set: { passwordHash: await hashPassword(password), defaultProjectId: projectAId } });
    await OutreachAutomationConfig.updateOne({ _id: campaign._id }, { $set: { rolloutMode: 'shadow' } });
    const markSystemPaused = { $set: { status: 'paused', pauseOrigin: 'system', pausedAt: new Date() } };
    await OutreachAutomationEnrollment.updateMany({ _id: { $in: [enrSysPaused._id, enrUncertain._id, enrManualCancelled._id] } }, markSystemPaused);
    // A new draft must not hide an older uncertain delivery for the same customer and step.
    await DevelopmentLetter.create(makeVerifiedDraft(custUncertain._id, 'uncertain@example.test'));

    const server = http.createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api`;
    try {
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: rep.username, password }),
      });
      assert.equal(login.status, 200);
      const cookies = login.headers.getSetCookie().map((line) => line.split(';', 1)[0]!);
      const csrf = cookies.find((line) => line.startsWith('cdlm_csrf='))!.slice('cdlm_csrf='.length);
      const postBatch = (enrollmentIds: string[], query = '') => fetch(`${base}/outreach-automation/check-and-resume${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': csrf, 'x-project-id': projectAId },
        body: JSON.stringify({ enrollmentIds }),
      });
      const wrongOwner = await postBatch([enrSysPaused.id], `?userId=${actorA.id}`);
      assert.ok([403, 404].includes(wrongOwner.status));
      const response = await postBatch([
        enrSysPaused.id, enrManualPaused.id, enrUnknownPaused.id, enrRepliedSysPaused.id,
        enrManualCancelled.id, enrUncertain.id,
      ]);
      assert.equal(response.status, 200);
      const responseBody = await response.json() as { data: { resumed: number; requeued: number; skipped: number; reasons: Record<string, number> } };
      assert.equal(responseBody.data.resumed, 1);
      assert.equal(responseBody.data.requeued, 0);
      assert.equal(responseBody.data.skipped, 5);
      assert.equal(responseBody.data.reasons['需先确认邮件是否已经发出'], 1);
      assert.equal((await OutreachAutomationEnrollment.findById(enrSysPaused._id))?.status, 'active');
      for (const untouched of [enrManualPaused, enrUnknownPaused, enrRepliedSysPaused, enrManualCancelled, enrUncertain]) {
        assert.equal((await OutreachAutomationEnrollment.findById(untouched._id))?.status, 'paused');
      }
      assert.equal(await DevelopmentLetter.countDocuments({ projectId: projectAId, customerId: custSysPaused._id, status: 'sent' }), 0);
      const repeatedBatch = await postBatch([enrSysPaused.id]);
      const repeatedResult = await repeatedBatch.json() as { data: { resumed: number; skipped: number } };
      assert.equal(repeatedResult.data.resumed, 0);
      assert.equal(repeatedResult.data.skipped, 1);

      await OutreachAutomationEnrollment.updateOne({ _id: enrLegacySysPaused._id }, markSystemPaused);
      const stale = await DevelopmentLetter.findOne({ customerId: custLegacySysPaused._id, status: 'draft' });
      assert.ok(stale);
      await DevelopmentLetter.collection.updateOne({ _id: stale._id }, { $set: { 'knowledgeReview.context': {
        customerId: custLegacySysPaused.id,
        customerWebsites: [{ sourceId: 'website:expired-fictional-snapshot', sha256: '0'.repeat(64), url: 'https://example.test/', text: 'Fictional old evidence', collectedAt: new Date(0).toISOString() }],
      } } });
      // The real worker leaves the task awaiting review after saving a draft.
      const savedTask = await AgentTask.create({
        projectId: projectAId, userId: rep._id, customerId: custLegacySysPaused._id,
        sessionId: new Types.ObjectId(), actorRole: 'user', goal: 'Fictional saved draft',
        requestKey: 'recovery-saved-draft-task', kind: 'first_outreach',
        outreachStep: stale.outreachStep, status: 'awaiting_review', draftId: stale._id,
      });
      const rebuild = await postBatch([enrLegacySysPaused.id]);
      assert.equal(rebuild.status, 200);
      const rebuilt = await rebuild.json() as { data: { resumed: number; requeued: number; skipped: number; reasons?: Record<string, number> } };
      assert.deepEqual([rebuilt.data.resumed, rebuilt.data.requeued, rebuilt.data.skipped], [0, 1, 0], JSON.stringify(rebuilt.data.reasons));
      assert.equal((await OutreachAutomationEnrollment.findById(enrLegacySysPaused._id))?.status, 'paused');
      assert.equal((await DevelopmentLetter.findById(stale._id))?.cancelOrigin, 'superseded');
      assert.equal((await AgentTask.findById(savedTask._id))?.status, 'cancelled');
      const taskFilter = { customerId: custLegacySysPaused._id, status: 'queued' };
      assert.equal(await AgentTask.countDocuments(taskFilter), 1);
      const repeatRebuild = await postBatch([enrLegacySysPaused.id]);
      const repeatedRebuild = await repeatRebuild.json() as { data: { requeued: number } };
      assert.equal(repeatedRebuild.data.requeued, 0);
      assert.equal(await AgentTask.countDocuments(taskFilter), 1);

      // Simulate the rest of a one-click batch waiting on the generation ceiling. The worker
      // loads a fresh config and drains only selected, persisted rows without a second click.
      const recoveryCustomers = await Customer.create(['deferred', 'untouched', 'replied', 'manual', 'changed', 'config'].map((key) => ({
        projectId: projectAId, ownerId: rep._id, name: `Recovery ${key}`, country: 'United States',
        email: `${key}-recovery@example.test`, status: 'pending',
      })));
      const recoveryRows = await OutreachAutomationEnrollment.create(recoveryCustomers.map((customer) => ({
        projectId: projectAId, userId: rep._id, campaignId: campaign._id, customerId: customer._id,
        status: 'paused', pauseOrigin: 'system', nextRunAt: new Date(),
      })));
      const recoveryDrafts = await DevelopmentLetter.create(recoveryCustomers.map((customer) => {
        const draft = makeVerifiedDraft(customer._id, customer.email!);
        return { ...draft, knowledgeReview: { ...draft.knowledgeReview, context: {
          customerId: customer.id,
          customerWebsites: [{ sourceId: 'website:expired-fictional-snapshot', sha256: '0'.repeat(64), url: 'https://example.test/', text: 'Fictional old evidence', collectedAt: new Date(0).toISOString() }],
        } } };
      }));
      const capacityTasks = await AgentTask.create([0, 1, 2].map((i) => ({
        projectId: projectAId, userId: rep._id, customerId: new Types.ObjectId(),
        sessionId: new Types.ObjectId(), actorRole: 'user', goal: 'Fictional occupied capacity',
        requestKey: `recovery-capacity-${i}`, kind: 'first_outreach', outreachStep: 1, status: 'queued',
      })));
      const selected = [0, 2, 3, 4].map((i) => recoveryRows[i]!.id);
      const deferredResponse = await postBatch(selected);
      assert.equal(deferredResponse.status, 200);
      const deferredResult = await deferredResponse.json() as {data: {deferred: number; skipped: number; requeued: number; overview: {stats: {continuationPendingCount: number}}}};
      assert.deepEqual([deferredResult.data.deferred, deferredResult.data.skipped, deferredResult.data.requeued], [4, 0, 0]);
      assert.equal(deferredResult.data.overview.stats.continuationPendingCount, 4);
      for (const i of [0, 2, 3, 4]) assert.ok((await OutreachAutomationEnrollment.findById(recoveryRows[i]!._id))?.recoveryContinuation);
      assert.equal((await OutreachAutomationEnrollment.findById(recoveryRows[1]!._id))?.recoveryContinuation, undefined);
      const { drainOutreachRecoveryContinuation, controlOutreachEnrollment } = await import('../src/services/outreach-automation.service');
      const confirmedActor = { ...actorA, id: rep.id, role: 'user' as const };
      const loadedConfig = await OutreachAutomationConfig.findById(campaign._id);
      assert.ok(loadedConfig);
      assert.equal((await drainOutreachRecoveryContinuation(loadedConfig, confirmedActor))?.deferred, 4);
      await Customer.updateOne({ _id: recoveryCustomers[2]!._id }, { $set: { status: 'replied' } });
      await controlOutreachEnrollment(confirmedActor, recoveryRows[3]!.id, 'pause');
      await DevelopmentLetter.updateOne({ _id: recoveryDrafts[4]!._id }, { $set: { subject: 'Changed fictional draft' } });
      await AgentTask.updateMany({ _id: { $in: capacityTasks.map((t) => t._id) } }, { $set: { status: 'cancelled' } });
      const drained = await drainOutreachRecoveryContinuation(loadedConfig, confirmedActor);
      assert.equal(drained?.requeuedWebsiteDrafts, 1);
      assert.equal((await DevelopmentLetter.findById(recoveryDrafts[0]!._id))?.cancelOrigin, 'superseded');
      for (const i of [1, 2, 3, 4]) assert.equal((await DevelopmentLetter.findById(recoveryDrafts[i]!._id))?.status, 'draft');
      for (const row of recoveryRows) {
        const current = await OutreachAutomationEnrollment.findById(row._id);
        assert.equal(current?.status, 'paused');
        assert.equal(current?.recoveryContinuation, undefined);
      }
      assert.equal((await OutreachAutomationEnrollment.findById(recoveryRows[3]!._id))?.pauseOrigin, 'manual');
      assert.equal(await AgentTask.countDocuments({ customerId: recoveryCustomers[0]!._id, status: 'queued' }), 1);
      assert.equal(await DevelopmentLetter.countDocuments({ customerId: { $in: recoveryCustomers.map((x) => x._id) }, status: 'sent' }), 0);
      assert.equal(await drainOutreachRecoveryContinuation(loadedConfig, confirmedActor), undefined);

      // A pause/resume or other config revision invalidates older opt-ins.
      await AgentTask.updateMany({ _id: { $in: capacityTasks.map((t) => t._id) } }, { $set: { status: 'queued' } });
      const configDeferral = await postBatch([recoveryRows[5]!.id]);
      assert.equal(configDeferral.status, 200);
      assert.equal((await configDeferral.json() as {data: {deferred: number}}).data.deferred, 1);
      await OutreachAutomationConfig.updateOne({ _id: loadedConfig._id }, { $set: { enabled: false }, $inc: { version: 1 } });
      assert.equal(await drainOutreachRecoveryContinuation(loadedConfig, confirmedActor), undefined);
      await OutreachAutomationConfig.updateOne({ _id: loadedConfig._id }, { $set: { enabled: true }, $inc: { version: 1 } });
      const revisedConfig = await OutreachAutomationConfig.findById(loadedConfig._id);
      assert.ok(revisedConfig);
      await drainOutreachRecoveryContinuation(revisedConfig, confirmedActor);
      assert.equal((await OutreachAutomationEnrollment.findById(recoveryRows[5]!._id))?.recoveryContinuation, undefined);
      assert.equal((await DevelopmentLetter.findById(recoveryDrafts[5]!._id))?.status, 'draft');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
