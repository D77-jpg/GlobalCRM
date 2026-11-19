import { Types } from 'mongoose';
import { DevelopmentLetter, Project } from '../../models';
import type { AuthUser } from '../../types/express';
import { ApiError } from '../../utils/ApiError';
import { requireProjectId } from '../../utils/access';
import {
  OUTREACH_WRITING_VERSION,
  OUTREACH_WRITING_VERSION_LEGACY,
  resolveProjectSalesProfile,
  SUPPORTED_WRITING_VERSIONS,
} from '../project-profile';
import { automatedReviewIssue } from './knowledge-send-gate';

export type CustomerTierBucket = 'rich' | 'sparse' | 'generic_email' | 'brand_role' | 'procurement_role' | 'unknown';

export interface WritingQualityMetricBucket {
  brandKey: string;
  customerTier: CustomerTierBucket;
  writingVersion: string;
  totalDrafts: number;
  rewrittenCount: number;
  blockedCount: number;
  sendableCount: number;
  rewriteRate: number;
  blockRate: number;
  sendableRate: number;
  avgQualityScore: number | null;
}

export interface WritingReleaseStatus {
  projectId: string;
  brandKey: string;
  activeVersion: string;
  defaultVersion: string;
  previousVersion: string;
  paused: boolean;
  pausedReason?: string;
  supportedVersions: readonly string[];
  windowDays: number;
  metrics: WritingQualityMetricBucket[];
}

export function resolveEffectiveWritingVersion(project?: { brandProfile?: { activeWritingVersion?: string; writingPausedReason?: string } } | null): string {
  if (project?.brandProfile?.writingPausedReason) return OUTREACH_WRITING_VERSION_LEGACY;
  const active = project?.brandProfile?.activeWritingVersion;
  if (active && (SUPPORTED_WRITING_VERSIONS as readonly string[]).includes(active)) return active;
  return OUTREACH_WRITING_VERSION;
}

export function classifyCustomerTier(input: {
  email?: string;
  contactRole?: string;
  websiteTextLength?: number;
  hasProducts?: boolean;
}): CustomerTierBucket {
  const email = (input.email ?? '').trim().toLowerCase();
  if (/^(?:info|hello|hi|sales|contact|support|admin|office|team|enquiries|inquiries)@/i.test(email)) {
    return 'generic_email';
  }
  const role = input.contactRole ?? '';
  if (/\b(?:buyer|procurement|sourcing|purchasing|operations|supply chain)\b|采购|供应链/i.test(role)) {
    return 'procurement_role';
  }
  if (/\b(?:founder|owner|brand|creative|merchandising)\b|创始人|品牌|设计/i.test(role)) {
    return 'brand_role';
  }
  if ((input.websiteTextLength ?? 0) >= 300 || input.hasProducts) {
    return 'rich';
  }
  return 'sparse';
}

export async function getWritingReleaseStatus(actor: AuthUser, windowDays = 30): Promise<WritingReleaseStatus> {
  const projectId = requireProjectId(actor);
  const project = await Project.findById(projectId).select('code slug name companyName industry brandProfile').lean();
  if (!project) throw ApiError.notFound('项目不存在');
  const profile = resolveProjectSalesProfile(project);
  const since = new Date(Date.now() - Math.max(1, Math.min(180, windowDays)) * 86_400_000);

  const letters = await DevelopmentLetter.find({
    projectId: new Types.ObjectId(projectId),
    createdAt: { $gte: since },
    knowledgeReview: { $exists: true },
  })
    .select('outreachStep contentText subject aiSnapshot knowledgeReview automationRuleVersion')
    .sort({ createdAt: -1 })
    .limit(1000)
    .lean();

  const buckets = new Map<string, {
    brandKey: string;
    customerTier: CustomerTierBucket;
    writingVersion: string;
    totalDrafts: number;
    rewrittenCount: number;
    blockedCount: number;
    sendableCount: number;
    scoreSum: number;
    scoreCount: number;
  }>();

  for (const letter of letters) {
    const review = letter.knowledgeReview;
    const version = review?.context?.writingVersion || letter.automationRuleVersion || OUTREACH_WRITING_VERSION_LEGACY;
    const tier: CustomerTierBucket = review?.context?.customerTier ?? 'unknown';
    const key = `${profile.key}|${tier}|${version}`;
    const bucket = buckets.get(key) ?? {
      brandKey: profile.key,
      customerTier: tier,
      writingVersion: version,
      totalDrafts: 0,
      rewrittenCount: 0,
      blockedCount: 0,
      sendableCount: 0,
      scoreSum: 0,
      scoreCount: 0,
    };
    bucket.totalDrafts++;
    const aiText = letter.aiSnapshot?.contentText?.trim();
    const curText = letter.contentText?.trim();
    if (aiText && curText && aiText !== curText) bucket.rewrittenCount++;
    const blocker = automatedReviewIssue(review, letter.outreachStep, {
      bodyText: letter.contentText,
      subject: letter.subject,
      approvedOffers: profile.approvedOffers,
    });
    if (blocker) bucket.blockedCount++;
    else bucket.sendableCount++;
    const qScore = review?.context?.qualityReport?.score;
    if (typeof qScore === 'number') {
      bucket.scoreSum += qScore;
      bucket.scoreCount++;
    }
    buckets.set(key, bucket);
  }

  const metrics: WritingQualityMetricBucket[] = [...buckets.values()].map((b) => ({
    brandKey: b.brandKey,
    customerTier: b.customerTier,
    writingVersion: b.writingVersion,
    totalDrafts: b.totalDrafts,
    rewrittenCount: b.rewrittenCount,
    blockedCount: b.blockedCount,
    sendableCount: b.sendableCount,
    rewriteRate: b.totalDrafts ? Number((b.rewrittenCount / b.totalDrafts).toFixed(4)) : 0,
    blockRate: b.totalDrafts ? Number((b.blockedCount / b.totalDrafts).toFixed(4)) : 0,
    sendableRate: b.totalDrafts ? Number((b.sendableCount / b.totalDrafts).toFixed(4)) : 0,
    avgQualityScore: b.scoreCount ? Number((b.scoreSum / b.scoreCount).toFixed(1)) : null,
  }));

  return {
    projectId: String(projectId),
    brandKey: profile.key,
    activeVersion: resolveEffectiveWritingVersion(project),
    defaultVersion: OUTREACH_WRITING_VERSION,
    previousVersion: OUTREACH_WRITING_VERSION_LEGACY,
    paused: Boolean(project.brandProfile?.writingPausedReason),
    ...(project.brandProfile?.writingPausedReason ? { pausedReason: project.brandProfile.writingPausedReason } : {}),
    supportedVersions: SUPPORTED_WRITING_VERSIONS,
    windowDays,
    metrics,
  };
}

export async function updateWritingRelease(
  input: { action: 'set_version' | 'pause_new' | 'rollback' | 'resume'; version?: string; reason?: string },
  actor: AuthUser,
): Promise<WritingReleaseStatus> {
  if (actor.role !== 'admin') throw ApiError.forbidden('只有项目管理员可以调整写信版本策略');
  const projectId = requireProjectId(actor);
  const update: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.action === 'pause_new') {
    update['brandProfile.activeWritingVersion'] = OUTREACH_WRITING_VERSION_LEGACY;
    update['brandProfile.writingPausedReason'] = (input.reason?.trim() || '管理员暂停新版写法，切回上一版').slice(0, 300);
  } else if (input.action === 'rollback') {
    update['brandProfile.activeWritingVersion'] = OUTREACH_WRITING_VERSION_LEGACY;
    unset['brandProfile.writingPausedReason'] = 1;
  } else if (input.action === 'resume') {
    update['brandProfile.activeWritingVersion'] = OUTREACH_WRITING_VERSION;
    unset['brandProfile.writingPausedReason'] = 1;
  } else if (input.action === 'set_version') {
    if (!input.version || !(SUPPORTED_WRITING_VERSIONS as readonly string[]).includes(input.version)) {
      throw ApiError.badRequest('不支持的写信版本号');
    }
    update['brandProfile.activeWritingVersion'] = input.version;
    unset['brandProfile.writingPausedReason'] = 1;
  }

  await Project.updateOne(
    { _id: new Types.ObjectId(projectId), status: 'active' },
    {
      ...(Object.keys(update).length ? { $set: update } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
  );
  return getWritingReleaseStatus(actor);
}
