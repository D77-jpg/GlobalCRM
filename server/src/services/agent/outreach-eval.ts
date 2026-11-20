import { readFileSync } from 'node:fs';
import {
  OUTREACH_WRITING_VERSION,
  OUTREACH_WRITING_VERSION_LEGACY,
  projectPromptContext,
  resolveProjectSalesProfile,
} from '../project-profile';
import { selectOutreachPlaybook } from './outreach-playbook';
import {
  detectCrossEmailRepetition,
  evaluateOutreachDraftQuality,
  extractQuestions,
  jaccardSimilarity,
  semanticTokens,
} from './outreach-quality';
import type { AgentProvider, CustomerAnalysisInput, PreviousOutreachDraft } from './provider';

export interface OutreachEvalDraft {
  subject: string;
  bodyText: string;
}

export interface OutreachEvalSample {
  id: string;
  brandKey: 'genesis' | 'ironhue' | 'velaturo';
  scenario: 'rich' | 'sparse' | 'generic_email' | 'brand_role' | 'procurement_role' | 'tricky_angle';
  customer: {
    name: string;
    company: string;
    email: string;
    title: string;
    country: string;
    industry: string;
    interestedProducts: string;
    websiteText: string;
  };
  knowledgeProof: string;
  expectedSegmentPrefix: string;
  forbiddenSegmentCodes: string[];
  expectedCues: string[];
  legacyDrafts: { step1: OutreachEvalDraft; step2: OutreachEvalDraft; step3: OutreachEvalDraft };
  v2Drafts: { step1: OutreachEvalDraft; step2: OutreachEvalDraft; step3: OutreachEvalDraft };
}

export interface SequenceScores {
  angleRelevance: number;
  capabilityCredibility: number;
  copyNaturalness: number;
  replyEase: number;
  sequenceDistinctness: number;
  overall: number;
  blockingIssues: string[];
}

export interface SampleComparisonResult {
  sampleId: string;
  brandKey: OutreachEvalSample['brandKey'];
  scenario: OutreachEvalSample['scenario'];
  selectedSegmentCode?: string;
  playbookSelectionPassed: boolean;
  legacy: SequenceScores;
  current: SequenceScores;
  delta: number;
}

export interface EvalSummaryReport {
  mode: 'offline' | 'live';
  datasetVersion: string;
  totalSamples: number;
  playbookAccuracy: number;
  legacyOverallAvg: number;
  currentOverallAvg: number;
  overallDelta: number;
  byBrand: Record<string, { count: number; legacyAvg: number; currentAvg: number; delta: number; passRate: number }>;
  byScenario: Record<string, { count: number; legacyAvg: number; currentAvg: number; delta: number; passRate: number }>;
  gatePassed: boolean;
  gateFailures: string[];
  results: SampleComparisonResult[];
}

export interface LiveEvalProviderResolution {
  provider: AgentProvider;
  model: string;
  source: 'crm_ai_settings' | 'env';
  organizationId?: string;
  organizationSlug?: string;
  cleanup: () => Promise<void>;
}

export function scoreOutreachSequence(
  sample: OutreachEvalSample,
  drafts: { step1: OutreachEvalDraft; step2: OutreachEvalDraft; step3: OutreachEvalDraft },
): SequenceScores {
  const sparse = sample.scenario === 'sparse';
  const q1 = evaluateOutreachDraftQuality({
    bodyText: drafts.step1.bodyText,
    subject: drafts.step1.subject,
    step: 1,
    sparseInfo: sparse,
    customerHints: sample.expectedCues,
  });
  const q2 = evaluateOutreachDraftQuality({
    bodyText: drafts.step2.bodyText,
    subject: drafts.step2.subject,
    step: 2,
    sparseInfo: sparse,
    customerHints: sample.expectedCues,
  });
  const q3 = evaluateOutreachDraftQuality({
    bodyText: drafts.step3.bodyText,
    subject: drafts.step3.subject,
    step: 3,
    sparseInfo: sparse,
    customerHints: sample.expectedCues,
  });

  const s1Lower = `${drafts.step1.subject} ${drafts.step1.bodyText}`.toLowerCase();
  const cueHits = sample.expectedCues.filter((cue) => s1Lower.includes(cue.toLowerCase())).length;
  const crossBrandLeak =
    (sample.brandKey === 'ironhue' && /\b(?:velvet pouch|gift box|packaging factory|spa gift)\b/i.test(s1Lower))
    || (sample.brandKey === 'velaturo' && /\b(?:gift box|velvet pouch|dumbbell|bumper plate)\b/i.test(s1Lower))
    || (sample.brandKey === 'genesis' && /\b(?:hotel and boutique gift|bumper plate|acrylic canvas)\b/i.test(s1Lower));
  let angleRelevance = Math.min(100, 45 + cueHits * 22);
  if (crossBrandLeak) angleRelevance = Math.max(0, angleRelevance - 55);
  if (sample.scenario === 'generic_email' && /sir\/madam/i.test(drafts.step1.bodyText)) angleRelevance -= 25;
  angleRelevance = Math.max(0, Math.min(100, angleRelevance));

  const proofOverlap = jaccardSimilarity(semanticTokens(drafts.step1.bodyText), semanticTokens(sample.knowledgeProof));
  const hasHype = /\b(?:leading manufacturer|best service|guaranteed|cheap prices|all kinds of)\b/i.test(drafts.step1.bodyText);
  let capabilityCredibility = Math.round(Math.min(100, 35 + proofOverlap * 180));
  if (hasHype) capabilityCredibility -= 35;
  if (q1.issues.some((i) => i.code === 'bridge_missing')) capabilityCredibility -= 15;
  capabilityCredibility = Math.max(0, Math.min(100, capabilityCredibility));

  const copyNaturalness = Math.round((q1.score * 0.5 + q2.score * 0.3 + q3.score * 0.2));

  let replyEase = 100;
  for (const [stepIdx, q] of [[1, q1], [2, q2]] as const) {
    if (q.issues.some((i) => i.code === 'cta_count')) replyEase -= 30;
    if (q.issues.some((i) => i.code === 'cta_friction')) replyEase -= 30;
    const qs = extractQuestions(stepIdx === 1 ? drafts.step1.bodyText : drafts.step2.bodyText);
    if (qs.length === 1 && qs[0].split(/\s+/).length > 22) replyEase -= 10;
  }
  if (sample.scenario === 'generic_email' && !/\b(?:who|point me|direct me|right (?:person|desk)|handles)\b/i.test(drafts.step1.bodyText)) {
    replyEase -= 15;
  }
  replyEase = Math.max(0, Math.min(100, replyEase));

  let sequenceDistinctness = 100;
  const rep2 = detectCrossEmailRepetition({
    bodyText: drafts.step2.bodyText,
    step: 2,
    previous: [{ step: 1, subject: drafts.step1.subject, bodyText: drafts.step1.bodyText }],
  });
  const rep3 = detectCrossEmailRepetition({
    bodyText: drafts.step3.bodyText,
    step: 3,
    previous: [
      { step: 1, subject: drafts.step1.subject, bodyText: drafts.step1.bodyText },
      { step: 2, subject: drafts.step2.subject, bodyText: drafts.step2.bodyText },
    ],
  });
  if (rep2) sequenceDistinctness -= 45;
  if (rep3) sequenceDistinctness -= 30;
  const step3PoliteClose = /\b(?:last|final|pause|close|crowd|filling your inbox)\b/i.test(drafts.step3.bodyText);
  if (!step3PoliteClose) sequenceDistinctness -= 25;
  const step2Reintro = /\b(?:leading manufacturer|i am reaching out to introduce)\b/i.test(drafts.step2.bodyText);
  if (step2Reintro) sequenceDistinctness -= 25;
  sequenceDistinctness = Math.max(0, Math.min(100, sequenceDistinctness));

  const blockingIssues = [
    ...q1.issues.filter((i) => i.severity === 'block').map((i) => `step1:${i.code}`),
    ...q2.issues.filter((i) => i.severity === 'block').map((i) => `step2:${i.code}`),
    ...q3.issues.filter((i) => i.severity === 'block').map((i) => `step3:${i.code}`),
    ...(rep2 ? ['step2:repetition'] : []),
    ...(rep3 ? ['step3:repetition'] : []),
    ...(crossBrandLeak ? ['step1:cross_brand_leak'] : []),
  ];

  const overall = Number(
    (
      angleRelevance * 0.22
      + capabilityCredibility * 0.22
      + copyNaturalness * 0.22
      + replyEase * 0.16
      + sequenceDistinctness * 0.18
    ).toFixed(1),
  );

  return {
    angleRelevance,
    capabilityCredibility,
    copyNaturalness,
    replyEase,
    sequenceDistinctness,
    overall,
    blockingIssues,
  };
}

export function evaluateSamples(
  samples: OutreachEvalSample[],
  datasetVersion: string,
  mode: 'offline' | 'live' = 'offline',
  overrides?: Map<string, { legacy: OutreachEvalSample['legacyDrafts']; current: OutreachEvalSample['v2Drafts'] }>,
): EvalSummaryReport {
  const results: SampleComparisonResult[] = [];
  let playbookPassedCount = 0;

  for (const sample of samples) {
    const selected = selectOutreachPlaybook({
      projectKey: sample.brandKey,
      outreachStep: 1,
      industry: sample.customer.industry,
      interestedProducts: sample.customer.interestedProducts,
      websiteText: sample.customer.websiteText,
      contactRole: sample.customer.title,
    });
    const playbookSelectionPassed = Boolean(
      selected
      && selected.segmentCode.startsWith(sample.expectedSegmentPrefix)
      && !sample.forbiddenSegmentCodes.includes(selected.segmentCode),
    );
    if (playbookSelectionPassed) playbookPassedCount++;

    const pair = overrides?.get(sample.id);
    const legacy = scoreOutreachSequence(sample, pair?.legacy ?? sample.legacyDrafts);
    const current = scoreOutreachSequence(sample, pair?.current ?? sample.v2Drafts);
    results.push({
      sampleId: sample.id,
      brandKey: sample.brandKey,
      scenario: sample.scenario,
      selectedSegmentCode: selected?.segmentCode,
      playbookSelectionPassed,
      legacy,
      current,
      delta: Number((current.overall - legacy.overall).toFixed(1)),
    });
  }

  const avg = (nums: number[]) => (nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)) : 0);
  const groupStats = (keyFn: (r: SampleComparisonResult) => string) => {
    const map = new Map<string, SampleComparisonResult[]>();
    for (const r of results) {
      const k = keyFn(r);
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    const out: Record<string, { count: number; legacyAvg: number; currentAvg: number; delta: number; passRate: number }> = {};
    for (const [k, list] of map.entries()) {
      const legacyAvg = avg(list.map((r) => r.legacy.overall));
      const currentAvg = avg(list.map((r) => r.current.overall));
      const passRate = Number((list.filter((r) => r.current.blockingIssues.length === 0 && r.playbookSelectionPassed).length / list.length).toFixed(3));
      out[k] = { count: list.length, legacyAvg, currentAvg, delta: Number((currentAvg - legacyAvg).toFixed(1)), passRate };
    }
    return out;
  };

  const legacyOverallAvg = avg(results.map((r) => r.legacy.overall));
  const currentOverallAvg = avg(results.map((r) => r.current.overall));
  const playbookAccuracy = Number((playbookPassedCount / Math.max(1, results.length)).toFixed(3));
  const byBrand = groupStats((r) => r.brandKey);
  const byScenario = groupStats((r) => r.scenario);

  const gateFailures: string[] = [];
  if (playbookAccuracy < 0.9) gateFailures.push(`Playbook 切入准确率 ${playbookAccuracy} 低于门槛 0.90`);
  if (currentOverallAvg < 80) gateFailures.push(`新版综合分 ${currentOverallAvg} 低于门槛 80.0`);
  const minDelta = mode === 'live' ? (legacyOverallAvg < 75 ? 10 : 0.1) : 15;
  if (currentOverallAvg - legacyOverallAvg < minDelta) {
    gateFailures.push(`新版相对旧版提升 ${(currentOverallAvg - legacyOverallAvg).toFixed(1)} 低于门槛 ${minDelta.toFixed(1)}`);
  }
  for (const [brand, stat] of Object.entries(byBrand)) {
    if (stat.delta < 0 || (mode === 'offline' && stat.delta <= 0)) gateFailures.push(`品牌 ${brand} 出现退步（delta=${stat.delta}）`);
    if (stat.currentAvg < 75) gateFailures.push(`品牌 ${brand} 新版均值 ${stat.currentAvg} 低于 75`);
  }
  for (const [scenario, stat] of Object.entries(byScenario)) {
    if (stat.delta < 0 || (mode === 'offline' && stat.delta <= 0)) gateFailures.push(`客户类型 ${scenario} 出现退步（delta=${stat.delta}）`);
  }

  return {
    mode,
    datasetVersion,
    totalSamples: results.length,
    playbookAccuracy,
    legacyOverallAvg,
    currentOverallAvg,
    overallDelta: Number((currentOverallAvg - legacyOverallAvg).toFixed(1)),
    byBrand,
    byScenario,
    gatePassed: gateFailures.length === 0,
    gateFailures,
    results,
  };
}

export async function resolveLiveEvalProvider(options: {
  useCrmAi: boolean;
  orgSlug?: string;
  organizationId?: string;
  providerName?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<LiveEvalProviderResolution> {
  const { OpenAIResponsesProvider } = await import('./openai-provider');
  if (options.useCrmAi) {
    const [{ default: mongoose }, { default: env }, { Organization }, { runWithTenant }, { resolveAgentProvider }] = await Promise.all([
      import('mongoose'),
      import('../../config/env'),
      import('../../models'),
      import('../../models/tenant-context'),
      import('./ai-settings.service'),
    ]);
    let shouldDisconnect = false;
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
      shouldDisconnect = true;
    }
    const cleanup = async () => {
      if (shouldDisconnect && mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
      }
    };
    try {
      const org = options.organizationId
        ? await Organization.findById(options.organizationId).select('_id slug status').lean()
        : options.orgSlug
          ? await Organization.findOne({ slug: options.orgSlug, status: 'active' }).select('_id slug status').lean()
          : await Organization.findOne({ status: 'active' }).sort({ createdAt: 1 }).select('_id slug status').lean();
      if (!org) {
        throw new Error(
          options.orgSlug
            ? `未找到状态为 active 的组织（slug=${options.orgSlug}）。`
            : '数据库中未找到状态为 active 的组织，无法读取 CRM AI 设置。',
        );
      }
      const provider = await runWithTenant(
        { organizationId: String(org._id), source: 'outreach-eval-live' },
        () => resolveAgentProvider(options.providerName),
      );
      if (provider.name === 'mock' || !(provider instanceof OpenAIResponsesProvider)) {
        throw new Error(
          `组织 ${org.slug} 的 CRM「AI 设置」当前未启用在线 AI 服务（当前为 ${provider.name}），请先在 CRM 页面配置并启用在线服务后再运行 --use-crm-ai。`,
        );
      }
      return {
        provider,
        model: provider.model,
        source: 'crm_ai_settings',
        organizationId: String(org._id),
        organizationSlug: org.slug,
        cleanup,
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  const model = (options.model ?? process.env.OPENAI_MODEL)?.trim() || 'gpt-4o-mini';
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL)?.trim() || 'https://api.openai.com/v1';
  if (!apiKey) {
    throw new Error('Live evaluation requires OPENAI_API_KEY in the environment (or pass --use-crm-ai to reuse CRM AI settings).');
  }
  const provider = new OpenAIResponsesProvider({ apiKey, model, baseUrl, timeoutMs: 45_000 });
  return {
    provider,
    model: provider.model,
    source: 'env',
    cleanup: async () => {},
  };
}

export async function generateLiveSequence(
  provider: AgentProvider,
  sample: OutreachEvalSample,
  writingVersion: string,
) {
  const profile = resolveProjectSalesProfile({ brandProfile: { brandKey: sample.brandKey } });
  const baseContext = { ...projectPromptContext(profile), writingVersion };
  const previous: PreviousOutreachDraft[] = [];
  const drafts: Record<'step1' | 'step2' | 'step3', { subject: string; bodyText: string }> = {
    step1: { subject: '', bodyText: '' },
    step2: { subject: '', bodyText: '' },
    step3: { subject: '', bodyText: '' },
  };

  for (const step of [1, 2, 3] as const) {
    const playbook = writingVersion === OUTREACH_WRITING_VERSION_LEGACY
      ? undefined
      : selectOutreachPlaybook({
        projectKey: sample.brandKey,
        outreachStep: step,
        industry: sample.customer.industry,
        interestedProducts: sample.customer.interestedProducts,
        websiteText: sample.customer.websiteText,
        contactRole: sample.customer.title,
        usedAngles: previous.map((p) => p.angleCode).filter((x): x is string => Boolean(x)),
        savedAlternatives: previous[0]?.savedAlternatives,
      });

    const input: CustomerAnalysisInput = {
      customerName: sample.customer.name,
      customerEmail: sample.customer.email,
      firstOutreach: step === 1,
      outreachStep: step,
      previousOutreach: previous.length ? previous : undefined,
      taskType: 'first_outreach',
      projectProfile: playbook ? { ...baseContext, playbook } : baseContext,
      seller: { companyName: profile.label, senderName: 'Alex' },
      sourceCatalog: [
        { sourceId: `profile:${sample.id}`, kind: 'profile', label: '客户档案', content: sample.customer },
        { sourceId: `website:${sample.id}`, kind: 'website', label: '客户官网', content: { url: 'https://buyer.example.test', text: sample.customer.websiteText, sha256: sample.id, collectedAt: '2026-11-19' } },
        { sourceId: `knowledge:${sample.id}`, kind: 'knowledge', label: '已发布产品知识', content: sample.knowledgeProof },
      ],
      knowledgeContext: {
        projectId: sample.brandKey,
        status: 'ready',
        topics: [],
        issues: [],
        sources: [{
          sourceId: `knowledge:${sample.id}`,
          knowledgeId: sample.id,
          version: 1,
          title: `${sample.brandKey} capability`,
          category: 'product',
          kind: 'knowledge',
          content: sample.knowledgeProof,
          source: 'eval-fixture',
          applicability: 'all',
          products: [],
          validFrom: '2026-01-01',
          terms: [],
        }],
      },
    };
    const res = await provider.analyzeCustomer({ input, safetyIdentifier: `eval-${sample.id}-s${step}` });
    const key = `step${step}` as const;
    drafts[key] = res.emailDraft;
    previous.push({
      step,
      subject: res.emailDraft.subject,
      bodyText: res.emailDraft.bodyText,
      angleCode: playbook?.segmentCode,
      savedAlternatives: playbook?.alternatives,
    });
  }
  return drafts;
}

export async function runOutreachEvaluationCli(argv: string[], defaultSamplesPath: string) {
  const args = new Set(argv);
  const useCrmAi = args.has('--use-crm-ai');
  const live = args.has('--live') || useCrmAi;
  const jsonOutput = args.has('--json');
  const orgArg = argv.find((a) => a.startsWith('--org='));
  const orgSlug = orgArg ? orgArg.slice('--org='.length).trim() : undefined;
  const providerArg = argv.find((a) => a.startsWith('--provider='));
  const providerName = providerArg ? providerArg.slice('--provider='.length).trim() : undefined;
  const samplesArg = argv.find((a) => a.startsWith('--samples='));
  const filePath = samplesArg ? samplesArg.slice('--samples='.length).trim() : defaultSamplesPath;

  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
    datasetVersion: string;
    samples: OutreachEvalSample[];
  };

  let overrides: Map<string, { legacy: OutreachEvalSample['legacyDrafts']; current: OutreachEvalSample['v2Drafts'] }> | undefined;
  let providerMeta: { source: string; model: string; organizationSlug?: string } | undefined;

  if (live) {
    const resolved = await resolveLiveEvalProvider({ useCrmAi, orgSlug, providerName });
    providerMeta = {
      source: resolved.source,
      model: resolved.model,
      organizationSlug: resolved.organizationSlug,
    };
    try {
      overrides = new Map();
      const perBrandArg = argv.find((a) => a.startsWith('--per-brand='));
      const perBrand = perBrandArg ? Number(perBrandArg.split('=')[1]) : 0;
      const limitArg = argv.find((a) => a.startsWith('--limit='));
      const limit = limitArg ? Number(limitArg.split('=')[1]) : raw.samples.length;
      let subset: OutreachEvalSample[];
      if (Number.isFinite(perBrand) && perBrand > 0) {
        const seen = new Map<string, number>();
        subset = raw.samples.filter((s) => {
          const n = seen.get(s.brandKey) ?? 0;
          if (n >= perBrand) return false;
          seen.set(s.brandKey, n + 1);
          return true;
        });
      } else {
        subset = raw.samples.slice(0, Math.max(1, Number.isFinite(limit) ? limit : raw.samples.length));
      }
      for (const sample of subset) {
        const legacy = await generateLiveSequence(resolved.provider, sample, OUTREACH_WRITING_VERSION_LEGACY);
        const current = await generateLiveSequence(resolved.provider, sample, OUTREACH_WRITING_VERSION);
        overrides.set(sample.id, { legacy, current });
      }
    } finally {
      await resolved.cleanup();
    }
  }

  const evaluatedSamples = overrides ? raw.samples.filter((s) => overrides!.has(s.id)) : raw.samples;
  const report = evaluateSamples(evaluatedSamples, raw.datasetVersion, live ? 'live' : 'offline', overrides);

  if (jsonOutput) {
    console.log(JSON.stringify({ ...report, ...(providerMeta ? { provider: providerMeta } : {}) }, null, 2));
  } else {
    const providerTag = providerMeta
      ? ` provider=${providerMeta.source} model=${providerMeta.model}${providerMeta.organizationSlug ? ` org=${providerMeta.organizationSlug}` : ''}`
      : '';
    console.log(`Outreach Evaluation [${report.mode}] dataset=${report.datasetVersion} samples=${report.totalSamples}${providerTag}`);
    console.log(`Playbook Accuracy: ${(report.playbookAccuracy * 100).toFixed(1)}%`);
    console.log(`Overall: legacy=${report.legacyOverallAvg} -> v2=${report.currentOverallAvg} (delta +${report.overallDelta})`);
    console.log('By Brand:', JSON.stringify(report.byBrand));
    console.log('By Scenario:', JSON.stringify(report.byScenario));
    console.log(`Release Gate: ${report.gatePassed ? 'PASSED' : 'FAILED'}`);
    if (!report.gatePassed) {
      for (const failure of report.gateFailures) console.error(`  - ${failure}`);
    }
  }

  return report;
}
