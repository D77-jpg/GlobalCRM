import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Customer, DevelopmentLetter, Project } from '../models';
import { MailMessage } from '../models/MailMessage';
import { OutreachExperiment, type ExperimentStratum } from '../models/OutreachExperiment';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { requireProjectId } from '../utils/access';
import { resolveProjectSalesProfile } from './project-profile';
import { classifyCustomerTier } from './agent/writing-release.service';
import { classifyReplySignal, normalizeMsgId } from './outreach-results.service';

export interface ExperimentArmMetrics {
  arm: 'control' | 'treatment';
  writingVersion: string;
  assigned: number;
  sent: number;
  validReplies: number;
  interested: number;
  inquiries: number;
  sampleRequests: number;
  replyRate: number;
  interestedRate: number;
}

export interface ExperimentEvaluationReport {
  id: string;
  name: string;
  brandKey: string;
  status: string;
  observationWindowDays: number;
  minSamplePerArm: number;
  control: ExperimentArmMetrics;
  treatment: ExperimentArmMetrics;
  zScore: number | null;
  pValueApprox: number | null;
  verdict: 'insufficient_sample' | 'no_significant_diff' | 'significant_improvement' | 'significant_regression';
  verdictNote: string;
  strataBreakdown: Record<string, { controlSent: number; controlReplies: number; treatmentSent: number; treatmentReplies: number }>;
}

/** Standard normal survival function approximation (Abramowitz & Stegun) for 2-tailed p-value. */
function twoTailedPValue(z: number): number {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, Math.max(0, Number((2 * p).toFixed(4))));
}

/** Deterministic stratified 50/50 split ensuring balanced cohorts per stratum. */
export function assignExperimentArm(experimentId: string, customerId: string, stratumKey: string): 'control' | 'treatment' {
  const digest = createHash('sha256').update(`${experimentId}|${stratumKey}|${customerId}`).digest();
  return (digest[0] % 2 === 0) ? 'control' : 'treatment';
}

export async function createOutreachExperiment(
  input: {
    name: string;
    controlVersion: string;
    treatmentVersion: string;
    stratifyBy?: ExperimentStratum[];
    observationWindowDays?: number;
    minSamplePerArm?: number;
    customerIds?: string[];
  },
  actor: AuthUser,
) {
  const projectId = requireProjectId(actor);
  const project = await Project.findById(projectId).select('code slug name companyName industry brandProfile').lean();
  if (!project) throw ApiError.notFound('项目不存在');
  const brandKey = resolveProjectSalesProfile(project).key;
  const observationWindowDays = Math.max(3, Math.min(90, input.observationWindowDays ?? 14));
  const minSamplePerArm = Math.max(10, Math.min(1000, input.minSamplePerArm ?? 30));
  const stratifyBy: ExperimentStratum[] = input.stratifyBy?.length ? input.stratifyBy : ['data_tier', 'contact_role'];

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + observationWindowDays * 86_400_000);
  const expId = new Types.ObjectId();

  const assignments: {
    customerId: Types.ObjectId;
    arm: 'control' | 'treatment';
    writingVersion: string;
    stratumKey: string;
    assignedAt: Date;
  }[] = [];

  if (input.customerIds?.length) {
    const validIds = input.customerIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const customers = await Customer.find({ projectId, _id: { $in: validIds } })
      .select('_id email title website interestedProducts')
      .lean();
    // Stratified alternating assignment within each stratum so arm sizes stay balanced
    const stratumCounter = new Map<string, number>();
    for (const c of customers) {
      const tier = classifyCustomerTier({
        email: c.email,
        contactRole: c.title,
        websiteTextLength: c.website ? 400 : 0,
        hasProducts: Boolean(c.interestedProducts),
      });
      const parts = [
        stratifyBy.includes('brand') ? brandKey : '',
        stratifyBy.includes('data_tier') ? (tier === 'sparse' ? 'sparse' : 'rich') : '',
        stratifyBy.includes('contact_role') ? tier : '',
      ].filter(Boolean);
      const stratumKey = parts.join('|') || 'all';
      const idx = stratumCounter.get(stratumKey) ?? 0;
      stratumCounter.set(stratumKey, idx + 1);
      const arm: 'control' | 'treatment' = idx % 2 === 0 ? 'control' : 'treatment';
      assignments.push({
        customerId: c._id,
        arm,
        writingVersion: arm === 'control' ? input.controlVersion : input.treatmentVersion,
        stratumKey,
        assignedAt: startedAt,
      });
    }
  }

  const doc = await OutreachExperiment.create({
    _id: expId,
    projectId,
    name: input.name.trim(),
    brandKey,
    stratifyBy,
    controlVersion: input.controlVersion,
    treatmentVersion: input.treatmentVersion,
    observationWindowDays,
    minSamplePerArm,
    status: 'running',
    startedAt,
    endsAt,
    assignments,
    createdBy: new Types.ObjectId(actor.id),
  });

  return evaluateOutreachExperiment(String(doc._id), actor);
}

export async function listOutreachExperiments(actor: AuthUser) {
  const projectId = requireProjectId(actor);
  const docs = await OutreachExperiment.find({ projectId }).sort({ createdAt: -1 }).limit(30).lean();
  return docs.map((d) => ({
    id: String(d._id),
    name: d.name,
    brandKey: d.brandKey,
    controlVersion: d.controlVersion,
    treatmentVersion: d.treatmentVersion,
    observationWindowDays: d.observationWindowDays,
    minSamplePerArm: d.minSamplePerArm,
    status: d.status,
    assignedCount: d.assignments.length,
    startedAt: d.startedAt,
    endsAt: d.endsAt,
  }));
}

/**
 * Resolve (or deterministically assign) the active running A/B experiment arm
 * for a customer when drafting outreach emails. Returns null when no active
 * experiment is running in this project's observation window.
 */
export async function resolveActiveExperimentAssignment(
  projectId: Types.ObjectId,
  customer: { _id: Types.ObjectId; email?: string; title?: string; website?: string; interestedProducts?: string },
  brandKey = 'general',
  now = new Date(),
): Promise<{ experimentId: string; arm: 'control' | 'treatment'; writingVersion: string; stratumKey: string } | null> {
  const exp = await OutreachExperiment.findOne({
    projectId,
    status: 'running',
    $and: [
      { $or: [{ startedAt: { $exists: false } }, { startedAt: { $lte: now } }] },
      { $or: [{ endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
    ],
  }).sort({ createdAt: -1 }).lean();
  if (!exp) return null;

  const existing = exp.assignments.find((a) => String(a.customerId) === String(customer._id));
  if (existing) {
    return {
      experimentId: String(exp._id),
      arm: existing.arm,
      writingVersion: existing.writingVersion,
      stratumKey: existing.stratumKey,
    };
  }

  const tier = classifyCustomerTier({
    email: customer.email,
    contactRole: customer.title,
    websiteTextLength: customer.website ? 400 : 0,
    hasProducts: Boolean(customer.interestedProducts),
  });
  const parts = [
    exp.stratifyBy.includes('brand') ? (exp.brandKey || brandKey) : '',
    exp.stratifyBy.includes('data_tier') ? (tier === 'sparse' ? 'sparse' : 'rich') : '',
    exp.stratifyBy.includes('contact_role') ? tier : '',
  ].filter(Boolean);
  const stratumKey = parts.join('|') || 'all';
  const arm = assignExperimentArm(String(exp._id), String(customer._id), stratumKey);
  const writingVersion = arm === 'control' ? exp.controlVersion : exp.treatmentVersion;

  // Idempotently persist assignment (capped at 5000 customers per experiment)
  if (exp.assignments.length < 5000) {
    await OutreachExperiment.updateOne(
      { _id: exp._id, projectId, 'assignments.customerId': { $ne: customer._id } },
      {
        $push: {
          assignments: {
            customerId: customer._id,
            arm,
            writingVersion,
            stratumKey,
            assignedAt: now,
          },
        },
      },
    ).catch(() => undefined);
  }

  return { experimentId: String(exp._id), arm, writingVersion, stratumKey };
}

export async function stopOutreachExperiment(experimentId: string, actor: AuthUser): Promise<ExperimentEvaluationReport> {
  if (!Types.ObjectId.isValid(experimentId)) throw ApiError.notFound('实验不存在');
  const projectId = requireProjectId(actor);
  const updated = await OutreachExperiment.findOneAndUpdate(
    { _id: experimentId, projectId },
    { $set: { status: 'completed', endsAt: new Date() } },
    { new: true },
  );
  if (!updated) throw ApiError.notFound('实验不存在或无权访问');
  return evaluateOutreachExperiment(experimentId, actor);
}

export async function evaluateOutreachExperiment(experimentId: string, actor: AuthUser): Promise<ExperimentEvaluationReport> {
  if (!Types.ObjectId.isValid(experimentId)) throw ApiError.notFound('实验不存在');
  const projectId = requireProjectId(actor);
  const exp = await OutreachExperiment.findOne({ _id: experimentId, projectId }).lean();
  if (!exp) throw ApiError.notFound('实验不存在或无权访问');

  const assignmentByCustomer = new Map(exp.assignments.map((a) => [String(a.customerId), a]));
  const customerOids = exp.assignments.map((a) => a.customerId);
  const startedAt = exp.startedAt ?? exp.createdAt;
  const endsAt = exp.endsAt ?? new Date(startedAt.getTime() + exp.observationWindowDays * 86_400_000);

  const letters = customerOids.length
    ? await DevelopmentLetter.find({
      projectId,
      customerId: { $in: customerOids },
      status: { $in: ['sent', 'opened'] },
      sentAt: { $gte: startedAt, $lte: endsAt },
    }).select('_id customerId messageId threadId sentAt automationRuleVersion knowledgeReview.context.writingVersion').lean()
    : [];

  const sentByMsg = new Map<string, (typeof letters)[number]>();
  const sentByThread = new Map<string, (typeof letters)[number][]>();
  for (const l of letters) {
    if (l.messageId) sentByMsg.set(normalizeMsgId(l.messageId), l);
    if (l.threadId) {
      const list = sentByThread.get(l.threadId) ?? [];
      list.push(l);
      sentByThread.set(l.threadId, list);
    }
  }

  const replies = customerOids.length
    ? await MailMessage.find({
      projectId,
      deleted: { $ne: true },
      customerId: { $in: customerOids },
      sentAt: { $gte: startedAt, $lte: new Date(endsAt.getTime() + 7 * 86_400_000) },
    }).select('customerId subject inReplyTo references threadId from text html sentAt').lean()
    : [];

  const initArm = (arm: 'control' | 'treatment', writingVersion: string): ExperimentArmMetrics => ({
    arm,
    writingVersion,
    assigned: exp.assignments.filter((a) => a.arm === arm).length,
    sent: 0,
    validReplies: 0,
    interested: 0,
    inquiries: 0,
    sampleRequests: 0,
    replyRate: 0,
    interestedRate: 0,
  });

  const metrics = {
    control: initArm('control', exp.controlVersion),
    treatment: initArm('treatment', exp.treatmentVersion),
  };
  const strataBreakdown: ExperimentEvaluationReport['strataBreakdown'] = {};
  const ensureStratum = (k: string) => {
    if (!strataBreakdown[k]) strataBreakdown[k] = { controlSent: 0, controlReplies: 0, treatmentSent: 0, treatmentReplies: 0 };
    return strataBreakdown[k];
  };

  const sentCustomers = new Set<string>();
  for (const l of letters) {
    const cid = String(l.customerId);
    const assign = assignmentByCustomer.get(cid);
    if (!assign || sentCustomers.has(cid)) continue;
    sentCustomers.add(cid);
    metrics[assign.arm].sent++;
    const st = ensureStratum(assign.stratumKey);
    if (assign.arm === 'control') st.controlSent++;
    else st.treatmentSent++;
  }

  const repliedCustomers = new Set<string>();
  for (const r of replies) {
    const cid = String(r.customerId);
    const assign = assignmentByCustomer.get(cid);
    if (!assign || !sentCustomers.has(cid) || repliedCustomers.has(cid)) continue;
    const inReply = normalizeMsgId(r.inReplyTo);
    const matched = (inReply && sentByMsg.has(inReply))
      || (Array.isArray(r.references) && r.references.some((ref) => sentByMsg.has(normalizeMsgId(ref))))
      || (r.threadId && (sentByThread.get(r.threadId) ?? []).some((l) => String(l.customerId) === cid));
    if (!matched) continue;
    const classified = classifyReplySignal(r);
    if (!classified.isValidReply) continue;
    repliedCustomers.add(cid);
    metrics[assign.arm].validReplies++;
    if (classified.category === 'interested') metrics[assign.arm].interested++;
    if (classified.isInquiry) metrics[assign.arm].inquiries++;
    if (classified.isSampleRequest) metrics[assign.arm].sampleRequests++;
    const st = ensureStratum(assign.stratumKey);
    if (assign.arm === 'control') st.controlReplies++;
    else st.treatmentReplies++;
  }

  for (const arm of ['control', 'treatment'] as const) {
    const m = metrics[arm];
    m.replyRate = m.sent ? Number((m.validReplies / m.sent).toFixed(4)) : 0;
    m.interestedRate = m.sent ? Number((m.interested / m.sent).toFixed(4)) : 0;
  }

  let zScore: number | null = null;
  let pValueApprox: number | null = null;
  let verdict: ExperimentEvaluationReport['verdict'] = 'insufficient_sample';
  let verdictNote = `每组至少需要 ${exp.minSamplePerArm} 位已发送客户才能判断回复差异是否可信（当前对照 ${metrics.control.sent}，新版 ${metrics.treatment.sent}）。`;

  if (metrics.control.sent >= exp.minSamplePerArm && metrics.treatment.sent >= exp.minSamplePerArm) {
    const n1 = metrics.control.sent;
    const n2 = metrics.treatment.sent;
    const p1 = metrics.control.validReplies / n1;
    const p2 = metrics.treatment.validReplies / n2;
    const pooled = (metrics.control.validReplies + metrics.treatment.validReplies) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se > 0) {
      zScore = Number(((p2 - p1) / se).toFixed(3));
      pValueApprox = twoTailedPValue(zScore);
      if (pValueApprox < 0.05 && zScore > 0) {
        verdict = 'significant_improvement';
        verdictNote = `新版有效回复率显著提升（${(p1 * 100).toFixed(1)}% -> ${(p2 * 100).toFixed(1)}%，p≈${pValueApprox}），差异具有统计可信度。`;
      } else if (pValueApprox < 0.05 && zScore < 0) {
        verdict = 'significant_regression';
        verdictNote = `新版有效回复率显著低于旧版（${(p1 * 100).toFixed(1)}% -> ${(p2 * 100).toFixed(1)}%，p≈${pValueApprox}），建议暂停新版并回切。`;
      } else {
        verdict = 'no_significant_diff';
        verdictNote = `两组回复率差异尚未达到显著水平（p≈${pValueApprox}），建议继续观察或扩大样本。`;
      }
    } else {
      verdict = 'no_significant_diff';
      verdictNote = '两组有效回复数均为 0 或完全相同，尚无显著差异。';
    }
  }

  return {
    id: String(exp._id),
    name: exp.name,
    brandKey: exp.brandKey,
    status: exp.status,
    observationWindowDays: exp.observationWindowDays,
    minSamplePerArm: exp.minSamplePerArm,
    control: metrics.control,
    treatment: metrics.treatment,
    zScore,
    pValueApprox,
    verdict,
    verdictNote,
    strataBreakdown,
  };
}
