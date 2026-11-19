import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateSamples, type OutreachEvalSample } from './evaluator';
import { OpenAIResponsesProvider } from '../../src/services/agent/openai-provider';
import {
  OUTREACH_WRITING_VERSION,
  OUTREACH_WRITING_VERSION_LEGACY,
  projectPromptContext,
  resolveProjectSalesProfile,
} from '../../src/services/project-profile';
import { selectOutreachPlaybook } from '../../src/services/agent/outreach-playbook';
import type { CustomerAnalysisInput, PreviousOutreachDraft } from '../../src/services/agent/provider';

async function generateLiveSequence(
  provider: OpenAIResponsesProvider,
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

async function main() {
  const args = new Set(process.argv.slice(2));
  const live = args.has('--live');
  const jsonOutput = args.has('--json');
  const filePath = path.resolve(__dirname, 'samples.json');
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
    datasetVersion: string;
    samples: OutreachEvalSample[];
  };

  let overrides: Map<string, { legacy: OutreachEvalSample['legacyDrafts']; current: OutreachEvalSample['v2Drafts'] }> | undefined;
  if (live) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
    const baseUrl = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
    if (!apiKey) {
      console.error('Live evaluation requires OPENAI_API_KEY in the environment.');
      process.exit(2);
    }
    const provider = new OpenAIResponsesProvider({ apiKey, model, baseUrl, timeoutMs: 45_000 });
    overrides = new Map();
    const limitArg = process.argv.find((a) => a.startsWith('--limit='));
    const limit = limitArg ? Number(limitArg.split('=')[1]) : raw.samples.length;
    const subset = raw.samples.slice(0, Math.max(1, limit));
    for (const sample of subset) {
      const legacy = await generateLiveSequence(provider, sample, OUTREACH_WRITING_VERSION_LEGACY);
      const current = await generateLiveSequence(provider, sample, OUTREACH_WRITING_VERSION);
      overrides.set(sample.id, { legacy, current });
    }
  }

  const evaluatedSamples = overrides ? raw.samples.filter((s) => overrides!.has(s.id)) : raw.samples;
  const report = evaluateSamples(evaluatedSamples, raw.datasetVersion, live ? 'live' : 'offline', overrides);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Outreach Evaluation [${report.mode}] dataset=${report.datasetVersion} samples=${report.totalSamples}`);
    console.log(`Playbook Accuracy: ${(report.playbookAccuracy * 100).toFixed(1)}%`);
    console.log(`Overall: legacy=${report.legacyOverallAvg} -> v2=${report.currentOverallAvg} (delta +${report.overallDelta})`);
    console.log('By Brand:', JSON.stringify(report.byBrand));
    console.log('By Scenario:', JSON.stringify(report.byScenario));
    console.log(`Release Gate: ${report.gatePassed ? 'PASSED' : 'FAILED'}`);
    if (!report.gatePassed) {
      for (const failure of report.gateFailures) console.error(`  - ${failure}`);
    }
  }

  if (!report.gatePassed) process.exit(1);
}

main().catch((err) => {
  console.error('Outreach evaluation failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
