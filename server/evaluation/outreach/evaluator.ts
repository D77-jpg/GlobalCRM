import { selectOutreachPlaybook } from '../../src/services/agent/outreach-playbook';
import {
  detectCrossEmailRepetition,
  evaluateOutreachDraftQuality,
  extractQuestions,
  semanticTokens,
  jaccardSimilarity,
} from '../../src/services/agent/outreach-quality';

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
  // 1. Angle relevance: cites customer cue(s), avoids cross-brand leak & generic filler
  const cueHits = sample.expectedCues.filter((cue) => s1Lower.includes(cue.toLowerCase())).length;
  const crossBrandLeak =
    (sample.brandKey === 'ironhue' && /\b(?:velvet pouch|gift box|packaging factory|spa gift)\b/i.test(s1Lower))
    || (sample.brandKey === 'velaturo' && /\b(?:gift box|velvet pouch|dumbbell|bumper plate)\b/i.test(s1Lower))
    || (sample.brandKey === 'genesis' && /\b(?:hotel and boutique gift|bumper plate|acrylic canvas)\b/i.test(s1Lower));
  let angleRelevance = Math.min(100, 45 + cueHits * 22);
  if (crossBrandLeak) angleRelevance = Math.max(0, angleRelevance - 55);
  if (sample.scenario === 'generic_email' && /sir\/madam/i.test(drafts.step1.bodyText)) angleRelevance -= 25;
  angleRelevance = Math.max(0, Math.min(100, angleRelevance));

  // 2. Capability credibility: overlaps with verified knowledgeProof tokens and avoids generic hype
  const proofOverlap = jaccardSimilarity(semanticTokens(drafts.step1.bodyText), semanticTokens(sample.knowledgeProof));
  const hasHype = /\b(?:leading manufacturer|best service|guaranteed|cheap prices|all kinds of)\b/i.test(drafts.step1.bodyText);
  let capabilityCredibility = Math.round(Math.min(100, 35 + proofOverlap * 180));
  if (hasHype) capabilityCredibility -= 35;
  if (q1.issues.some((i) => i.code === 'bridge_missing')) capabilityCredibility -= 15;
  capabilityCredibility = Math.max(0, Math.min(100, capabilityCredibility));

  // 3. Copy naturalness: average of step 1-3 quality scores (penalizing clichés, buzzwords, long paragraphs, bad readability)
  const copyNaturalness = Math.round((q1.score * 0.5 + q2.score * 0.3 + q3.score * 0.2));

  // 4. Reply ease: single low-friction question in step 1 & 2, polite closing in step 3
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

  // 5. Sequence distinctness: step 2 & 3 don't repeat step 1, step 2 adds new value, step 3 closes softly
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
  if (currentOverallAvg - legacyOverallAvg < 15) gateFailures.push(`新版相对旧版提升 ${(currentOverallAvg - legacyOverallAvg).toFixed(1)} 低于门槛 15.0`);
  for (const [brand, stat] of Object.entries(byBrand)) {
    if (stat.delta <= 0) gateFailures.push(`品牌 ${brand} 出现退步（delta=${stat.delta}）`);
    if (stat.currentAvg < 75) gateFailures.push(`品牌 ${brand} 新版均值 ${stat.currentAvg} 低于 75`);
  }
  for (const [scenario, stat] of Object.entries(byScenario)) {
    if (stat.delta <= 0) gateFailures.push(`客户类型 ${scenario} 出现退步（delta=${stat.delta}）`);
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
