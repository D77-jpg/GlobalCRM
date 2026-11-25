import { Types } from 'mongoose';
import { AgentTask } from '../models/AgentTask';
import { AgentKnowledge } from '../models/AgentKnowledge';
import { Customer, DevelopmentLetter, Project, User } from '../models';
import type { ProjectApprovedProofBlock } from '../models/Project';
import { extractSuggestedProofBlocks } from './agent/outreach-tiered-audit';
import { runWithTenant } from '../models/tenant-context';
import { campaignPauseReason, campaignResults } from './outreach-results.service';
import {
  OutreachAutomationConfig,
  OutreachAutomationDay,
  OutreachAutomationEnrollment,
} from '../models/OutreachAutomation';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { customerScope, requireProjectId } from '../utils/access';
import { resolveBuyerTimezone } from '../utils/timezone';
import { createLogger } from '../config/logger';
import { getCurrentMailSender } from './mail-account.service';
import { queueOutreachStep } from './agent/outreach-sequence.service';
import { hasProtectedCustomerMail } from './agent/mail-thread-analysis.service';
import { draftHash, knowledgeFreshness } from './agent/knowledge-grounding';
import {
  automatedReviewIssue,
  extractContextGapWarnings,
  inspectBodyFactAudit,
} from './agent/knowledge-send-gate';
import { workflowLabels } from './agent/evidence-workflow';
import { modelCircuitState } from './agent/model-transport';
import type { FactAuditFailureCategory, FactAuditStage } from './agent/knowledge-types';
import { assertAutomaticDraftCanSend, renderLetter, resendLetter } from './letter.service';
import { splitSignatureText } from './letter-signature';
import { resolveSignerName } from './signer.service';
import {
  countEnglishWords,
  evaluateOutreachDraftQuality,
  extractQuestions,
  FREE_PATTERN,
  SAMPLE_PATTERN,
  SHIPPING_PATTERN,
  splitLongParagraphsText,
  stripSalutationAndSignoff,
  stripUnauthorizedOfferSentences,
} from './agent/outreach-quality';
import {
  cancelPendingOutreachLetters,
  hasInboundReplySince,
  syncOutreachFollowUps,
} from './outreach-followup.service';
import { resolveProjectSalesProfile, type OutreachStep } from './project-profile';

const logger = createLogger('outreach-automation');
const AUTO_TARGET_STATUSES = ['pending', 'contacted'] as const;
const MAX_AUTO_STEPS = 3;
const DAY_MS = 86_400_000;
const TICK_MS = 15_000;
const MAX_QUEUE_ROWS = 200;
export const MAX_INFLIGHT_OUTREACH_TASKS = 3;
const TASK_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000] as const;

const TASK_STEP_LABELS: Record<string, string> = {
  locate_customer: '定位客户',
  research_customer: '分析客户官网',
  analyze_customer: 'AI 生成并核验草稿',
  save_draft: '保存开发信草稿',
  verify_draft: '核对草稿归属',
  ...workflowLabels,
};

export const CIRCUIT_REJECT_CODES = new Set(['OPENAI_CIRCUIT_OPEN', 'OPENAI_CAPACITY']);

export function isCircuitRejectError(error?: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code && CIRCUIT_REJECT_CODES.has(String(error.code))) return true;
  return /熔断|OPENAI_CIRCUIT_OPEN|OPENAI_CAPACITY|并发队列已满/i.test(String(error.message ?? ''));
}

export function isCircuitFailedEnrollmentReason(lastError?: string | null): boolean {
  if (!lastError) return false;
  if (/状态异常|占位符|SMTP|发件箱/.test(lastError)) return false;
  return /熔断|OPENAI_CIRCUIT_OPEN|OPENAI_CAPACITY|并发队列已满/i.test(lastError);
}

export function isAiUpstreamFailedEnrollmentReason(lastError?: string | null): boolean {
  if (!lastError) return false;
  if (/状态异常|占位符|SMTP|发件箱/.test(lastError)) return false;
  return /AI\s*(?:任务|上游|请求|通道)|OPENAI_|HTTP\s*5\d\d|HTTP\s*429|TASK_WORKFLOW_LIMIT|超时|熔断|并发队列已满/i.test(lastError);
}

const FACT_AUDIT_FAILURE_CATEGORY_LABELS: Record<FactAuditFailureCategory, string> = {
  model_call_failed: '模型调用失败',
  output_parse_failed: '输出格式解析失败',
  quote_mismatch: '引用偏移未匹配',
  unsupported_claims: '正文主张缺少依据',
  verifier_disabled: '核验服务未启用',
  evidence_unavailable: '知识依据不可用',
};

const FACT_AUDIT_STAGE_LABELS: Record<FactAuditStage, string> = {
  precheck: '前置检查',
  round0_check: '首轮逐项核验',
  round0_rewrite: '无依据主张重写',
  round1_check: '重写后二轮核验',
  sentence_check: '句级拆分核验',
};

function inferDraftAuditFailure(review?: {
  status?: string;
  issues?: { code?: string; message?: string }[];
  factAudit?: {
    mode?: string;
    checks?: { status?: string; reason?: string }[];
    failureCategory?: FactAuditFailureCategory;
    failureCode?: string;
    failureStage?: FactAuditStage;
    failureDetail?: string;
  };
} | null): {
  failureCategory?: FactAuditFailureCategory;
  failureCategoryLabel?: string;
  failureCode?: string;
  failureStage?: FactAuditStage;
  failureStageLabel?: string;
  failureDetail?: string;
} {
  if (!review) return {};
  const fa = review.factAudit;
  if (fa?.failureCategory) {
    return {
      failureCategory: fa.failureCategory,
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS[fa.failureCategory],
      ...(fa.failureCode ? { failureCode: fa.failureCode } : {}),
      ...(fa.failureStage ? { failureStage: fa.failureStage, failureStageLabel: FACT_AUDIT_STAGE_LABELS[fa.failureStage] } : {}),
      ...(fa.failureDetail ? { failureDetail: fa.failureDetail } : {}),
    };
  }
  const issues = review.issues ?? [];
  const checks = fa?.checks ?? [];
  const failedChecks = checks.filter((c) => c.status !== 'supported' && c.status !== 'non_claim');
  const semanticMsg = issues.find((i) => i.code === 'semantic_unverified')?.message ?? '';
  if (['retrieval_failed', 'index_stale', 'index_not_ready', 'conflict'].includes(String(review.status ?? ''))) {
    return {
      failureCategory: 'evidence_unavailable',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.evidence_unavailable,
      failureCode: String(review.status).toUpperCase(),
      failureDetail: semanticMsg || '知识依据状态异常',
    };
  }
  if (failedChecks.length > 0 && failedChecks.every((c) => /引用里没有能对上|引用片段未能全部精确匹配/.test(String(c.reason ?? '')))) {
    return {
      failureCategory: 'quote_mismatch',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.quote_mismatch,
      failureCode: 'QUOTE_OFFSET_MISMATCH',
      failureDetail: `${failedChecks.length} 处核验引用片段未能精确匹配本次授权证据`,
    };
  }
  if (/语义核验服务未启用/.test(semanticMsg)) {
    return {
      failureCategory: 'verifier_disabled',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.verifier_disabled,
      failureCode: 'VERIFIER_DISABLED',
      failureDetail: semanticMsg,
    };
  }
  if (/JSON|格式|schema|输入.*上限/i.test(semanticMsg)) {
    return {
      failureCategory: 'output_parse_failed',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.output_parse_failed,
      failureDetail: semanticMsg,
    };
  }
  if (/经一次重写仍有无法支持的主张/.test(semanticMsg) || failedChecks.some((c) => c.status === 'unsupported' || c.status === 'contradicted')) {
    return {
      failureCategory: 'unsupported_claims',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.unsupported_claims,
      failureCode: 'UNSUPPORTED_AFTER_REWRITE',
      failureDetail: semanticMsg || '正文存在缺少依据或与证据冲突的主张',
    };
  }
  if (/暂时失败|超时|熔断|502|503|504/.test(semanticMsg) || fa?.mode === 'unavailable') {
    return {
      failureCategory: 'model_call_failed',
      failureCategoryLabel: FACT_AUDIT_FAILURE_CATEGORY_LABELS.model_call_failed,
      failureDetail: semanticMsg || '历史草稿未记录具体失败分层，需重新核验后定位',
    };
  }
  return {};
}

export function humanizeTaskError(error?: { code?: string; message?: string } | null): string {
  if (!error) return '任务执行失败';
  const code = String(error.code ?? '');
  if (code === 'OPENAI_TIMEOUT') return 'AI 请求超时（模型响应超过单次时限）';
  if (code === 'OPENAI_CIRCUIT_OPEN') return 'AI 通道暂时熔断保护中（30 秒后自动探测恢复）';
  if (code === 'OPENAI_CAPACITY') return 'AI 并发队列已满，稍后自动重试';
  if (code === 'TASK_WORKFLOW_LIMIT') return '单次任务累计耗时或重试次数达上限';
  if (/^OPENAI_HTTP_5\d\d$/.test(code)) return `AI 上游服务返回 ${code.replace('OPENAI_HTTP_', 'HTTP ')}（网关暂时不可用）`;
  if (/^OPENAI_HTTP_429$/.test(code)) return 'AI 上游触发限流（HTTP 429）';
  return error.message || code || '任务执行失败';
}

const SUPERSEDED_ARCHIVE_ERROR = '已发起重新生成并核验，原未核验草稿归档保留';
const STALE_SAVED_SEND_ERROR = '发送任务已保存，可在邮件中心查看进度';
const ACTIVE_LETTER_STATUSES = new Set(['draft', 'queued', 'scheduled', 'sending', 'retrying']);
const WAITING_DELIVERY_STATUSES = new Set(['queued', 'scheduled', 'sending', 'retrying']);
const STEP1_CAPABILITY_CATEGORIES = new Set(['company', 'product', 'faq', 'reference']);

function isSupersededArchiveCancellation(letter?: { status?: string; error?: string } | null): boolean {
  return Boolean(letter && letter.status === 'cancelled' && letter.error === SUPERSEDED_ARCHIVE_ERROR);
}

async function hasProjectStep1CapabilityEvidence(
  projectId: Types.ObjectId,
  projectDoc?: { brandProfile?: { approvedProofBlocks?: ProjectApprovedProofBlock[] } } | null,
): Promise<boolean> {
  const proj = projectDoc ?? await Project.findById(projectId).select('brandProfile.approvedProofBlocks').lean();
  const hasProofBlock = (proj?.brandProfile?.approvedProofBlocks ?? []).some(
    (b) => Boolean(b.enabled && String(b.text ?? '').trim()),
  );
  if (hasProofBlock) return true;
  const knowledgeRows = await AgentKnowledge.find({
    projectId,
    approvedVersion: { $gt: 0 },
    archived: { $ne: true },
  }).select('_id approvedVersion revisions').limit(80).lean();
  return knowledgeRows.some((row) => {
    const rev = row.revisions.find((r) => r.version === row.approvedVersion && r.approved);
    if (!rev || !String(rev.content ?? '').trim()) return false;
    return STEP1_CAPABILITY_CATEGORIES.has(String(rev.category ?? 'company'));
  });
}

export function inspectOutreachDraftAudit(letter?: {
  status?: string;
  needsReview?: boolean;
  review?: { decision?: string } | null;
  knowledgeReview?: {
    status?: string;
    completeness?: string;
    issues?: { code?: string; message?: string }[];
    questions?: { status?: string }[];
    factAudit?: {
      mode?: string;
      checks?: { status?: string }[];
    };
  } | null;
} | null): { needsReverify: boolean; reason?: string; contextWarnings: { code: string; message: string }[] } {
  const contextWarnings = extractContextGapWarnings(letter?.knowledgeReview as Parameters<typeof extractContextGapWarnings>[0]);
  if (!letter || letter.status !== 'draft') return { needsReverify: false, contextWarnings };
  // Single source of truth shared with automated send gate: judges ONLY the facts/claims written in the body.
  const audit = inspectBodyFactAudit(
    letter.knowledgeReview as Parameters<typeof inspectBodyFactAudit>[0],
    {
      needsReview: letter.needsReview,
      approved: letter.review?.decision === 'approved',
    },
  );
  return {
    needsReverify: !audit.passed,
    ...(audit.reason ? { reason: audit.reason } : {}),
    contextWarnings: audit.contextWarnings,
  };
}

export function isVerificationBlockedReason(reason?: string | null): boolean {
  if (!reason) return false;
  if (/已回复|退订|退信|拒绝|已删除|归属已变化|不在可开发状态/.test(reason)) return false;
  return /核验|依据审核|依据已变化|模拟校验|缺少依据|partial|unverif/i.test(reason);
}

export type OutreachSendGateCode =
  | 'missing_supplier_evidence'
  | 'offer_unauthorized'
  | 'offer_condition_unmet'
  | 'paragraph_too_long'
  | 'word_count'
  | 'cta_count'
  | 'body_changed'
  | 'stale_knowledge'
  | 'other_send_gate';

export interface OutreachSendGateDetail {
  code: OutreachSendGateCode;
  label: string;
  detail: string;
  guidance: string;
  wordCount?: number;
  paragraphCount?: number;
  maxParagraphWords?: number;
  canStripOffer?: boolean;
  canSplitParagraphs?: boolean;
  canRecheck?: boolean;
}

export interface OutreachDraftAuditDetail {
  completeness?: string;
  factAuditMode?: string;
  failureCategory?: string;
  failureCategoryLabel?: string;
  failureCode?: string;
  failureStage?: string;
  failureStageLabel?: string;
  failureDetail?: string;
  summary: string;
  checksTotal: number;
  checksFailed: number;
  failedChecks: { id: string; status: string; excerpt: string; reason: string }[];
  rebuiltAndFailedAgain?: boolean;
  previousError?: string;
}

function classifySendGateDetail(
  issueMessage: string,
  letter?: { contentText?: string; subject?: string; outreachStep?: number; knowledgeReview?: unknown } | null,
  signature?: ReturnType<typeof resolveProjectSalesProfile>['signature'],
  approvedOffers?: Parameters<typeof automatedReviewIssue>[2] extends infer O
    ? O extends { approvedOffers?: infer A } ? A : undefined
    : undefined,
): OutreachSendGateDetail {
  const rawBody = String(letter?.contentText ?? '');
  const cleanBody = signature && rawBody ? splitSignatureText(rawBody, signature).body : rawBody;
  const quality = cleanBody
    ? evaluateOutreachDraftQuality({
      bodyText: cleanBody,
      subject: letter?.subject,
      step: letter?.outreachStep ?? 1,
      approvedOffers,
      review: letter?.knowledgeReview as Parameters<typeof evaluateOutreachDraftQuality>[0]['review'],
    })
    : undefined;

  if (/首封缺少已发布的我方能力依据/.test(issueMessage)) {
    return {
      code: 'missing_supplier_evidence',
      label: '首封缺少已发布我方能力依据',
      detail: issueMessage,
      guidance: '首封需至少引用 1 条已发布的公司产能、资质认证（如 ISO/CE）、产品规格或 OEM/ODM 交付依据。可在下方添加/启用英文「已批准证据块」，或在知识库发布对应文档后点「单条重建」。',
      canRecheck: true,
    };
  }
  if (/寄样\/色卡|免费承诺|运费\/快递|未授权|授权条件不满足|未获授权/.test(issueMessage)) {
    const conditionUnmet = /条件不满足|requiresEvidence|缺少依据/.test(issueMessage);
    return {
      code: conditionUnmet ? 'offer_condition_unmet' : 'offer_unauthorized',
      label: conditionUnmet ? '寄样/色卡或优惠授权条件不满足' : '寄样/色卡或优惠提议未获授权',
      detail: issueMessage,
      guidance: conditionUnmet
        ? '项目已启用对应授权，但要求附带已发布知识依据而当前草稿未匹配到依据。可直接点「删除提议后重检」移除该句，或补充依据后重建。'
        : '当前项目未开启该寄样/色卡/免费/运费授权。可直接点「删除提议后重检」移除该句并立即重检，或先在项目设置开启授权后点「重检」。',
      canStripOffer: true,
      canRecheck: true,
    };
  }
  if (/存在过长段落/.test(issueMessage)) {
    return {
      code: 'paragraph_too_long',
      label: quality
        ? `存在过长段落（单段 ${quality.maxParagraphWords} 词，共 ${quality.paragraphCount} 段）`
        : '存在过长段落',
      detail: issueMessage,
      guidance: '建议将正文改写拆分为 2–3 个短段落（单段建议 ≤ 52 词、硬上限 68 词），可直接点「拆段并重检」或去编辑分段后重检。',
      wordCount: quality?.wordCount,
      paragraphCount: quality?.paragraphCount,
      maxParagraphWords: quality?.maxParagraphWords,
      canSplitParagraphs: true,
      canRecheck: true,
    };
  }
  if (/字数超界|正文过短|正文过长/.test(issueMessage)) {
    return {
      code: 'word_count',
      label: quality ? `正文字数超界（${quality.wordCount} 词）` : '正文字数超界',
      detail: issueMessage,
      guidance: '请精简或补充正文至对应步骤建议词数后点「重检」，或点「单条重建」由模型重新生成。',
      wordCount: quality?.wordCount,
      paragraphCount: quality?.paragraphCount,
      canRecheck: true,
    };
  }
  if (/回复问题|CTA|提问负担/.test(issueMessage)) {
    return {
      code: 'cta_count',
      label: '回复提问（CTA）不符合规则',
      detail: issueMessage,
      guidance: '第 1、2 封应保留 1 个轻量明确的回复问题；请调整后点「重检」或「单条重建」。',
      canRecheck: true,
    };
  }
  if (/bodyHash|正文核验指纹|发生变化/.test(issueMessage)) {
    return {
      code: 'body_changed',
      label: '正文在核验后发生修改',
      detail: issueMessage,
      guidance: '草稿修改后与核验指纹不一致，请点「单条重建」或重新完成核验。',
      canRecheck: true,
    };
  }
  if (/依据已更新|过期|新鲜度/.test(issueMessage)) {
    return {
      code: 'stale_knowledge',
      label: '引用的知识依据已更新',
      detail: issueMessage,
      guidance: '草稿引用的知识条目在生成后有更新，请点「单条重建」按最新知识依据重核。',
      canRecheck: true,
    };
  }
  return {
    code: 'other_send_gate',
    label: '其他发送检查未通过',
    detail: issueMessage,
    guidance: '请对照具体拦截原因处理后点击「重检」或「单条重建」。',
    canRecheck: true,
  };
}

function buildDraftAuditDetail(
  letter: {
    updatedAt?: Date | string;
    knowledgeReview?: {
      status?: string;
      completeness?: string;
      issues?: { code?: string; message?: string }[];
      factAudit?: {
        mode?: string;
        checks?: { id?: string; text?: string; status?: string; reason?: string }[];
        failureCategory?: FactAuditFailureCategory;
        failureCode?: string;
        failureStage?: FactAuditStage;
        failureDetail?: string;
      };
    } | null;
  } | null | undefined,
  auditReason: string | undefined,
  errorHistory: { at: Date | string; message: string; resolvedReason?: string }[],
  enrollmentLastError?: string,
): OutreachDraftAuditDetail | undefined {
  if (!letter) return undefined;
  const review = letter.knowledgeReview;
  const checks = review?.factAudit?.checks ?? [];
  const rawFailed = checks.filter((c) => c.status !== 'supported' && c.status !== 'non_claim');
  const failedChecks = rawFailed.slice(0, 5).map((c, idx) => ({
    id: String(c.id ?? `s${idx}`),
    status: String(c.status ?? 'unverifiable'),
    excerpt: String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    reason: String(c.reason || '未提供原因'),
  }));
  const failureInfo = inferDraftAuditFailure(review ?? undefined);
  const completeness = review?.completeness;
  const factAuditMode = review?.factAudit?.mode;

  let summary = '';
  if (failedChecks.length > 0) {
    const first = failedChecks[0]!;
    const statusText = first.status === 'contradicted'
      ? '与依据冲突'
      : first.status === 'unsupported'
        ? '缺少依据（unsupported）'
        : '无法核验（unverifiable）';
    summary = `${completeness === 'partial' ? '仅部分核验（partial）· ' : ''}${rawFailed.length} 句未通过（${statusText}：“${first.excerpt}”${first.reason ? ` — ${first.reason}` : ''}）`;
  } else if (failureInfo.failureDetail) {
    summary = `${failureInfo.failureStageLabel ? `[${failureInfo.failureStageLabel}] ` : ''}${failureInfo.failureCategoryLabel ? `${failureInfo.failureCategoryLabel}：` : ''}${failureInfo.failureDetail}`;
  } else if (completeness === 'partial') {
    summary = '核验只完成了一部分（completeness=partial），未形成完整逐项依据结论';
  } else {
    summary = auditReason || '正文尚未完成核验';
  }

  const priorMessages = errorHistory.map((item) => item.message).filter(Boolean);
  const previousDiffers = Boolean(
    (priorMessages.length > 0 && priorMessages[priorMessages.length - 1] !== summary)
    || (enrollmentLastError && enrollmentLastError !== summary && enrollmentLastError !== auditReason),
  );
  const rebuiltAndFailedAgain = errorHistory.length > 0 || previousDiffers;

  return {
    ...(completeness ? { completeness } : {}),
    ...(factAuditMode ? { factAuditMode } : {}),
    ...failureInfo,
    summary,
    checksTotal: checks.length,
    checksFailed: rawFailed.length,
    failedChecks,
    ...(rebuiltAndFailedAgain ? {
      rebuiltAndFailedAgain: true,
      ...(priorMessages.length > 0 ? { previousError: priorMessages[priorMessages.length - 1] } : {}),
    } : {}),
  };
}

export interface OutreachAutomationConfigDto {
  rolloutMode: 'shadow' | 'pilot' | 'active';
  legacyModeUnset?: boolean;
  id: string;
  enabled: boolean;
  pausedReason?: string;
  dailyLimit: number;
  perDomainLimit: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  useBuyerTimezone: boolean;
  minPacingSeconds: number;
  maxPacingSeconds: number;
  version: number;
}

export type OutreachDraftStage =
  | 'reverify_queued'
  | 'waiting_model'
  | 'draft_saved_verified'
  | 'draft_audit_failed'
  | 'waiting_delivery'
  | 'delivery_cancelled'
  | 'task_failed'
  | 'delivery_failed'
  | 'none';

export interface OutreachAutomationQueueRow {
  id: string;
  customerId: string;
  customerName: string;
  company?: string;
  email?: string;
  customerStatus: string;
  status: string;
  /** 实际已发送的开发信封数（以客户开发信记录为准）。 */
  currentStep: number;
  actualStep: number;
  nextStep: number;
  /** waiting=等待下一次；generating=准备草稿；ready=待发送；sending=发送中；due=到期待处理。 */
  phase: 'waiting' | 'generating' | 'ready' | 'sending' | 'due' | 'paused' | 'blocked' | 'completed' | 'failed';
  /** 明确区分草稿/核验/任务执行/等待投递/已取消/SMTP 投递失败阶段。 */
  draftStage: OutreachDraftStage;
  /** 实际邮件投递状态：等待投递 / 已取消 / 投递失败 / 已发送。 */
  deliveryStatus?: 'waiting_delivery' | 'cancelled' | 'failed' | 'sent';
  draftReady: boolean;
  draftId?: string;
  draftNeedsReverify?: boolean;
  draftAuditReason?: string;
  draftAuditDetail?: OutreachDraftAuditDetail;
  sendGateDetail?: OutreachSendGateDetail;
  /** 背景资料缺口提醒（未写入正文，不拦截发送）。 */
  contextWarnings?: { code: string; message: string }[];
  pausedReadyToResume?: boolean;
  deliveryError?: string;
  failedLetterId?: string;
  cancelledLetterId?: string;
  cancelledReason?: string;
  isRuleStopped?: boolean;
  errorHistory?: { at: string; step?: number; message: string; resolvedAt?: string; resolvedReason?: string }[];
  draftUpdatedAt?: string;
  taskId?: string;
  taskStatus?: string;
  taskStep?: string;
  taskStepLabel?: string;
  taskError?: string;
  taskErrorCode?: string;
  taskRetryAt?: string;
  taskDurationMs?: number;
  effectiveTimezone: string;
  timezoneSource: 'explicit' | 'country' | 'fallback';
  recipientWindowOpen: boolean;
  nextRunAt: string;
  lastError?: string;
  lastSentAt?: string;
}

export interface OutreachAutomationRecentRow {
  letterId: string;
  customerId: string;
  customerName: string;
  step: number;
  sentAt: string;
  status: string;
}

export interface OutreachAutomationOverview {
  config: OutreachAutomationConfigDto;
  windowOpen: boolean;
  circuit: {
    open: boolean;
    openCount: number;
    cooldownRemainingMs: number;
  };
  mailbox: {
    email: string;
    displayName: string;
    channel: 'mock' | 'smtp';
    canSend: boolean;
    reason?: string;
    usedToday: number;
    dailyLimit: number;
    warmup?: {
      enabled: boolean;
      effectiveLimit: number;
      activeSendDays: number;
      recentSentCount: number;
      recentHardBounceCount: number;
      cooledDownUntil?: Date;
      reason?: string;
    };
  } | null;
  stats: {
    eligible: number;
    enrolled: number;
    active: number;
    paused: number;
    completed: number;
    blocked: number;
    ruleStopped: number;
    failed: number;
    circuitFailed: number;
    aiFailed: number;
    unverifiedDrafts: number;
    rebuildableUnverifiedDrafts: number;
    sendGateBlockedDrafts: number;
    contextWarningDrafts: number;
    pausedReadyCount: number;
    deliveryFailedCount: number;
    deliveryCancelledCount: number;
    exceptionQueueCount: number;
    approvedProofBlocksCount: number;
    queuedTasks: number;
    runningTasks: number;
    retryingTasks: number;
    activeFailedTasks: number;
    historicalFailedTasks: number;
    failedTasks: number;
    sentToday: number;
    remainingToday: number;
  };
  queue: OutreachAutomationQueueRow[];
  recent: OutreachAutomationRecentRow[];
}

export interface OutreachAutomationConfigInput {
  rolloutMode?: OutreachAutomationConfigDto['rolloutMode'];
  expectedVersion: number;
  dailyLimit: number;
  perDomainLimit: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  useBuyerTimezone?: boolean;
  minPacingSeconds?: number;
  maxPacingSeconds?: number;
}

const dayFormatter = (timezone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
};

const timeFormatter = (timezone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  }
};

export function dayIn(timezone: string, now = new Date()): string {
  return dayFormatter(timezone).format(now);
}

export function localClock(timezone: string, now = new Date()): { minutes: number; weekday: number } {
  const parts = timeFormatter(timezone).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes: hour * 60 + minute, weekday: weekdayMap[weekdayName] ?? 1 };
}

export function isWithinSendWindow(
  config: Pick<OutreachAutomationConfigDto, 'windowStart' | 'windowEnd' | 'timezone'> & { workdays?: number[] },
  now = new Date(),
): boolean {
  const { minutes, weekday } = localClock(config.timezone, now);
  const workdays = config.workdays ?? [1, 2, 3, 4, 5];
  if (!workdays.includes(weekday)) return false;
  const [startHour, startMinute] = config.windowStart.split(':').map(Number);
  const [endHour, endMinute] = config.windowEnd.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

/** 下一个实际可发送的时间；周末/非当地工作日和夜间会顺延到下一个工作日时段（自动兼容夏令时）。 */
export function nextSendWindow(
  config: Pick<OutreachAutomationConfigDto, 'windowStart' | 'windowEnd' | 'timezone'> & { workdays?: number[] },
  from: Date,
): Date {
  const startAt = new Date(from);
  for (let minute = 0; minute <= 8 * 24 * 60; minute += 1) {
    const candidate = new Date(startAt.getTime() + minute * 60_000);
    if (isWithinSendWindow(config, candidate)) return candidate;
  }
  return startAt;
}

function configDto(doc: InstanceType<typeof OutreachAutomationConfig>): OutreachAutomationConfigDto {
  return {
    id: String(doc._id),
    enabled: doc.enabled,
    rolloutMode: doc.rolloutMode ?? 'active',
    ...(!doc.rolloutMode ? { legacyModeUnset: true } : {}),
    ...(doc.pausedReason ? { pausedReason: doc.pausedReason } : {}),
    dailyLimit: Number(doc.dailyLimit),
    perDomainLimit: Number(doc.perDomainLimit),
    windowStart: doc.windowStart,
    windowEnd: doc.windowEnd,
    timezone: doc.timezone,
    useBuyerTimezone: Boolean(doc.useBuyerTimezone),
    minPacingSeconds: Number(doc.minPacingSeconds ?? 90),
    maxPacingSeconds: Number(doc.maxPacingSeconds ?? 240),
    version: Number(doc.version),
  };
}

function scope(actor: AuthUser, targetUserId?: string) {
  return {
    projectId: new Types.ObjectId(requireProjectId(actor)),
    userId: new Types.ObjectId(targetUserId ?? actor.id),
  };
}

async function resolveTargetUser(actor: AuthUser, targetUserId?: string): Promise<{ id: string; role: 'admin' | 'user' }> {
  if (!targetUserId || targetUserId === actor.id) {
    return { id: actor.id, role: actor.role === 'admin' ? 'admin' : 'user' };
  }
  if (actor.role !== 'admin') throw ApiError.forbidden('只有管理员可以管理其他业务员的自动开发');
  if (!/^[a-f\d]{24}$/i.test(targetUserId)) throw ApiError.badRequest('业务员 ID 格式不正确');
  const user = await User.findOne({ _id: targetUserId, status: 'active' }).select('role projectIds');
  if (!user) throw ApiError.notFound('业务员不存在或已停用');
  if (user.role !== 'admin' && !user.projectIds.some((id) => String(id) === String(requireProjectId(actor)))) {
    throw ApiError.notFound('该业务员不在当前项目中');
  }
  return { id: String(user._id), role: user.role === 'admin' ? 'admin' : 'user' };
}

async function getConfig(actor: AuthUser, targetUserId?: string) {
  const target = await resolveTargetUser(actor, targetUserId);
  const base = scope(actor, target.id);
  const existing = await OutreachAutomationConfig.findOne(base);
  if (existing) return existing;
  try {
    return await OutreachAutomationConfig.create({
      ...base,
      actorRole: target.role,
      enabled: false,
      dailyLimit: 20,
      rolloutMode: 'shadow',
      perDomainLimit: 3,
      windowStart: '09:30',
      windowEnd: '17:30',
      timezone: 'Asia/Shanghai',
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const raced = await OutreachAutomationConfig.findOne(base);
    if (!raced) throw ApiError.internal('自动开发配置创建失败');
    return raced;
  }
}

function eligibleFilter(actor: AuthUser, targetUserId?: string) {
  return {
    ...customerScope(actor),
    ownerId: new Types.ObjectId(targetUserId ?? actor.id),
    email: { $exists: true, $ne: '' },
    status: { $in: [...AUTO_TARGET_STATUSES] },
    outreachAbandonedAt: null,
    outreachRepliedAt: null,
    // 待开发客户可以开始首封；已经标记为「已联系」的客户只有在确实
    // 发过开发信或已有序列进度时才进入自动开发，避免把邮件来访、
    // 手动沟通过的客户误判成需要再发首封开发信。
    $and: [
      {
        $or: [
          { status: 'pending' },
          { status: 'contacted', letterCount: { $gt: 0 } },
          { status: 'contacted', outreachStep: { $gte: 1 } },
        ],
      },
      { $or: [{ outreachStep: { $lt: MAX_AUTO_STEPS } }, { outreachStep: { $exists: false } }] },
    ],
  };
}


async function getActorForConfig(doc: InstanceType<typeof OutreachAutomationConfig>): Promise<AuthUser> {
  const [user, project] = await Promise.all([
    User.findById(doc.userId).select('username displayName role status projectIds organizationId'),
    Project.findById(doc.projectId).select('status organizationId'),
  ]);
  if (!user || user.status === 'disabled' || user.role === 'viewer' || !project || project.status !== 'active'
    || (project.organizationId && String(project.organizationId) !== String(user.organizationId))) {
    throw new Error('当前账号或项目已停用');
  }
  if (user.role !== 'admin' && !user.projectIds.some((id) => String(id) === String(doc.projectId))) {
    throw new Error('当前账号已不在该项目中');
  }
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName,
    role: doc.actorRole === 'admin' && user.role === 'admin' ? 'admin' : 'user',
    projectId: String(doc.projectId),
    organizationId: project.organizationId?.toString(),
  };
}

async function reserveDay(
  projectId: Types.ObjectId,
  campaignId: Types.ObjectId,
  timezone: string,
  dailyLimit: number,
  now: Date,
): Promise<boolean> {
  const day = dayIn(timezone, now);
  let bucket = await OutreachAutomationDay.findOne({ campaignId, day });
  if (!bucket) {
    try {
      bucket = await OutreachAutomationDay.create({ projectId, campaignId, day, sent: 0 });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  if (!bucket) return false;
  const reserved = await OutreachAutomationDay.findOneAndUpdate(
    { campaignId, day, sent: { $lt: dailyLimit } },
    { $inc: { sent: 1 } },
    { new: true },
  );
  return Boolean(reserved);
}

async function releaseDay(campaignId: Types.ObjectId, timezone: string, now: Date): Promise<void> {
  await OutreachAutomationDay.updateOne(
    { campaignId, day: dayIn(timezone, now), sent: { $gt: 0 } },
    { $inc: { sent: -1 } },
  );
}

async function domainAtLimit(campaignId: Types.ObjectId, email: string, limit: number, now: Date): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  const letters = await DevelopmentLetter.find({
    automationCampaignId: campaignId,
    status: { $in: ['sent', 'opened'] },
    sentAt: { $gte: new Date(now.getTime() - DAY_MS) },
  }).select('recipientEmail').lean();
  return letters.filter((letter) => String(letter.recipientEmail).toLowerCase().endsWith(`@${domain}`)).length >= limit;
}

/** Compute next randomized staggered send interval (seconds) within [min, max]. */
export function nextRandomizedPacingMs(minSeconds = 90, maxSeconds = 240, rng = Math.random): number {
  const lo = Math.max(30, Math.trunc(minSeconds));
  const hi = Math.max(lo, Math.trunc(maxSeconds));
  const jitter = lo + Math.floor(rng() * (hi - lo + 1));
  return jitter * 1000;
}

/** Keep a randomized staggered interval between automatic sends, even if many rows are due. */
async function campaignPacingReady(
  config: Pick<InstanceType<typeof OutreachAutomationConfig>, '_id' | 'nextPacingAt' | 'minPacingSeconds'>,
  now: Date,
): Promise<boolean> {
  if (config.nextPacingAt && now.getTime() < new Date(config.nextPacingAt).getTime()) return false;
  const last = await DevelopmentLetter.findOne({
    automationCampaignId: config._id,
    status: { $in: ['sent', 'opened', 'queued', 'scheduled', 'sending', 'retrying'] },
  }).sort({ sentAt: -1, createdAt: -1 }).select('createdAt sentAt').lean();
  const at = last?.sentAt ?? last?.createdAt;
  const minFloorMs = Math.max(60_000, Number(config.minPacingSeconds ?? 60) * 1000);
  return !at || now.getTime() - new Date(at).getTime() >= minFloorMs;
}

async function ensureEnrollment(
  campaignId: Types.ObjectId,
  actor: AuthUser,
  customer: { _id: Types.ObjectId; outreachStep?: number; nextFollowUpAt?: Date },
  now: Date,
  ownerId: Types.ObjectId,
) {
  const existing = await OutreachAutomationEnrollment.findOne({ campaignId, customerId: customer._id });
  if (existing) {
    if (['paused', 'failed'].includes(existing.status)) {
      await OutreachAutomationEnrollment.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'active',
            nextRunAt: now,
            lastError: null,
            attempts: 0,
          },
        },
      );
    }
    return existing;
  }
  try {
    return await OutreachAutomationEnrollment.create({
      projectId: new Types.ObjectId(requireProjectId(actor)),
      campaignId,
      userId: ownerId,
      customerId: customer._id,
      status: 'active',
      currentStep: Number(customer.outreachStep ?? 0),
      nextRunAt: customer.nextFollowUpAt && new Date(customer.nextFollowUpAt) > now ? customer.nextFollowUpAt : now,
      taskIds: [],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const raced = await OutreachAutomationEnrollment.findOne({ campaignId, customerId: customer._id });
    if (!raced) throw ApiError.internal('自动开发队列创建失败');
    return raced;
  }
}

export async function getOutreachAutomationOverview(actor: AuthUser, targetUserId?: string): Promise<OutreachAutomationOverview> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const mailbox = await getCurrentMailSender(String(requireProjectId(actor)), target.id);
  const projectFilter = { ...scope(actor, target.id), campaignId: config._id };
  const now = new Date();
  const [rows, grouped, recentLetters, enrolledCustomerIds] = await Promise.all([
    OutreachAutomationEnrollment.find(projectFilter)
      .sort({ nextRunAt: 1, updatedAt: -1 })
      .limit(MAX_QUEUE_ROWS)
      .lean(),
    OutreachAutomationEnrollment.aggregate<{ _id: string; count: number }>([
      { $match: projectFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    DevelopmentLetter.find({
      projectId: config.projectId,
      automationCampaignId: config._id,
      status: { $in: ['sent', 'opened'] },
    }).sort({ sentAt: -1 }).limit(12).select('_id customerId outreachStep sentAt status createdAt').lean(),
    OutreachAutomationEnrollment.distinct('customerId', projectFilter),
  ]);
  const eligible = await Customer.countDocuments({
    ...eligibleFilter(actor, target.id),
    ...(enrolledCustomerIds.length ? { _id: { $nin: enrolledCustomerIds } } : {}),
  });

  const customerIds = [...new Set([...rows.map((row) => String(row.customerId)), ...recentLetters.map((letter) => String(letter.customerId))])]
    .filter((id) => /^[a-f\d]{24}$/i.test(id))
    .map((id) => new Types.ObjectId(id));
  const customers = customerIds.length
    ? await Customer.find({ _id: { $in: customerIds }, projectId: config.projectId })
      .select('name company email status ownerId outreachAbandonedAt outreachRepliedAt outreachLastAt letterCount outreachStep nextFollowUpAt timezone country address phone')
      .lean()
    : [];
  const customerMap = new Map(customers.map((customer) => [String(customer._id), customer]));
  const queueCustomerIds = rows.map((row) => row.customerId);
  const queueNextSteps = [...new Set(rows.map((row) => {
    const customer = customerMap.get(String(row.customerId));
    const actualStep = Math.min(
      MAX_AUTO_STEPS,
      Math.max(
        Number(customer?.outreachStep ?? 0),
        Math.min(MAX_AUTO_STEPS, Number(customer?.letterCount ?? 0)),
        Number(row.currentStep ?? 0),
      ),
    );
    return Math.min(MAX_AUTO_STEPS, actualStep + 1);
  }))];
  const [queueLetters, queueTasks, taskStatusCounts] = await Promise.all([
    queueCustomerIds.length
      ? DevelopmentLetter.find({
        projectId: config.projectId,
        customerId: { $in: queueCustomerIds },
        outreachStep: { $in: queueNextSteps },
        status: { $in: ['draft', 'queued', 'scheduled', 'sending', 'retrying', 'failed', 'cancelled'] },
      })
        .sort({ createdAt: -1 })
        .select('_id customerId outreachStep status subject contentText error needsReview review knowledgeReview updatedAt createdAt')
        .lean()
      : Promise.resolve([]),
    queueCustomerIds.length
      ? AgentTask.find({
        projectId: config.projectId,
        userId: config.userId,
        customerId: { $in: queueCustomerIds },
        outreachStep: { $in: queueNextSteps },
        status: { $in: ['queued', 'running', 'paused', 'waiting_input', 'awaiting_review', 'failed'] },
      })
        .sort({ createdAt: -1 })
        .select('_id customerId outreachStep status currentStep error attempts workflowActiveMs createdAt updatedAt')
        .lean()
      : Promise.resolve([]),
    AgentTask.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          projectId: config.projectId,
          userId: config.userId,
          outreachStep: { $in: [1, 2, 3] },
          status: { $in: ['queued', 'running', 'failed'] },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);
  const taskTotals = taskStatusCounts.reduce<Record<string, number>>((acc, item) => {
    acc[String(item._id)] = Number(item.count);
    return acc;
  }, {});
  const queueLetterMap = new Map<string, (typeof queueLetters)[number]>();
  for (const letter of queueLetters) {
    // Ignore superseded reverify-archive cancellations so rebuilding a draft doesn't masquerade as a cancelled delivery.
    if (isSupersededArchiveCancellation(letter)) continue;
    const key = `${String(letter.customerId)}:${Number(letter.outreachStep)}`;
    const existing = queueLetterMap.get(key);
    if (!existing) {
      queueLetterMap.set(key, letter);
    } else if (!ACTIVE_LETTER_STATUSES.has(String(existing.status)) && ACTIVE_LETTER_STATUSES.has(String(letter.status))) {
      queueLetterMap.set(key, letter);
    }
  }
  const queueTaskMap = new Map<string, (typeof queueTasks)[number]>();
  for (const task of queueTasks) {
    const key = `${String(task.customerId)}:${Number(task.outreachStep)}`;
    const existing = queueTaskMap.get(key);
    if (!existing) {
      queueTaskMap.set(key, task);
    } else if ((task.status === 'running' || task.status === 'queued') && existing.status !== 'running' && existing.status !== 'queued') {
      queueTaskMap.set(key, task);
    }
  }
  const counts = grouped.reduce<Record<string, number>>((acc, row) => {
    acc[String(row._id)] = Number(row.count);
    return acc;
  }, {});
  const enrolled = grouped.reduce((total, row) => total + Number(row.count), 0);
  const sentTodayBucket = await OutreachAutomationDay.findOne({ campaignId: config._id, day: dayIn(config.timezone, now) }).lean();
  const sentToday = Number(sentTodayBucket?.sent ?? 0);
  const cfgDto = configDto(config);
  const windowOpen = isWithinSendWindow(cfgDto, now);
  const circuit = modelCircuitState();

  const circuitFailedCount = await OutreachAutomationEnrollment.countDocuments({
    ...projectFilter,
    status: 'failed',
    lastError: { $regex: /熔断|OPENAI_CIRCUIT_OPEN|OPENAI_CAPACITY|并发队列已满/i },
  });
  const aiFailedCount = await OutreachAutomationEnrollment.countDocuments({
    ...projectFilter,
    status: 'failed',
    lastError: {
      $regex: /AI\s*(?:任务|上游|请求|通道)|OPENAI_|HTTP\s*5\d\d|HTTP\s*429|TASK_WORKFLOW_LIMIT|超时|熔断|并发队列已满/i,
      $not: /状态异常|占位符|SMTP|发件箱/,
    },
  });
  const projectDoc = await Project.findById(config.projectId)
    .select('code slug name companyName industry website mailFrom senderName brandProfile')
    .lean();
  const approvedProofBlocksCount = (projectDoc?.brandProfile?.approvedProofBlocks ?? []).filter((b) => b.enabled && b.text?.trim()).length;
  const projectSignature = resolveProjectSalesProfile(projectDoc).signature;
  const projectApprovedOffers = projectDoc?.brandProfile?.approvedOffers;

  let unverifiedDrafts = 0;
  let rebuildableUnverifiedDrafts = 0;
  let sendGateBlockedDrafts = 0;
  let contextWarningDrafts = 0;
  let pausedReadyCount = 0;
  let deliveryFailedCount = 0;
  let deliveryCancelledCount = 0;
  let activeFailedTasks = 0;
  let retryingTasks = 0;
  let ruleStoppedCount = 0;
  let exceptionQueueCount = 0;
  const staleErrorOps: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];

  const queueRows: OutreachAutomationQueueRow[] = rows.map((row) => {
    const customer = customerMap.get(String(row.customerId));
    const actualStep = Math.min(
      MAX_AUTO_STEPS,
      Math.max(
        Number(customer?.outreachStep ?? 0),
        Math.min(MAX_AUTO_STEPS, Number(customer?.letterCount ?? 0)),
        Number(row.currentStep ?? 0),
      ),
    );
    const nextStep = Math.min(MAX_AUTO_STEPS, actualStep + 1);
    const key = `${String(row.customerId)}:${nextStep}`;
    const nextLetter = queueLetterMap.get(key);
    const nextLetterStatus = nextLetter ? String(nextLetter.status) : undefined;
    const isRuleStopped = row.status === 'blocked' && !isVerificationBlockedReason(row.lastError);
    if (isRuleStopped) ruleStoppedCount += 1;

    const audit = row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS && nextLetterStatus === 'draft'
      ? inspectOutreachDraftAudit(nextLetter)
      : { needsReverify: false, contextWarnings: [] };
    const rowSendGateIssue = row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS && nextLetterStatus === 'draft' && !audit.needsReverify
      ? automatedReviewIssue(nextLetter?.knowledgeReview, nextLetter?.outreachStep, {
        bodyText: nextLetter?.contentText,
        subject: nextLetter?.subject,
        approvedOffers: projectApprovedOffers,
        signature: projectSignature,
      })
      : undefined;
    const draftBlockedFromAutoSend = audit.needsReverify || Boolean(rowSendGateIssue);
    const draftReady = nextLetterStatus === 'draft' && !draftBlockedFromAutoSend;
    const latestTask = queueTaskMap.get(key);
    const taskStatus = latestTask ? String(latestTask.status) : undefined;
    const taskInFlight = taskStatus === 'queued' || taskStatus === 'running';
    const isWaitingDelivery = row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS && WAITING_DELIVERY_STATUSES.has(nextLetterStatus ?? '') && !taskInFlight;
    const isDeliveryCancelled = row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS && nextLetterStatus === 'cancelled' && !taskInFlight;
    const isDeliveryFailed = row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS && nextLetterStatus === 'failed' && !taskInFlight;
    const deliveryStatus: OutreachAutomationQueueRow['deliveryStatus'] = (row.status === 'completed' || actualStep >= MAX_AUTO_STEPS)
      ? 'sent'
      : isWaitingDelivery
        ? 'waiting_delivery'
        : isDeliveryCancelled
          ? 'cancelled'
          : isDeliveryFailed
            ? 'failed'
            : undefined;
    const cancelledReason = isDeliveryCancelled
      ? String(nextLetter?.error || '该邮件已取消（未发送），不会再继续投递')
      : undefined;

    const rawErrorHistory = Array.isArray((row as { errorHistory?: unknown[] }).errorHistory)
      ? ((row as { errorHistory?: Array<{ at: Date; step?: number; message: string; resolvedAt?: Date; resolvedReason?: string }> }).errorHistory ?? [])
      : [];
    const errorHistoryDto = rawErrorHistory.slice(-5).map((item) => ({
      at: new Date(item.at).toISOString(),
      ...(item.step ? { step: Number(item.step) } : {}),
      message: String(item.message),
      ...(item.resolvedAt ? { resolvedAt: new Date(item.resolvedAt).toISOString() } : {}),
      ...(item.resolvedReason ? { resolvedReason: String(item.resolvedReason) } : {}),
    }));

    const sendGateDetail = rowSendGateIssue
      ? classifySendGateDetail(rowSendGateIssue, nextLetter, projectSignature, projectApprovedOffers)
      : undefined;
    const draftAuditDetail = audit.needsReverify && !taskInFlight
      ? buildDraftAuditDetail(nextLetter, audit.reason, rawErrorHistory, row.lastError)
      : undefined;
    const draftAuditReason = audit.needsReverify
      ? (draftAuditDetail?.summary || audit.reason)
      : rowSendGateIssue;

    // Reconcile stale enrollment.lastError so resolved old errors (like old 95/103 word-count errors
    // or stale "发送任务已保存，可在邮件中心查看进度" when the actual letter is cancelled/failed/sent)
    // move cleanly to errorHistory without touching paused status!
    let effectiveLastError = row.lastError;
    if (!isRuleStopped && row.lastError && !taskInFlight) {
      if (draftReady || isWaitingDelivery || ['sent', 'opened'].includes(nextLetterStatus ?? '') || row.status === 'completed' || actualStep >= MAX_AUTO_STEPS) {
        const resolvedReason = (row.status === 'completed' || actualStep >= MAX_AUTO_STEPS)
          ? '邮件已发送完成'
          : isWaitingDelivery
            ? '邮件已进入发送队列等待投递'
            : '当前草稿已通过核验与发送检查';
        staleErrorOps.push({
          updateOne: {
            filter: { _id: row._id, lastError: row.lastError },
            update: {
              $unset: { lastError: 1 },
              $push: {
                errorHistory: {
                  $each: [{
                    at: new Date(row.updatedAt ?? now),
                    step: nextStep,
                    message: String(row.lastError),
                    resolvedAt: now,
                    resolvedReason,
                  }],
                  $slice: -20,
                },
              },
            },
          },
        });
        errorHistoryDto.push({
          at: new Date(row.updatedAt ?? now).toISOString(),
          step: nextStep,
          message: String(row.lastError),
          resolvedAt: now.toISOString(),
          resolvedReason,
        });
        effectiveLastError = undefined;
      } else if (isDeliveryCancelled) {
        const cancelMsg = nextLetter?.error
          ? `第 ${nextStep} 封邮件已取消（未发送）：${nextLetter.error}`
          : `第 ${nextStep} 封邮件已取消（未发送）`;
        if (row.lastError !== cancelMsg) {
          staleErrorOps.push({
            updateOne: {
              filter: { _id: row._id, lastError: row.lastError },
              update: {
                $set: { lastError: cancelMsg.slice(0, 500) },
                $push: {
                  errorHistory: {
                    $each: [{
                      at: new Date(row.updatedAt ?? now),
                      step: nextStep,
                      message: String(row.lastError),
                      resolvedAt: now,
                      resolvedReason: '实际邮件状态已同步为已取消（未发送）',
                    }],
                    $slice: -20,
                  },
                },
              },
            },
          });
          errorHistoryDto.push({
            at: new Date(row.updatedAt ?? now).toISOString(),
            step: nextStep,
            message: String(row.lastError),
            resolvedAt: now.toISOString(),
            resolvedReason: '实际邮件状态已同步为已取消（未发送）',
          });
          effectiveLastError = cancelMsg;
        }
      } else if (isDeliveryFailed && row.lastError === STALE_SAVED_SEND_ERROR) {
        const failMsg = nextLetter?.error
          ? `第 ${nextStep} 封邮件投递失败（SMTP）：${nextLetter.error}`
          : `第 ${nextStep} 封邮件投递失败（SMTP）`;
        staleErrorOps.push({
          updateOne: {
            filter: { _id: row._id, lastError: row.lastError },
            update: {
              $set: { lastError: failMsg.slice(0, 500) },
              $push: {
                errorHistory: {
                  $each: [{
                    at: new Date(row.updatedAt ?? now),
                    step: nextStep,
                    message: String(row.lastError),
                    resolvedAt: now,
                    resolvedReason: '实际邮件状态已同步为投递失败',
                  }],
                  $slice: -20,
                },
              },
            },
          },
        });
        errorHistoryDto.push({
          at: new Date(row.updatedAt ?? now).toISOString(),
          step: nextStep,
          message: String(row.lastError),
          resolvedAt: now.toISOString(),
          resolvedReason: '实际邮件状态已同步为投递失败',
        });
        effectiveLastError = failMsg;
      } else if (nextLetterStatus === 'draft' && draftAuditReason && row.lastError !== draftAuditReason && row.lastError !== '已提交重新生成并核验（正式发送仍保持暂停）') {
        staleErrorOps.push({
          updateOne: {
            filter: { _id: row._id, lastError: row.lastError },
            update: {
              $set: { lastError: draftAuditReason.slice(0, 500) },
              $push: {
                errorHistory: {
                  $each: [{
                    at: new Date(row.updatedAt ?? now),
                    step: nextStep,
                    message: String(row.lastError),
                    resolvedAt: now,
                    resolvedReason: '当前草稿已更新拦截原因',
                  }],
                  $slice: -20,
                },
              },
            },
          },
        });
        errorHistoryDto.push({
          at: new Date(row.updatedAt ?? now).toISOString(),
          step: nextStep,
          message: String(row.lastError),
          resolvedAt: now.toISOString(),
          resolvedReason: '当前草稿已更新拦截原因',
        });
        effectiveLastError = draftAuditReason;
      }
    }

    const canRebuildRow = Boolean(
      audit.needsReverify
      && !taskInFlight
      && nextLetterStatus === 'draft'
      && nextLetter?.review?.decision !== 'approved'
      && customer
      && customer.email
      && String(customer.ownerId ?? '') === String(config.userId)
      && AUTO_TARGET_STATUSES.includes(customer.status as (typeof AUTO_TARGET_STATUSES)[number])
      && !customer.outreachAbandonedAt
      && !customer.outreachRepliedAt
      && !isRuleStopped,
    );
    if (audit.needsReverify && !taskInFlight) {
      unverifiedDrafts += 1;
      if (canRebuildRow) rebuildableUnverifiedDrafts += 1;
    } else if (!audit.needsReverify && Boolean(rowSendGateIssue) && !taskInFlight) {
      sendGateBlockedDrafts += 1;
    }
    if (!audit.needsReverify && audit.contextWarnings.length > 0 && nextLetterStatus === 'draft' && !taskInFlight) {
      contextWarningDrafts += 1;
    }
    if (isDeliveryFailed) deliveryFailedCount += 1;
    if (isDeliveryCancelled) deliveryCancelledCount += 1;

    const pausedReadyToResume = Boolean(
      row.status === 'paused'
      && draftReady
      && !taskInFlight
      && !isRuleStopped,
    );
    if (pausedReadyToResume) pausedReadyCount += 1;

    const buyerSchedule = config.useBuyerTimezone || customer?.timezone
      ? resolveBuyerTimezone({
        timezone: customer?.timezone,
        country: customer?.country,
        address: customer?.address,
        phone: customer?.phone,
      }, config.timezone)
      : { timezone: config.timezone, source: 'fallback' as const, workdays: [1, 2, 3, 4, 5] };
    const recipientWindow = {
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      timezone: buyerSchedule.timezone,
      workdays: buyerSchedule.workdays,
    };
    const recipientWindowOpen = isWithinSendWindow(recipientWindow, now);
    const nextRunAt = new Date(row.nextRunAt);
    const effectiveAt = nextSendWindow(recipientWindow, nextRunAt.getTime() > now.getTime() ? nextRunAt : now);

    let draftStage: OutreachDraftStage = 'none';
    if (row.status !== 'completed' && !isRuleStopped && actualStep < MAX_AUTO_STEPS) {
      if (taskStatus === 'running') draftStage = 'waiting_model';
      else if (taskStatus === 'queued') draftStage = 'reverify_queued';
      else if (nextLetterStatus === 'draft' && !draftBlockedFromAutoSend) draftStage = 'draft_saved_verified';
      else if (nextLetterStatus === 'draft' && draftBlockedFromAutoSend) draftStage = 'draft_audit_failed';
      else if (isWaitingDelivery) draftStage = 'waiting_delivery';
      else if (isDeliveryCancelled) draftStage = 'delivery_cancelled';
      else if (isDeliveryFailed) draftStage = 'delivery_failed';
      else if (!nextLetter && taskStatus === 'failed') draftStage = 'task_failed';
    }
    if (draftStage === 'task_failed') activeFailedTasks += 1;

    let phase: OutreachAutomationQueueRow['phase'];
    if (row.status === 'completed' || actualStep >= MAX_AUTO_STEPS) phase = 'completed';
    else if (taskInFlight) phase = 'generating';
    else if (isRuleStopped || row.status === 'blocked') phase = 'blocked';
    else if (isDeliveryFailed) phase = 'failed';
    else if (isDeliveryCancelled) phase = row.status === 'paused' ? 'paused' : 'failed';
    else if (isWaitingDelivery) phase = 'sending';
    else if (row.status === 'paused') phase = 'paused';
    else if (row.status === 'failed') phase = 'failed';
    else if (nextLetterStatus === 'draft' && draftBlockedFromAutoSend) phase = 'failed';
    else if (nextRunAt.getTime() > now.getTime()) phase = 'waiting';
    else if (!recipientWindowOpen) phase = 'waiting';
    else if (nextLetterStatus === 'draft') phase = 'ready';
    else if (nextLetterStatus) phase = 'sending';
    else if (taskStatus && taskStatus !== 'failed') phase = 'generating';
    else phase = 'due';

    const rowNeedsAttention = Boolean(
      !isRuleStopped
      && row.status !== 'completed'
      && !taskInFlight
      && (
        draftStage === 'draft_audit_failed'
        || draftStage === 'task_failed'
        || draftStage === 'delivery_failed'
        || draftStage === 'delivery_cancelled'
        || row.status === 'failed'
        || (row.status === 'paused' && !pausedReadyToResume)
      ),
    );
    if (rowNeedsAttention) exceptionQueueCount += 1;

    const taskStep = latestTask?.currentStep ? String(latestTask.currentStep) : undefined;
    const taskErrorCode = latestTask?.status === 'failed' && latestTask.error?.code ? String(latestTask.error.code) : undefined;
    const taskError = latestTask?.status === 'failed' ? humanizeTaskError(latestTask.error) : undefined;
    const taskRetryAt = draftStage === 'task_failed' && nextRunAt.getTime() > now.getTime()
      ? nextRunAt.toISOString()
      : undefined;
    if (taskRetryAt) retryingTasks += 1;

    return {
      id: String(row._id),
      customerId: String(row.customerId),
      customerName: customer?.name ?? '客户已删除',
      ...(customer?.company ? { company: customer.company } : {}),
      ...(customer?.email ? { email: customer.email } : {}),
      customerStatus: customer?.status ?? '',
      status: row.status,
      currentStep: actualStep,
      actualStep,
      nextStep,
      phase,
      draftStage,
      ...(deliveryStatus ? { deliveryStatus } : {}),
      draftReady,
      ...(nextLetter?._id ? { draftId: String(nextLetter._id) } : {}),
      ...(draftBlockedFromAutoSend && !taskInFlight ? { draftNeedsReverify: true, draftAuditReason } : {}),
      ...(draftAuditDetail ? { draftAuditDetail } : {}),
      ...(sendGateDetail && !taskInFlight ? { sendGateDetail } : {}),
      ...(audit.contextWarnings.length > 0 && nextLetterStatus === 'draft' && !taskInFlight ? { contextWarnings: audit.contextWarnings } : {}),
      ...(pausedReadyToResume ? { pausedReadyToResume: true } : {}),
      ...(isDeliveryFailed ? {
        failedLetterId: String(nextLetter?._id),
        deliveryError: String(nextLetter?.error || 'SMTP 投递失败'),
      } : {}),
      ...(isDeliveryCancelled ? {
        cancelledLetterId: String(nextLetter?._id),
        cancelledReason,
      } : {}),
      ...(isRuleStopped ? { isRuleStopped: true } : {}),
      ...(errorHistoryDto.length ? { errorHistory: errorHistoryDto.slice(-5) } : {}),
      ...(nextLetter?.updatedAt ? { draftUpdatedAt: new Date(nextLetter.updatedAt).toISOString() } : {}),
      ...(latestTask?._id ? { taskId: String(latestTask._id), taskStatus } : {}),
      ...(taskStep ? { taskStep, taskStepLabel: TASK_STEP_LABELS[taskStep] ?? taskStep } : {}),
      ...(taskError ? { taskError } : {}),
      ...(taskErrorCode ? { taskErrorCode } : {}),
      ...(taskRetryAt ? { taskRetryAt } : {}),
      ...(latestTask?.workflowActiveMs ? { taskDurationMs: Number(latestTask.workflowActiveMs) } : {}),
      effectiveTimezone: buyerSchedule.timezone,
      timezoneSource: buyerSchedule.source,
      recipientWindowOpen,
      nextRunAt: effectiveAt.toISOString(),
      ...(effectiveLastError ? { lastError: effectiveLastError } : {}),
      ...(row.lastSentAt ? { lastSentAt: new Date(row.lastSentAt).toISOString() } : {}),
    };
  });

  if (staleErrorOps.length > 0) {
    await OutreachAutomationEnrollment.bulkWrite(staleErrorOps as never, { ordered: false }).catch(() => undefined);
  }

  return {
    config: cfgDto,
    windowOpen,
    circuit,
    mailbox: mailbox.account ? {
      email: mailbox.account.email,
      displayName: mailbox.account.displayName,
      channel: mailbox.channel,
      canSend: mailbox.canSend,
      ...(mailbox.reason ? { reason: mailbox.reason } : {}),
      usedToday: mailbox.account.usedToday,
      dailyLimit: mailbox.account.dailyLimit,
      ...(mailbox.account.warmup ? { warmup: mailbox.account.warmup } : {}),
    } : null,
    stats: {
      eligible,
      enrolled,
      active: counts.active ?? 0,
      paused: counts.paused ?? 0,
      completed: counts.completed ?? 0,
      blocked: counts.blocked ?? 0,
      ruleStopped: ruleStoppedCount,
      failed: counts.failed ?? 0,
      circuitFailed: circuitFailedCount,
      aiFailed: aiFailedCount,
      unverifiedDrafts,
      rebuildableUnverifiedDrafts,
      sendGateBlockedDrafts,
      contextWarningDrafts,
      pausedReadyCount,
      deliveryFailedCount,
      deliveryCancelledCount,
      exceptionQueueCount,
      approvedProofBlocksCount,
      queuedTasks: taskTotals.queued ?? 0,
      runningTasks: taskTotals.running ?? 0,
      retryingTasks,
      activeFailedTasks,
      historicalFailedTasks: taskTotals.failed ?? 0,
      failedTasks: activeFailedTasks,
      sentToday,
      remainingToday: Math.max(0, effectiveDailyLimit(config) - sentToday),
    },
    queue: queueRows,
    recent: recentLetters.map((letter) => {
      const customer = customerMap.get(String(letter.customerId));
      return {
        letterId: String(letter._id),
        customerId: String(letter.customerId),
        customerName: customer?.name ?? '客户已删除',
        step: Number(letter.outreachStep ?? 0),
        sentAt: new Date(letter.sentAt ?? letter.createdAt).toISOString(),
        status: letter.status,
      };
    }),
  };
}

export async function saveOutreachAutomationConfig(
  input: OutreachAutomationConfigInput,
  actor: AuthUser,
  targetUserId?: string,
): Promise<OutreachAutomationOverview> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  if (config.version !== input.expectedVersion) throw ApiError.conflict('自动开发设置已变化，请刷新后重试');
  if (input.windowStart >= input.windowEnd) throw ApiError.badRequest('发送开始时间必须早于结束时间');
  const saved = await OutreachAutomationConfig.findOneAndUpdate(
    { _id: config._id, version: input.expectedVersion },
    {
      $set: {
        dailyLimit: input.dailyLimit,
        perDomainLimit: input.perDomainLimit,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        timezone: input.timezone,
        ...(input.useBuyerTimezone !== undefined ? { useBuyerTimezone: input.useBuyerTimezone } : {}),
        ...(input.minPacingSeconds !== undefined ? { minPacingSeconds: input.minPacingSeconds } : {}),
        ...(input.maxPacingSeconds !== undefined ? { maxPacingSeconds: Math.max(input.maxPacingSeconds, input.minPacingSeconds ?? 90) } : {}),
        ...(input.rolloutMode ? { rolloutMode: input.rolloutMode } : {}),
      },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!saved) throw ApiError.conflict('自动开发设置已变化，请刷新后重试');
  if (input.rolloutMode && config.rolloutMode !== input.rolloutMode) {
    await OutreachAutomationEnrollment.updateMany({ campaignId: config._id, status: 'active', lastError: '模拟校验通过' }, {
      $set: { nextRunAt: new Date(), lastError: null },
    });
  }
  return getOutreachAutomationOverview(actor, target.id);
}

export async function getOutreachResults(actor: AuthUser, targetUserId?: string) {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const project = await Project.findById(config.projectId).select('organizationId').lean();
  return campaignResults(config.projectId, config._id, project?.organizationId?.toString());
}

/** 读取当前项目的「预审英文卖点块」以及从已发布知识库自动提取的推荐候选块。 */
export async function getProjectProofBlocks(actor: AuthUser): Promise<{
  blocks: ProjectApprovedProofBlock[];
  suggested: ProjectApprovedProofBlock[];
}> {
  const projectId = requireProjectId(actor);
  const [project, knowledgeRows] = await Promise.all([
    Project.findById(projectId).select('brandProfile.approvedProofBlocks').lean(),
    AgentKnowledge.find({
      projectId,
      approvedVersion: { $gt: 0 },
      archived: { $ne: true },
    }).select('_id approvedVersion revisions').limit(80).lean(),
  ]);
  const blocks: ProjectApprovedProofBlock[] = (project?.brandProfile?.approvedProofBlocks ?? []).map((b) => ({
    id: String(b.id),
    slot: b.slot === 'identity' || b.slot === 'cta' ? b.slot : 'proof',
    label: String(b.label),
    text: String(b.text),
    ...(b.sourceKnowledgeId ? { sourceKnowledgeId: String(b.sourceKnowledgeId) } : {}),
    enabled: Boolean(b.enabled),
  }));
  const publishedEntries = knowledgeRows.flatMap((row) => {
    const rev = row.revisions.find((r) => r.version === row.approvedVersion && r.approved);
    if (!rev) return [];
    return [{ id: String(row._id), title: rev.title, category: rev.category ?? 'company', content: rev.content }];
  });
  const suggested = extractSuggestedProofBlocks(publishedEntries);
  return { blocks, suggested };
}

/** 管理员保存项目的「预审英文卖点块」，供自动开发 4 槽位写稿与零 LLM 快速核验直通使用。 */
export async function saveProjectProofBlocks(
  actor: AuthUser,
  blocks: ProjectApprovedProofBlock[],
): Promise<{ blocks: ProjectApprovedProofBlock[] }> {
  if (actor.role !== 'admin') throw ApiError.forbidden('只有管理员可以维护项目预审卖点块');
  const projectId = requireProjectId(actor);
  const cleaned: ProjectApprovedProofBlock[] = blocks.slice(0, 30).map((b, idx) => ({
    id: (b.id || `proof_${idx + 1}`).trim().slice(0, 60),
    slot: b.slot === 'identity' || b.slot === 'cta' ? b.slot : 'proof',
    label: b.label.trim().slice(0, 120),
    text: b.text.trim().slice(0, 500),
    ...(b.sourceKnowledgeId?.trim() ? { sourceKnowledgeId: b.sourceKnowledgeId.trim().slice(0, 64) } : {}),
    enabled: Boolean(b.enabled),
  }));
  for (const b of cleaned) {
    if (!b.label || !b.text) throw ApiError.badRequest('预审卖点块的标题和英文正文不能为空');
    if (/\{\{[^}]+\}\}/.test(b.text)) throw ApiError.badRequest('预审卖点块不能包含未替换的占位符');
  }
  await Project.updateOne(
    { _id: projectId },
    { $set: { 'brandProfile.approvedProofBlocks': cleaned } },
  );
  return { blocks: cleaned };
}

/** 升级前核对已有自动开发任务和排队邮件，明确哪些旧配置缺少 rolloutMode 字段。 */
export async function auditLegacyOutreachCampaigns(actor: AuthUser) {
  if (actor.role !== 'admin') throw ApiError.forbidden('仅管理员可执行自动开发升级检查');
  const projectId = requireProjectId(actor);
  const [configs, queuedLetters] = await Promise.all([
    OutreachAutomationConfig.find({ projectId }).select('_id userId enabled rolloutMode dailyLimit timezone pausedReason').lean(),
    DevelopmentLetter.find({
      projectId,
      automationCampaignId: { $exists: true, $ne: null },
      status: { $in: ['queued', 'scheduled', 'retrying'] },
    }).select('_id automationCampaignId outreachStep status nextAttemptAt').limit(500).lean(),
  ]);
  const legacyUnset = configs.filter((c) => !c.rolloutMode);
  const countsByMode = {
    shadow: configs.filter((c) => c.rolloutMode === 'shadow').length,
    pilot: configs.filter((c) => c.rolloutMode === 'pilot').length,
    active: configs.filter((c) => c.rolloutMode === 'active').length,
    legacyUnset: legacyUnset.length,
  };
  return {
    projectId: String(projectId),
    totalCampaigns: configs.length,
    countsByMode,
    legacyUnsetCampaigns: legacyUnset.map((c) => ({
      id: String(c._id),
      userId: String(c.userId),
      enabled: c.enabled,
      dailyLimit: c.dailyLimit,
      effectiveModeBeforeMigration: 'active',
    })),
    pendingQueuedLetters: queuedLetters.length,
    recommendation: legacyUnset.length > 0
      ? `发现 ${legacyUnset.length} 条历史自动开发配置未设置 rolloutMode（当前会按正式发送 active 处理），建议升级前显式归类到 shadow、pilot 或 active。`
      : '全部自动开发配置均已明确设置 rolloutMode，可安全升级。',
  };
}

export async function migrateLegacyOutreachModes(
  targetMode: 'shadow' | 'pilot' | 'active',
  actor: AuthUser,
) {
  if (actor.role !== 'admin') throw ApiError.forbidden('仅管理员可批量设置历史自动开发模式');
  const projectId = requireProjectId(actor);
  const result = await OutreachAutomationConfig.updateMany(
    { projectId, $or: [{ rolloutMode: { $exists: false } }, { rolloutMode: null }] },
    { $set: { rolloutMode: targetMode }, $inc: { version: 1 } },
  );
  return { modifiedCount: result.modifiedCount, targetMode };
}

async function assertMailboxReady(actor: AuthUser, targetUserId?: string) {
  const target = await resolveTargetUser(actor, targetUserId);
  const mailbox = await getCurrentMailSender(String(requireProjectId(actor)), target.id);
  if (mailbox.channel !== 'smtp') {
    throw ApiError.conflict('当前项目使用模拟发送，自动开发需要先启用真实 SMTP 发送');
  }
  if (!mailbox.canSend) throw ApiError.conflict(mailbox.reason || '个人发件邮箱不可用，请先验证邮箱');
  return mailbox;
}

export async function startOutreachAutomation(
  actor: AuthUser,
  customerIds?: string[],
  targetUserId?: string,
): Promise<{ enrolled: number; skipped: number; overview: OutreachAutomationOverview }> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  if (config.rolloutMode !== 'shadow') await assertMailboxReady(actor, target.id);
  const now = new Date();
  let candidates;
  if (customerIds?.length) {
    const ids = customerIds.filter((id) => /^[a-f\d]{24}$/i.test(id)).map((id) => new Types.ObjectId(id));
    candidates = await Customer.find({ ...eligibleFilter(actor, target.id), _id: { $in: ids } })
      .select('_id outreachStep nextFollowUpAt')
      .lean();
  } else {
    candidates = await Customer.find(eligibleFilter(actor, target.id))
      .select('_id outreachStep nextFollowUpAt')
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
  }

  let enrolled = 0;
  let skipped = 0;
  for (const customer of candidates) {
    const existing = await OutreachAutomationEnrollment.findOne({ campaignId: config._id, customerId: customer._id });
    if (existing && ['blocked', 'completed'].includes(existing.status)) {
      skipped += 1;
      continue;
    }
    await ensureEnrollment(config._id, actor, customer, now, new Types.ObjectId(target.id));
    enrolled += 1;
  }

  if (!enrolled) {
    throw ApiError.conflict(
      customerIds?.length
        ? '选中的客户当前都不符合自动开发条件'
        : '没有符合条件的客户：需要已有邮箱、状态为待开发/已联系，且未回复、未退订',
    );
  }
  await OutreachAutomationConfig.updateOne(
    { _id: config._id, version: config.version },
    { $set: { enabled: true, pausedReason: null }, $inc: { version: 1 } },
  );
  const overview = await getOutreachAutomationOverview(actor, target.id);
  return { enrolled, skipped, overview };
}

export async function pauseOutreachAutomation(
  actor: AuthUser,
  targetUserId?: string,
  reason = '已手动暂停',
): Promise<OutreachAutomationOverview> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  await OutreachAutomationConfig.updateOne(
    { _id: config._id },
    { $set: { enabled: false, pausedReason: reason }, $inc: { version: 1 } },
  );
  await OutreachAutomationEnrollment.updateMany(
    { campaignId: config._id, status: 'active' },
    { $set: { status: 'paused', nextRunAt: new Date() } },
  );
  return getOutreachAutomationOverview(actor, target.id);
}

export async function resumeOutreachAutomation(actor: AuthUser, targetUserId?: string): Promise<OutreachAutomationOverview> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  if (config.rolloutMode !== 'shadow') await assertMailboxReady(actor, target.id);
  await OutreachAutomationConfig.updateOne(
    { _id: config._id },
    { $set: { enabled: true, pausedReason: null }, $inc: { version: 1 } },
  );
  await OutreachAutomationEnrollment.updateMany(
    { campaignId: config._id, status: 'paused' },
    { $set: { status: 'active', nextRunAt: new Date(), lastError: null } },
  );
  return getOutreachAutomationOverview(actor, target.id);
}

export async function controlOutreachEnrollment(
  actor: AuthUser,
  enrollmentId: string,
  action: 'pause' | 'resume',
  targetUserId?: string,
): Promise<OutreachAutomationOverview> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const enrollment = await OutreachAutomationEnrollment.findOne({
    _id: enrollmentId,
    ...scope(actor, target.id),
    campaignId: config._id,
  });
  if (!enrollment) throw ApiError.notFound('自动开发队列项不存在');
  if (action === 'pause') {
    if (enrollment.status === 'active') {
      await OutreachAutomationEnrollment.updateOne(
        { _id: enrollment._id, status: 'active' },
        { $set: { status: 'paused', nextRunAt: new Date() } },
      );
    }
  } else {
    if (!config.enabled) throw ApiError.conflict('自动开发已暂停，请先恢复总开关（或点击「重新生成」先完成草稿核验）');
    const canRecoverBlocked = enrollment.status === 'blocked' && isVerificationBlockedReason(enrollment.lastError);
    if (!['paused', 'failed'].includes(enrollment.status) && !canRecoverBlocked) {
      throw ApiError.conflict('当前队列项不能恢复');
    }
    // If the current next-step draft is unverified/partial, supersede it and queue a fresh verified draft
    // instead of looping back into the exact same verification block.
    const targetActor = await getActorForConfig(config);
    const regen = await supersedeUnverifiedDraftAndRequeue(config, enrollment, targetActor, new Date(), { onlyIfUnverified: true });
    if (!regen.queued) {
      await OutreachAutomationEnrollment.updateOne(
        { _id: enrollment._id },
        { $set: { status: 'active', nextRunAt: new Date(), lastError: null, attempts: 0 } },
      );
    }
  }
  return getOutreachAutomationOverview(actor, target.id);
}

async function supersedeUnverifiedDraftAndRequeue(
  config: InstanceType<typeof OutreachAutomationConfig>,
  enrollment: InstanceType<typeof OutreachAutomationEnrollment>,
  targetActor: AuthUser,
  now: Date,
  options: { onlyIfUnverified: boolean },
): Promise<{ queued: boolean; taskId?: string; skippedReason?: string }> {
  const customer = await Customer.findOne({
    _id: enrollment.customerId,
    projectId: config.projectId,
    ownerId: config.userId,
  });
  if (!customer) return { queued: false, skippedReason: '客户已删除或归属已变化' };
  if (!customer.email) return { queued: false, skippedReason: '客户缺少邮箱' };
  if (!AUTO_TARGET_STATUSES.includes(customer.status as (typeof AUTO_TARGET_STATUSES)[number]) || customer.outreachAbandonedAt) {
    return { queued: false, skippedReason: '客户已不在可开发状态' };
  }
  const replied = Boolean(customer.outreachRepliedAt)
    || await hasInboundReplySince(config.projectId, customer._id, customer.outreachLastAt);
  if (replied) return { queued: false, skippedReason: '客户已回复' };
  if (await hasProtectedCustomerMail(String(customer._id), String(config.projectId))) {
    return { queued: false, skippedReason: '客户存在退订或退信记录' };
  }

  const step = Math.max(Number(customer.outreachStep ?? 0), await sentProgress(config.projectId, customer._id));
  if (step >= MAX_AUTO_STEPS) return { queued: false, skippedReason: '三封开发信已完成' };
  const nextStep = (step + 1) as OutreachStep;

  // For explicit single-row regeneration/test-run, also cancel any stale queued duplicate tasks
  // for this (customerId, nextStep) so the new single test task executes cleanly without duplicates.
  const runningNow = await AgentTask.exists({
    projectId: config.projectId,
    userId: config.userId,
    customerId: customer._id,
    outreachStep: nextStep,
    status: 'running',
  });
  if (runningNow) return { queued: false, skippedReason: '已有核验生成任务正在执行中' };
  if (options.onlyIfUnverified) {
    const queuedNow = await AgentTask.exists({
      projectId: config.projectId,
      userId: config.userId,
      customerId: customer._id,
      outreachStep: nextStep,
      status: 'queued',
    });
    if (queuedNow) return { queued: false, skippedReason: '已有核验生成任务在排队中' };
  }

  const draft = await findDraft(config.projectId, customer._id, nextStep);
  if (draft) {
    if (draft.status !== 'draft') {
      return { queued: false, skippedReason: `第 ${nextStep} 封当前状态为 ${draft.status}，跳过重建` };
    }
    if (draft.review?.decision === 'approved') {
      return { queued: false, skippedReason: '草稿已人工审核通过，保留不覆盖' };
    }
    const audit = inspectOutreachDraftAudit(draft);
    if (options.onlyIfUnverified && !audit.needsReverify) {
      return {
        queued: false,
        skippedReason: audit.contextWarnings.length > 0
          ? '正文核验已通过（仅有背景资料缺口提醒，不拦截发送，无需重建）'
          : '正文核验已完成（如有其他发送拦截请按对应入口处理）',
      };
    }
    // Item 5: Do not repeatedly regenerate Step-1 drafts that already failed for missing published
    // supplier capability evidence when the project STILL has no published capability knowledge/proof blocks.
    if (nextStep === 1) {
      const hasMissingEvidenceFailure = Boolean(
        draft.knowledgeReview?.issues?.some((i) => i.code === 'missing_supplier_evidence')
        || (!audit.needsReverify && automatedReviewIssue(draft.knowledgeReview, 1)?.includes('首封缺少已发布的我方能力依据')),
      );
      if (hasMissingEvidenceFailure && !(await hasProjectStep1CapabilityEvidence(config.projectId))) {
        return {
          queued: false,
          skippedReason: '缺少已发布的我方能力依据（需至少 1 条已发布的公司简介/工厂产能、产品规格、资质认证文档，或启用英文预审卖点块）；请先补充后再重建，避免重复生成同样被拦的稿件',
        };
      }
    }
    // Archive the stale/unverified draft as cancelled (never hard-delete) so audit history is preserved
    // and queueOutreachStep / findDraft treat this step as cleanly ready for fresh generation.
    await DevelopmentLetter.updateOne(
      { _id: draft._id, projectId: config.projectId, status: 'draft' },
      {
        $set: {
          status: 'cancelled',
          error: '已发起重新生成并核验，原未核验草稿归档保留',
        },
        $push: { history: { at: now, status: 'cancelled' } },
      },
    );
  } else if (options.onlyIfUnverified) {
    return { queued: false, skippedReason: '当前无待重核验草稿' };
  }

  // Cancel any terminal/waiting (and for explicit single-row regen, stale queued) task for this step
  // so planForCustomer allows clean regeneration with zero duplicate tasks.
  await AgentTask.updateMany(
    {
      projectId: config.projectId,
      userId: config.userId,
      customerId: customer._id,
      outreachStep: nextStep,
      status: { $in: options.onlyIfUnverified ? ['awaiting_review', 'paused', 'failed', 'waiting_input'] : ['queued', 'awaiting_review', 'paused', 'failed', 'waiting_input'] },
    },
    {
      $set: { status: 'cancelled' },
      $unset: { leaseToken: 1, leaseUntil: 1 },
      $inc: { version: 1 },
      $push: {
        events: {
          $each: [{ at: now, message: '原草稿未完成核验，已归档并重新提交核验生成任务。' }],
          $slice: -100,
        },
      },
    },
  );

  const queued = await queueOutreachStep(targetActor, String(customer._id), nextStep);
  const nextTaskIds = queued.taskId
    ? [...enrollment.taskIds, new Types.ObjectId(queued.taskId)]
    : enrollment.taskIds;

  // CRITICAL SAFETY RULE: when config.enabled === false (paused), NEVER auto-enable or auto-send!
  // Keep enrollment paused so the operator can inspect the freshly verified drafts before resuming.
  if (config.enabled) {
    await markEnrollment(enrollment._id, {
      status: 'active',
      currentStep: step,
      queuedStep: nextStep,
      queuedAt: now,
      nextRunAt: new Date(now.getTime() + 30_000),
      lastError: null,
      attempts: 0,
      taskIds: nextTaskIds,
    });
  } else {
    await markEnrollment(enrollment._id, {
      status: 'paused',
      currentStep: step,
      queuedStep: nextStep,
      queuedAt: now,
      nextRunAt: now,
      lastError: '已提交重新生成并核验（正式发送仍保持暂停）',
      attempts: 0,
      taskIds: nextTaskIds,
    });
  }

  return { queued: true, taskId: queued.taskId };
}

/**
 * 批量重新生成并核验未完成核验（partial / unavailable / draft_unverified / semantic_unverified）的草稿。
 * 支持管理员通过 ?userId=<repId> 安全代操作（仍以业务员本人权限创建草稿任务），
 * 且在自动开发总开关暂停（enabled=false）期间也可安全执行，绝不会触发正式发送。
 */
export async function reverifyUnverifiedOutreachDrafts(
  actor: AuthUser,
  options?: { enrollmentIds?: string[] },
  targetUserId?: string,
): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
  taskIds: string[];
  skippedDetails: { customerId: string; customerName: string; reason: string }[];
  skippedReasons: { reason: string; count: number }[];
  remainingUnverified: number;
  remainingSendGateBlocked: number;
  pausedReadyCount: number;
  remainingDetails: { customerId: string; customerName: string; category: 'audit_failed' | 'send_gate'; reason: string }[];
  overview: OutreachAutomationOverview;
}> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const targetActor = await getActorForConfig(config);
  const now = new Date();

  const filter: Record<string, unknown> = {
    ...scope(actor, target.id),
    campaignId: config._id,
    status: { $in: ['active', 'paused', 'failed', 'blocked'] },
  };
  if (options?.enrollmentIds?.length) {
    const validIds = options.enrollmentIds
      .filter((id) => /^[a-f\d]{24}$/i.test(id))
      .map((id) => new Types.ObjectId(id));
    filter._id = { $in: validIds };
  }

  const enrollments = await OutreachAutomationEnrollment.find(filter).limit(MAX_QUEUE_ROWS);
  const customerDocs = enrollments.length
    ? await Customer.find({ _id: { $in: enrollments.map((e) => e.customerId) }, projectId: config.projectId })
      .select('_id name')
      .lean()
    : [];
  const customerNameMap = new Map(customerDocs.map((c) => [String(c._id), c.name]));

  let queuedCount = 0;
  let skippedCount = 0;
  let scannedCount = 0;
  const taskIds: string[] = [];
  const skippedDetails: { customerId: string; customerName: string; reason: string }[] = [];
  const reasonCounts = new Map<string, number>();

  const recordSkip = (customerId: string, reason: string) => {
    skippedCount += 1;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    skippedDetails.push({
      customerId,
      customerName: customerNameMap.get(customerId) ?? '未知客户',
      reason,
    });
  };

  for (const enrollment of enrollments) {
    if (enrollment.status === 'blocked' && !isVerificationBlockedReason(enrollment.lastError)) {
      continue;
    }
    const custIdStr = String(enrollment.customerId);
    // Only consider rows whose next-step draft actually exists and fails fact audit,
    // unless caller explicitly passed specific enrollmentIds.
    if (!options?.enrollmentIds?.length) {
      const cust = await Customer.findOne({ _id: enrollment.customerId, projectId: config.projectId }).select('outreachStep letterCount').lean();
      const step = Math.min(
        MAX_AUTO_STEPS,
        Math.max(Number(cust?.outreachStep ?? 0), Math.min(MAX_AUTO_STEPS, Number(cust?.letterCount ?? 0)), Number(enrollment.currentStep ?? 0)),
      );
      if (step >= MAX_AUTO_STEPS) continue;
      const draft = await findDraft(config.projectId, enrollment.customerId, step + 1);
      if (!draft || draft.status !== 'draft') continue;
      const audit = inspectOutreachDraftAudit(draft);
      if (!audit.needsReverify) continue;
    }

    scannedCount += 1;
    try {
      const res = await supersedeUnverifiedDraftAndRequeue(config, enrollment, targetActor, now, { onlyIfUnverified: true });
      if (res.queued) {
        queuedCount += 1;
        if (res.taskId) taskIds.push(res.taskId);
      } else {
        recordSkip(custIdStr, res.skippedReason || '不符合重建条件');
      }
    } catch (error) {
      recordSkip(custIdStr, error instanceof Error ? error.message : '重建触发失败');
      logger.warn('自动开发草稿重建单条失败，已跳过继续', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const overview = await getOutreachAutomationOverview(actor, target.id);
  const skippedReasons = [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count }));
  const remainingDetails = overview.queue
    .filter((row) => row.draftStage === 'draft_audit_failed')
    .slice(0, 30)
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName,
      category: row.sendGateDetail ? 'send_gate' as const : 'audit_failed' as const,
      reason: row.sendGateDetail
        ? `${row.sendGateDetail.label}：${row.sendGateDetail.detail}`
        : (row.draftAuditDetail?.summary || row.draftAuditReason || '正文核验未通过'),
    }));
  return {
    scanned: scannedCount,
    queued: queuedCount,
    skipped: skippedCount,
    taskIds,
    skippedDetails: skippedDetails.slice(0, 30),
    skippedReasons,
    remainingUnverified: overview.stats.unverifiedDrafts,
    remainingSendGateBlocked: overview.stats.sendGateBlockedDrafts,
    pausedReadyCount: overview.stats.pausedReadyCount,
    remainingDetails,
    overview,
  };
}

export type OutreachSendGateFixAction = 'recheck' | 'strip_offer' | 'split_paragraphs';

/**
 * 针对「正文核验已通过、但卡在其他发送检查」的草稿提供精确修复与重检入口：
 * - recheck: 按当前最新项目设置（如已开启寄样/色卡授权、已批准证据块）重新执行发送检查并归档旧错误
 * - strip_offer: 安全删除未获授权或条件不满足的寄样/色卡/免费/运费提议句并立即重检
 * - split_paragraphs: 按句界拆分为移动端友好短段并保留全部逐项核验句文字不变后立即重检
 * 注意：绝不减弱人工审批边界，也绝不自动解除总开关或队列暂停状态。
 */
export async function fixEnrollmentSendGate(
  actor: AuthUser,
  enrollmentId: string,
  action: OutreachSendGateFixAction,
  targetUserId?: string,
): Promise<{
  fixed: boolean;
  action: OutreachSendGateFixAction;
  remainingIssue?: string;
  summary: string;
  overview: OutreachAutomationOverview;
}> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const enrollment = await OutreachAutomationEnrollment.findOne({
    _id: enrollmentId,
    ...scope(actor, target.id),
    campaignId: config._id,
  });
  if (!enrollment) throw ApiError.notFound('自动开发队列项不存在');
  if (enrollment.status === 'completed') throw ApiError.conflict('该客户已完成三封开发信');
  if (enrollment.status === 'blocked' && !isVerificationBlockedReason(enrollment.lastError)) {
    throw ApiError.conflict('该客户已按规则停止，不能修改草稿');
  }

  const customer = await Customer.findOne({ _id: enrollment.customerId, projectId: config.projectId }).lean();
  if (!customer) throw ApiError.notFound('客户不存在或已删除');
  const actualStep = Math.min(
    MAX_AUTO_STEPS,
    Math.max(
      Number(customer.outreachStep ?? 0),
      Math.min(MAX_AUTO_STEPS, Number(customer.letterCount ?? 0)),
      Number(enrollment.currentStep ?? 0),
    ),
  );
  if (actualStep >= MAX_AUTO_STEPS) throw ApiError.conflict('该客户已完成三封开发信');
  const nextStep = actualStep + 1;

  const draft = await findDraft(config.projectId, customer._id, nextStep);
  if (!draft || draft.status !== 'draft') {
    throw ApiError.conflict(`第 ${nextStep} 封当前没有可检查的草稿`);
  }
  if (draft.review?.decision === 'approved') {
    throw ApiError.conflict('草稿已人工审核通过，请勿覆盖');
  }

  const project = await Project.findById(config.projectId)
    .select('code slug name companyName industry website mailFrom senderName brandProfile')
    .lean();
  const signature = resolveProjectSalesProfile(project).signature;
  const approvedOffers = project?.brandProfile?.approvedOffers;
  const targetActor = await getActorForConfig(config);
  const now = new Date();

  let workingSubject = draft.subject;
  let workingHtml = draft.content;
  let workingText = draft.contentText;
  let workingTemplate = draft.template;
  let workingReview = draft.knowledgeReview;

  if (action === 'strip_offer') {
    const bodyWithoutSig = splitSignatureText(draft.contentText, signature).body;
    const { cleanedBody, removedSentences } = stripUnauthorizedOfferSentences(bodyWithoutSig);
    if (removedSentences.length === 0) {
      throw ApiError.conflict('当前草稿未检测到可移除的寄样/色卡/免费/运费提议句');
    }
    let nextBody = cleanedBody;
    let appendedNeutralCta = false;
    if (nextStep < 3 && extractQuestions(stripSalutationAndSignoff(nextBody)).length === 0) {
      nextBody = `${nextBody}\n\nWould this be relevant for your current range?`;
      appendedNeutralCta = true;
    }
    const pureWords = countEnglishWords(stripSalutationAndSignoff(nextBody));
    if (pureWords < 12) {
      throw ApiError.conflict('删除该提议后剩余正文过短，请点击「单条重建」由 AI 重新撰写');
    }
    const signerName = await resolveSignerName({
      projectId: config.projectId,
      ownerId: customer.ownerId,
      actorId: targetActor.id,
    });
    const rendered = await renderLetter(customer, draft.subject, nextBody, draft.recipientEmail, signerName, {
      mailKind: 'outreach',
    });
    workingSubject = rendered.subject;
    workingHtml = rendered.html;
    workingText = rendered.text;
    workingTemplate = nextBody;

    if (workingReview) {
      const removedSet = new Set(removedSentences.map((s) => s.trim().toLowerCase()));
      const isOfferText = (text: string) =>
        removedSet.has(text.trim().toLowerCase())
        || SAMPLE_PATTERN.test(text)
        || FREE_PATTERN.test(text)
        || SHIPPING_PATTERN.test(text);
      const nextChecks = (workingReview.factAudit?.checks ?? []).filter((c) => !isOfferText(c.text));
      if (appendedNeutralCta) {
        nextChecks.push({
          id: `s${nextChecks.length}`,
          text: 'Would this be relevant for your current range?',
          status: 'non_claim',
          sourceIds: [],
          reason: '礼貌语或不含交易承诺的询问',
        });
      }
      const nextClaims = (workingReview.claims ?? []).filter((c) => !isOfferText(c.text));
      const cleanBodyForQuality = splitSignatureText(rendered.text, signature).body;
      const quality = evaluateOutreachDraftQuality({
        bodyText: cleanBodyForQuality,
        subject: rendered.subject,
        step: nextStep,
        review: { ...workingReview, claims: nextClaims },
        approvedOffers,
      });
      workingReview = {
        ...workingReview,
        claims: nextClaims,
        bodyHash: draftHash(rendered.text),
        context: { ...workingReview.context, qualityReport: quality },
        ...(workingReview.factAudit ? {
          factAudit: { ...workingReview.factAudit, checks: nextChecks },
        } : {}),
      };
      await DevelopmentLetter.updateOne(
        { _id: draft._id, projectId: config.projectId, status: 'draft' },
        {
          $set: {
            subject: workingSubject,
            content: workingHtml,
            contentText: workingText,
            template: workingTemplate,
            knowledgeReview: workingReview,
          },
          $unset: { review: 1 },
        },
      );
    }
  } else if (action === 'split_paragraphs') {
    const bodyWithoutSig = splitSignatureText(draft.contentText, signature).body;
    const { splitBody, changed } = splitLongParagraphsText(bodyWithoutSig);
    if (!changed) {
      throw ApiError.conflict('当前草稿不存在可自动拆分的超长多句段落，请手动改写或点「单条重建」');
    }
    const signerName = await resolveSignerName({
      projectId: config.projectId,
      ownerId: customer.ownerId,
      actorId: targetActor.id,
    });
    const rendered = await renderLetter(customer, draft.subject, splitBody, draft.recipientEmail, signerName, {
      mailKind: 'outreach',
    });
    workingSubject = rendered.subject;
    workingHtml = rendered.html;
    workingText = rendered.text;
    workingTemplate = splitBody;

    if (workingReview) {
      const cleanBodyForQuality = splitSignatureText(rendered.text, signature).body;
      const quality = evaluateOutreachDraftQuality({
        bodyText: cleanBodyForQuality,
        subject: rendered.subject,
        step: nextStep,
        review: workingReview,
        approvedOffers,
      });
      workingReview = {
        ...workingReview,
        bodyHash: draftHash(rendered.text),
        context: { ...workingReview.context, qualityReport: quality },
      };
      await DevelopmentLetter.updateOne(
        { _id: draft._id, projectId: config.projectId, status: 'draft' },
        {
          $set: {
            subject: workingSubject,
            content: workingHtml,
            contentText: workingText,
            template: workingTemplate,
            knowledgeReview: workingReview,
          },
          $unset: { review: 1 },
        },
      );
    }
  }

  const updatedAudit = inspectOutreachDraftAudit({
    status: draft.status,
    needsReview: draft.needsReview,
    review: draft.review,
    knowledgeReview: workingReview,
  });
  let remainingIssue = updatedAudit.needsReverify
    ? updatedAudit.reason
    : automatedReviewIssue(workingReview, nextStep, {
      bodyText: workingText,
      subject: workingSubject,
      approvedOffers,
      signature,
    });
  if (!remainingIssue && workingReview?.bodyHash !== draftHash(workingText)) {
    remainingIssue = '草稿正文在核验后发生变化（bodyHash 不匹配），需重新核验';
  }
  if (!remainingIssue && workingReview) {
    try {
      const freshness = await knowledgeFreshness(workingReview, targetActor);
      if (freshness.failed || freshness.changed.length > 0) {
        remainingIssue = freshness.failed
          ? '知识库依据新鲜度校验失败，请重新核验'
          : `草稿引用的 ${freshness.changed.length} 条知识库依据已更新或过期，请重新核验`;
      }
    } catch {
      remainingIssue = '发信前未能确认依据仍有效';
    }
  }

  const fixed = !remainingIssue;
  if (enrollment.lastError) {
    if (fixed) {
      await OutreachAutomationEnrollment.updateOne(
        { _id: enrollment._id, lastError: enrollment.lastError },
        {
          $unset: { lastError: 1 },
          $push: {
            errorHistory: {
              $each: [{
                at: enrollment.updatedAt ?? now,
                step: nextStep,
                message: enrollment.lastError,
                resolvedAt: now,
                resolvedReason: action === 'strip_offer'
                  ? '已删除未授权/不满足条件提议并重检通过'
                  : action === 'split_paragraphs'
                    ? '已拆分为短段落并重检通过'
                    : '重检当前草稿已通过发送检查',
              }],
              $slice: -20,
            },
          },
        },
      );
    } else if (remainingIssue && enrollment.lastError !== remainingIssue) {
      await OutreachAutomationEnrollment.updateOne(
        { _id: enrollment._id, lastError: enrollment.lastError },
        {
          $set: { lastError: remainingIssue.slice(0, 500) },
          $push: {
            errorHistory: {
              $each: [{
                at: enrollment.updatedAt ?? now,
                step: nextStep,
                message: enrollment.lastError,
                resolvedAt: now,
                resolvedReason: '重检后更新为新拦截原因',
              }],
              $slice: -20,
            },
          },
        },
      );
    }
  }

  const overview = await getOutreachAutomationOverview(actor, target.id);
  const summary = fixed
    ? (action === 'strip_offer'
      ? '已移除未授权/不满足条件的提议并重检通过'
      : action === 'split_paragraphs'
        ? '已拆分为短段落并重检通过'
        : '当前草稿已重检通过全部发送检查')
    : `重检完成，仍有拦截项：${remainingIssue}`;
  return { fixed, action, ...(remainingIssue ? { remainingIssue } : {}), summary, overview };
}

/** 单条重建草稿（支持管理员代业务员触发，且在暂停状态下也可安全使用，不触发发送）。 */
export async function regenerateOutreachEnrollmentDraft(
  actor: AuthUser,
  enrollmentId: string,
  targetUserId?: string,
): Promise<{ queued: boolean; taskId?: string; skippedReason?: string; overview: OutreachAutomationOverview }> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const enrollment = await OutreachAutomationEnrollment.findOne({
    _id: enrollmentId,
    ...scope(actor, target.id),
    campaignId: config._id,
  });
  if (!enrollment) throw ApiError.notFound('自动开发队列项不存在');
  if (enrollment.status === 'completed') throw ApiError.conflict('该客户已完成三封开发信');
  if (enrollment.status === 'blocked' && !isVerificationBlockedReason(enrollment.lastError)) {
    throw ApiError.conflict('该客户因回复、退订或状态变更已停止，不能重新生成');
  }
  const targetActor = await getActorForConfig(config);
  const res = await supersedeUnverifiedDraftAndRequeue(config, enrollment, targetActor, new Date(), { onlyIfUnverified: false });
  if (!res.queued) {
    throw ApiError.conflict(res.skippedReason || '当前无法重新生成草稿');
  }
  const overview = await getOutreachAutomationOverview(actor, target.id);
  return { ...res, overview };
}

/**
 * 清理积压的排队中（queued）自动开发 AI 任务（不动正在 running 的任务，也不删除已保存草稿），
 * 方便在出现大量排队堆积时一键清队列后再做“单条试跑验收”。
 */
export async function drainQueuedOutreachTasks(
  actor: AuthUser,
  targetUserId?: string,
): Promise<{ cancelled: number; overview: OutreachAutomationOverview }> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const now = new Date();
  const result = await AgentTask.updateMany(
    {
      projectId: config.projectId,
      userId: config.userId,
      outreachStep: { $in: [1, 2, 3] },
      status: 'queued',
    },
    {
      $set: { status: 'cancelled' },
      $unset: { leaseToken: 1, leaseUntil: 1 },
      $inc: { version: 1 },
      $push: {
        events: {
          $each: [{ at: now, message: '管理员/业务员主动清理积压排队任务，便于单条试跑验收。' }],
          $slice: -100,
        },
      },
    },
  );
  const overview = await getOutreachAutomationOverview(actor, target.id);
  return { cancelled: result.modifiedCount, overview };
}

/**
 * 仅恢复因 AI 通道熔断/并发保护（未实际发往上游）而误耗尽重试机会、被标记为 failed 的客户。
 * 严格不动：历史发信失败（草稿 status=failed）、合规停止（blocked）、已完成（completed）、
 * 以及真正发往上游连续失败满 3 次（如超时/502）的客户。
 * 恢复后错峰排程，受单账号并发上限（3）保护，不会瞬间打爆上游。
 */
export async function recoverCircuitFailedEnrollments(
  actor: AuthUser,
  targetUserId?: string,
  options?: { includeUpstreamAiFailures?: boolean },
): Promise<{
  scanned: number;
  recovered: number;
  skipped: number;
  overview: OutreachAutomationOverview;
}> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const now = new Date();
  const includeUpstream = Boolean(options?.includeUpstreamAiFailures);

  const failedRows = await OutreachAutomationEnrollment.find({
    ...scope(actor, target.id),
    campaignId: config._id,
    status: 'failed',
  }).sort({ updatedAt: 1 }).limit(500);

  let recovered = 0;
  let skipped = 0;

  for (const row of failedRows) {
    const customer = await Customer.findOne({
      _id: row.customerId,
      projectId: config.projectId,
      ownerId: config.userId,
    }).select('_id status email outreachStep outreachAbandonedAt outreachRepliedAt outreachLastAt').lean();
    if (!customer || !customer.email || !AUTO_TARGET_STATUSES.includes(customer.status as (typeof AUTO_TARGET_STATUSES)[number]) || customer.outreachAbandonedAt || customer.outreachRepliedAt) {
      skipped += 1;
      continue;
    }
    const step = Math.max(Number(customer.outreachStep ?? 0), await sentProgress(config.projectId, customer._id));
    if (step >= MAX_AUTO_STEPS) {
      skipped += 1;
      continue;
    }
    const nextStep = step + 1;
    // Never touch rows whose current-step letter failed SMTP delivery or has draft status anomaly.
    const existingLetter = await findDraft(config.projectId, customer._id, nextStep);
    if (existingLetter && existingLetter.status === 'failed') {
      skipped += 1;
      continue;
    }
    const recentFailedTasks = await AgentTask.find({
      projectId: config.projectId,
      userId: config.userId,
      customerId: customer._id,
      outreachStep: nextStep,
      status: 'failed',
    }).sort({ updatedAt: -1 }).limit(12).select('_id error').lean();

    const upstreamFailedCount = recentFailedTasks.filter((t) => !isCircuitRejectError(t.error)).length;
    const hasCircuitTask = recentFailedTasks.some((t) => isCircuitRejectError(t.error));
    const circuitReason = isCircuitFailedEnrollmentReason(row.lastError);
    const aiUpstreamReason = isAiUpstreamFailedEnrollmentReason(row.lastError);
    const hasAnyAiFailedTask = recentFailedTasks.length > 0;

    if (includeUpstream) {
      if (!aiUpstreamReason && !hasAnyAiFailedTask) {
        skipped += 1;
        continue;
      }
    } else if ((!circuitReason && !hasCircuitTask) || upstreamFailedCount >= 3) {
      skipped += 1;
      continue;
    }

    const cancelTaskIds = (includeUpstream
      ? recentFailedTasks
      : recentFailedTasks.filter((t) => isCircuitRejectError(t.error))
    ).map((t) => t._id);
    if (cancelTaskIds.length > 0) {
      await AgentTask.updateMany(
        { _id: { $in: cancelTaskIds }, status: 'failed' },
        {
          $set: { status: 'cancelled' },
          $unset: { leaseToken: 1, leaseUntil: 1 },
          $inc: { version: 1 },
          $push: {
            events: {
              $each: [{
                at: now,
                message: includeUpstream
                  ? '切换 AI 模型后清理旧模型失败任务记录并重置重试预算。'
                  : '清理因 AI 通道熔断/并发保护（未发往上游）导致的失败任务记录。',
              }],
              $slice: -100,
            },
          },
        },
      );
    }

    const staggeredAt = new Date(now.getTime() + recovered * 15_000);
    await markEnrollment(row._id, {
      status: config.enabled ? 'active' : 'paused',
      currentStep: step,
      nextRunAt: staggeredAt,
      lastError: null,
      attempts: 0,
    });
    recovered += 1;
  }

  const overview = await getOutreachAutomationOverview(actor, target.id);
  return {
    scanned: failedRows.length,
    recovered,
    skipped,
    overview,
  };
}

export type OutreachSendReadinessStatus =
  | 'ready_to_send'
  | 'paused_ready_to_resume'
  | 'waiting_buyer_window'
  | 'waiting_delivery'
  | 'delivery_cancelled'
  | 'blocked_by_send_gate'
  | 'blocked_by_audit'
  | 'delivery_failed'
  | 'task_in_progress'
  | 'task_failed'
  | 'completed'
  | 'stopped'
  | 'no_draft';

export interface OutreachEnrollmentDiagnostics {
  enrollmentId: string;
  customerId: string;
  customerName: string;
  company?: string;
  email?: string;
  enrollmentStatus: string;
  currentStep: number;
  nextStep: number;
  lastError?: string;
  pausedReadyToResume?: boolean;
  errorHistory?: { at: string; step?: number; message: string; resolvedAt?: string; resolvedReason?: string }[];
  sendReadiness: {
    status: OutreachSendReadinessStatus;
    label: string;
    detail: string;
    auditPassed: boolean;
    sendGatePassed: boolean;
    sendGateIssues: string[];
    sendGateDetail?: OutreachSendGateDetail;
    bodyHashValid?: boolean;
    knowledgeFresh?: boolean;
    staleSources?: { sourceId: string; title: string; reason: string }[];
    waitingForWindow: boolean;
    waitingForSchedule: boolean;
  };
  timezone: {
    effectiveTimezone: string;
    source: 'explicit' | 'country' | 'fallback';
    windowStart: string;
    windowEnd: string;
    windowOpen: boolean;
    nextSendAt: string;
    useBuyerTimezone: boolean;
    defaultTimezone: string;
  };
  latestTask: {
    id: string;
    status: string;
    currentStep?: string;
    currentStepLabel?: string;
    attempts: number;
    failureClass: 'circuit_rejected' | 'upstream_error' | 'none';
    errorCode?: string;
    errorMessage?: string;
    totalDurationMs: number;
    createdAt: string;
    updatedAt: string;
    steps: {
      key: string;
      label: string;
      state: string;
      attempts: number;
      durationMs?: number;
      error?: string;
      verifyMode?: string;
      checksCount?: number;
      issuesCount?: number;
      completeness?: string;
      failureCategory?: string;
      failureCode?: string;
    }[];
    recentEvents: { at: string; step?: string; message: string }[];
  } | null;
  latestDraft: {
    id: string;
    status: string;
    outreachStep?: number;
    subject: string;
    updatedAt: string;
    needsReverify: boolean;
    auditReason?: string;
    sendGateIssue?: string;
    completeness?: string;
    factAuditMode?: string;
    failureCategory?: FactAuditFailureCategory;
    failureCategoryLabel?: string;
    failureCode?: string;
    failureStage?: FactAuditStage;
    failureStageLabel?: string;
    failureDetail?: string;
    fastPath?: boolean;
    fallbackApplied?: boolean;
    fallbackNote?: string;
    tierSummary?: { red: number; yellow: number; green: number; proofBlocksUsed: string[] };
    checksTotal: number;
    checksSupported: number;
    checksNonClaim: number;
    checksFailed: number;
    failedChecks: {
      id: string;
      status: string;
      reason: string;
      excerpt: string;
    }[];
    contextWarnings?: { code: string; message: string }[];
    issues: { code: string; message: string }[];
  } | null;
}

/** 按单条客户串联最新 AI 任务各步骤耗时/错误码、草稿保存与逐项核验分层结果、发送检查及买家时区排程。 */
export async function getOutreachEnrollmentDiagnostics(
  actor: AuthUser,
  enrollmentId: string,
  targetUserId?: string,
): Promise<OutreachEnrollmentDiagnostics> {
  const target = await resolveTargetUser(actor, targetUserId);
  const config = await getConfig(actor, target.id);
  const enrollment = await OutreachAutomationEnrollment.findOne({
    _id: enrollmentId,
    ...scope(actor, target.id),
    campaignId: config._id,
  }).lean();
  if (!enrollment) throw ApiError.notFound('自动开发队列项不存在');

  const customer = await Customer.findOne({ _id: enrollment.customerId, projectId: config.projectId })
    .select('name company email status letterCount outreachStep nextFollowUpAt timezone country address phone')
    .lean();
  if (!customer) throw ApiError.notFound('客户不存在或已删除');

  const now = new Date();
  const actualStep = Math.min(
    MAX_AUTO_STEPS,
    Math.max(
      Number(customer.outreachStep ?? 0),
      Math.min(MAX_AUTO_STEPS, Number(customer.letterCount ?? 0)),
      Number(enrollment.currentStep ?? 0),
    ),
  );
  const nextStep = Math.min(MAX_AUTO_STEPS, actualStep + 1);

  const [latestTask, stepLetters, project] = await Promise.all([
    AgentTask.findOne({
      projectId: config.projectId,
      userId: config.userId,
      customerId: customer._id,
      outreachStep: nextStep,
    }).sort({ createdAt: -1 }).lean(),
    DevelopmentLetter.find({
      projectId: config.projectId,
      customerId: customer._id,
      outreachStep: nextStep,
      status: { $in: ['draft', 'queued', 'scheduled', 'sending', 'retrying', 'failed', 'cancelled'] },
    }).sort({ createdAt: -1 }).limit(10).lean(),
    Project.findById(config.projectId).select('code slug name companyName industry website mailFrom senderName brandProfile').lean(),
  ]);
  const nonSupersededLetters = stepLetters.filter((l) => !isSupersededArchiveCancellation(l));
  const latestDraft = nonSupersededLetters.find((l) => ACTIVE_LETTER_STATUSES.has(String(l.status)))
    ?? nonSupersededLetters[0]
    ?? null;

  const buyerSchedule = config.useBuyerTimezone || customer.timezone
    ? resolveBuyerTimezone({
      timezone: customer.timezone,
      country: customer.country,
      address: customer.address,
      phone: customer.phone,
    }, config.timezone)
    : { timezone: config.timezone, source: 'fallback' as const, workdays: [1, 2, 3, 4, 5] };
  const recipientWindow = {
    windowStart: config.windowStart,
    windowEnd: config.windowEnd,
    timezone: buyerSchedule.timezone,
    workdays: buyerSchedule.workdays,
  };
  const windowOpen = isWithinSendWindow(recipientWindow, now);
  const nextRunAt = new Date(enrollment.nextRunAt);
  const waitingForSchedule = nextRunAt.getTime() > now.getTime();
  const effectiveAt = nextSendWindow(recipientWindow, waitingForSchedule ? nextRunAt : now);

  const taskSteps = (latestTask?.workflowRecords ?? []).map((record) => {
    const payload = (record.payload ?? undefined) as {
      review?: {
        completeness?: string;
        factAudit?: { mode?: string; checks?: unknown[]; failureCategory?: string; failureCode?: string };
        issues?: unknown[];
      };
    } | undefined;
    return {
      key: String(record.key),
      label: workflowLabels[record.key] ?? String(record.key),
      state: String(record.state),
      attempts: Number(record.attempts ?? 1),
      ...(record.durationMs !== undefined ? { durationMs: Number(record.durationMs) } : {}),
      ...(record.error ? { error: String(record.error) } : {}),
      ...(record.key === 'audit_claims' && payload?.review ? {
        verifyMode: payload.review.factAudit?.mode,
        checksCount: payload.review.factAudit?.checks?.length ?? 0,
        issuesCount: payload.review.issues?.length ?? 0,
        completeness: payload.review.completeness,
        ...(payload.review.factAudit?.failureCategory ? { failureCategory: payload.review.factAudit.failureCategory } : {}),
        ...(payload.review.factAudit?.failureCode ? { failureCode: payload.review.factAudit.failureCode } : {}),
      } : {}),
    };
  });

  const audit = latestDraft ? inspectOutreachDraftAudit(latestDraft) : { needsReverify: false, contextWarnings: [] };
  const checks = latestDraft?.knowledgeReview?.factAudit?.checks ?? [];
  const failedChecks = checks
    .filter((c) => c.status !== 'supported' && c.status !== 'non_claim')
    .slice(0, 12)
    .map((c) => ({
      id: String(c.id),
      status: String(c.status),
      reason: String(c.reason || '未提供原因'),
      excerpt: String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }));
  const failureInfo = latestDraft && audit.needsReverify
    ? inferDraftAuditFailure(latestDraft.knowledgeReview)
    : {};

  const sendGateIssues: string[] = [];
  let bodyHashValid: boolean | undefined;
  let knowledgeFresh: boolean | undefined;
  let staleSources: { sourceId: string; title: string; reason: string }[] | undefined;
  let sendGateIssue: string | undefined;

  if (latestDraft?.status === 'draft') {
    if (latestDraft.review?.decision === 'rejected') {
      sendGateIssues.push('草稿已被人工标记为不通过');
    }
    if (latestDraft.knowledgeReview?.bodyHash) {
      bodyHashValid = draftHash(latestDraft.contentText) === latestDraft.knowledgeReview.bodyHash;
      if (!bodyHashValid) sendGateIssues.push('草稿正文在核验后发生变化（bodyHash 不匹配），需重新核验');
    } else {
      bodyHashValid = false;
      sendGateIssues.push('草稿缺少正文核验指纹（bodyHash）');
    }
    if (!latestDraft.subject?.trim() || !latestDraft.contentText?.trim() || /\{\{[^}]+\}\}/.test(latestDraft.contentText)) {
      sendGateIssues.push('草稿主题或正文不完整，或仍含未替换的占位符');
    }
    const automatedIssue = automatedReviewIssue(latestDraft.knowledgeReview, latestDraft.outreachStep, {
      bodyText: latestDraft.contentText,
      subject: latestDraft.subject,
      approvedOffers: project?.brandProfile?.approvedOffers,
      signature: resolveProjectSalesProfile(project).signature,
    });
    if (automatedIssue) {
      sendGateIssue = automatedIssue;
      if (!sendGateIssues.includes(automatedIssue)) sendGateIssues.push(automatedIssue);
    }
    if (latestDraft.knowledgeReview) {
      try {
        const targetActor = await getActorForConfig(config);
        const freshness = await knowledgeFreshness(latestDraft.knowledgeReview, targetActor);
        knowledgeFresh = !freshness.failed && freshness.changed.length === 0;
        if (!knowledgeFresh) {
          staleSources = freshness.changed.slice(0, 5);
          sendGateIssues.push(
            freshness.failed
              ? '知识库依据新鲜度校验失败，请重新核验'
              : `草稿引用的 ${freshness.changed.length} 条知识库依据已更新或过期，请重新核验`,
          );
        }
      } catch {
        knowledgeFresh = undefined;
      }
    }
  }

  const auditPassed = Boolean(latestDraft?.status === 'draft' && !audit.needsReverify);
  const sendGatePassed = auditPassed && sendGateIssues.length === 0;
  const taskInFlight = latestTask ? ['queued', 'running'].includes(String(latestTask.status)) : false;
  const projectSig = resolveProjectSalesProfile(project).signature;
  const primarySendGateIssue = sendGateIssue || sendGateIssues[0];
  const diagSendGateDetail = auditPassed && !sendGatePassed && primarySendGateIssue
    ? classifySendGateDetail(primarySendGateIssue, latestDraft, projectSig, project?.brandProfile?.approvedOffers)
    : undefined;
  const pausedReadyToResume = Boolean(
    enrollment.status === 'paused'
    && latestDraft?.status === 'draft'
    && sendGatePassed
    && !taskInFlight,
  );
  const rawDiagHistory = Array.isArray((enrollment as { errorHistory?: unknown[] }).errorHistory)
    ? ((enrollment as { errorHistory?: Array<{ at: Date; step?: number; message: string; resolvedAt?: Date; resolvedReason?: string }> }).errorHistory ?? [])
    : [];
  const diagErrorHistory = rawDiagHistory.slice(-10).map((item) => ({
    at: new Date(item.at).toISOString(),
    ...(item.step ? { step: Number(item.step) } : {}),
    message: String(item.message),
    ...(item.resolvedAt ? { resolvedAt: new Date(item.resolvedAt).toISOString() } : {}),
    ...(item.resolvedReason ? { resolvedReason: String(item.resolvedReason) } : {}),
  }));

  let sendReadiness: OutreachEnrollmentDiagnostics['sendReadiness'];
  if (enrollment.status === 'completed' || actualStep >= MAX_AUTO_STEPS) {
    sendReadiness = {
      status: 'completed',
      label: '三封开发信已完成',
      detail: '该客户已完成本轮全部自动开发步骤。',
      auditPassed: true,
      sendGatePassed: true,
      sendGateIssues: [],
      waitingForWindow: false,
      waitingForSchedule: false,
    };
  } else if (enrollment.status === 'blocked' && !isVerificationBlockedReason(enrollment.lastError)) {
    sendReadiness = {
      status: 'stopped',
      label: '按规则停止（非系统故障）',
      detail: enrollment.lastError || '客户已回复、退订或不在可开发状态，按业务规则保持停止。',
      auditPassed,
      sendGatePassed: false,
      sendGateIssues,
      ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
      ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
      ...(staleSources?.length ? { staleSources } : {}),
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  } else if (taskInFlight) {
    sendReadiness = {
      status: 'task_in_progress',
      label: latestTask?.status === 'running' ? '正在生成并核验草稿' : '已提交排队等待生成草稿',
      detail: '当前有进行中的 AI 草稿/核验任务，完成后将更新核验结论。',
      auditPassed: false,
      sendGatePassed: false,
      sendGateIssues,
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  } else if (latestDraft && WAITING_DELIVERY_STATUSES.has(String(latestDraft.status))) {
    sendReadiness = {
      status: 'waiting_delivery',
      label: `第 ${nextStep} 封等待投递（${latestDraft.status}）`,
      detail: '邮件已进入发信队列，正在等待邮件中心投递；无需重建草稿。',
      auditPassed: true,
      sendGatePassed: true,
      sendGateIssues: [],
      waitingForWindow: false,
      waitingForSchedule: false,
    };
  } else if (latestDraft?.status === 'cancelled') {
    sendReadiness = {
      status: 'delivery_cancelled',
      label: `第 ${nextStep} 封邮件已取消（未发送）`,
      detail: String(latestDraft.error || '该邮件已取消，不会再继续投递；如需重发，请点击「单条试跑」重新生成并核验。'),
      auditPassed: true,
      sendGatePassed: false,
      sendGateIssues: [],
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  } else if (latestDraft?.status === 'failed') {
    sendReadiness = {
      status: 'delivery_failed',
      label: `第 ${nextStep} 封邮件投递失败（SMTP）`,
      detail: String(latestDraft.error || '邮件投递失败（SMTP 拒绝或发送异常）；此项属于投递失败，不是草稿核验失败，请到开发信/邮件记录排查邮箱后处理。'),
      auditPassed: true,
      sendGatePassed: false,
      sendGateIssues: [],
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  } else if (latestDraft?.status === 'draft') {
    if (!auditPassed) {
      sendReadiness = {
        status: 'blocked_by_audit',
        label: failureInfo.failureCategoryLabel ? `正文核验未通过（${failureInfo.failureCategoryLabel}）` : '正文核验未通过',
        detail: failureInfo.failureDetail || audit.reason || '正文逐项核验尚未通过，正式发送已拦截。',
        auditPassed: false,
        sendGatePassed: false,
        sendGateIssues,
        ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
        ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
        ...(staleSources?.length ? { staleSources } : {}),
        waitingForWindow: !windowOpen,
        waitingForSchedule,
      };
    } else if (!sendGatePassed) {
      sendReadiness = {
        status: 'blocked_by_send_gate',
        label: diagSendGateDetail?.label || '正文核验通过，但其他发送检查未通过',
        detail: sendGateIssues.join('；'),
        auditPassed: true,
        sendGatePassed: false,
        sendGateIssues,
        ...(diagSendGateDetail ? { sendGateDetail: diagSendGateDetail } : {}),
        ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
        ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
        ...(staleSources?.length ? { staleSources } : {}),
        waitingForWindow: !windowOpen,
        waitingForSchedule,
      };
    } else if (pausedReadyToResume) {
      sendReadiness = {
        status: 'paused_ready_to_resume',
        label: '当前草稿检查已通过，队列仍暂停，待恢复',
        detail: '当前最新草稿已通过正文逐项核验与全部发送检查（旧拦截记录已归档至历史）。该客户队列当前仍为暂停状态，系统不会自动恢复正式发送，确认后请手动点击「恢复」。',
        auditPassed: true,
        sendGatePassed: true,
        sendGateIssues: [],
        ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
        ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
        waitingForWindow: !windowOpen,
        waitingForSchedule,
      };
    } else if (!windowOpen || waitingForSchedule) {
      sendReadiness = {
        status: 'waiting_buyer_window',
        label: !windowOpen ? '正文核验通过，等待买家当地发送时段' : '正文核验通过，等待下一次排程时间',
        detail: !windowOpen
          ? `全部发送检查已通过；当前不在买家当地（${buyerSchedule.timezone}）工作日 ${config.windowStart}-${config.windowEnd} 时段，预计 ${effectiveAt.toISOString()} 处理。`
          : `全部发送检查已通过；尚未到达下一次排程处理时间（${effectiveAt.toISOString()}）。`,
        auditPassed: true,
        sendGatePassed: true,
        sendGateIssues: [],
        ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
        ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
        waitingForWindow: !windowOpen,
        waitingForSchedule,
      };
    } else {
      sendReadiness = {
        status: 'ready_to_send',
        label: '正文核验通过，已满足全部发送检查',
        detail: config.enabled
          ? '正文核验、质量、依据新鲜度与买家当地时段全部就绪，等待自动开发下一轮轮询发送。'
          : '全部发送检查均已通过，但当前自动开发总开关处于暂停状态，恢复总开关后才会正式发送。',
        auditPassed: true,
        sendGatePassed: true,
        sendGateIssues: [],
        ...(bodyHashValid !== undefined ? { bodyHashValid } : {}),
        ...(knowledgeFresh !== undefined ? { knowledgeFresh } : {}),
        waitingForWindow: false,
        waitingForSchedule: false,
      };
    }
  } else if (latestTask?.status === 'failed') {
    const isCircuit = isCircuitRejectError(latestTask.error);
    sendReadiness = {
      status: 'task_failed',
      label: isCircuit ? 'AI 通道熔断/并发保护拦截（未发往上游）' : '草稿生成任务失败（上游或超时）',
      detail: humanizeTaskError(latestTask.error),
      auditPassed: false,
      sendGatePassed: false,
      sendGateIssues: [],
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  } else {
    sendReadiness = {
      status: 'no_draft',
      label: '尚未生成第 ' + nextStep + ' 封草稿',
      detail: '等待轮询创建草稿任务，或可点击「单条重新生成」立即验证。',
      auditPassed: false,
      sendGatePassed: false,
      sendGateIssues: [],
      waitingForWindow: !windowOpen,
      waitingForSchedule,
    };
  }

  const taskFailureClass: 'circuit_rejected' | 'upstream_error' | 'none' = latestTask?.status === 'failed'
    ? (isCircuitRejectError(latestTask.error) ? 'circuit_rejected' : 'upstream_error')
    : 'none';

  return {
    enrollmentId: String(enrollment._id),
    customerId: String(customer._id),
    customerName: customer.name,
    ...(customer.company ? { company: customer.company } : {}),
    ...(customer.email ? { email: customer.email } : {}),
    enrollmentStatus: enrollment.status,
    currentStep: actualStep,
    nextStep,
    ...(enrollment.lastError && !pausedReadyToResume && enrollment.lastError !== STALE_SAVED_SEND_ERROR ? { lastError: enrollment.lastError } : {}),
    ...(pausedReadyToResume ? { pausedReadyToResume: true } : {}),
    ...(diagErrorHistory.length ? { errorHistory: diagErrorHistory } : {}),
    sendReadiness,
    timezone: {
      effectiveTimezone: buyerSchedule.timezone,
      source: buyerSchedule.source,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      windowOpen,
      nextSendAt: effectiveAt.toISOString(),
      useBuyerTimezone: Boolean(config.useBuyerTimezone),
      defaultTimezone: config.timezone,
    },
    latestTask: latestTask ? {
      id: String(latestTask._id),
      status: String(latestTask.status),
      ...(latestTask.currentStep ? {
        currentStep: String(latestTask.currentStep),
        currentStepLabel: TASK_STEP_LABELS[String(latestTask.currentStep)] ?? String(latestTask.currentStep),
      } : {}),
      attempts: Number(latestTask.attempts ?? 0),
      failureClass: taskFailureClass,
      ...(latestTask.error?.code ? { errorCode: String(latestTask.error.code) } : {}),
      ...(latestTask.error ? { errorMessage: humanizeTaskError(latestTask.error) } : {}),
      totalDurationMs: Number(latestTask.workflowActiveMs ?? 0)
        || taskSteps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      createdAt: new Date(latestTask.createdAt).toISOString(),
      updatedAt: new Date(latestTask.updatedAt).toISOString(),
      steps: taskSteps,
      recentEvents: (latestTask.events ?? []).slice(-8).map((ev) => ({
        at: new Date(ev.at).toISOString(),
        ...(ev.step ? { step: String(ev.step) } : {}),
        message: String(ev.message),
      })),
    } : null,
    latestDraft: latestDraft ? {
      id: String(latestDraft._id),
      status: String(latestDraft.status),
      ...(latestDraft.outreachStep ? { outreachStep: Number(latestDraft.outreachStep) } : {}),
      subject: String(latestDraft.subject ?? ''),
      updatedAt: new Date(latestDraft.updatedAt).toISOString(),
      needsReverify: audit.needsReverify,
      ...(audit.reason ? { auditReason: audit.reason } : {}),
      ...(sendGateIssue ? { sendGateIssue } : {}),
      ...(latestDraft.knowledgeReview?.completeness ? { completeness: latestDraft.knowledgeReview.completeness } : {}),
      ...(latestDraft.knowledgeReview?.factAudit?.mode ? { factAuditMode: latestDraft.knowledgeReview.factAudit.mode } : {}),
      ...(latestDraft.knowledgeReview?.factAudit?.fastPath ? { fastPath: true } : {}),
      ...(latestDraft.knowledgeReview?.factAudit?.fallbackApplied ? { fallbackApplied: true } : {}),
      ...(latestDraft.knowledgeReview?.factAudit?.fallbackNote ? { fallbackNote: latestDraft.knowledgeReview.factAudit.fallbackNote } : {}),
      ...(latestDraft.knowledgeReview?.factAudit?.tierSummary ? { tierSummary: latestDraft.knowledgeReview.factAudit.tierSummary } : {}),
      ...failureInfo,
      checksTotal: checks.length,
      checksSupported: checks.filter((c) => c.status === 'supported').length,
      checksNonClaim: checks.filter((c) => c.status === 'non_claim').length,
      checksFailed: checks.filter((c) => c.status !== 'supported' && c.status !== 'non_claim').length,
      failedChecks,
      ...(audit.contextWarnings.length > 0 ? { contextWarnings: audit.contextWarnings } : {}),
      issues: (latestDraft.knowledgeReview?.issues ?? []).map((i) => ({ code: i.code, message: i.message })),
    } : null,
  };
}

async function markEnrollment(
  enrollmentId: Types.ObjectId,
  set: Record<string, unknown>,
  inc?: Record<string, number>,
): Promise<void> {
  await OutreachAutomationEnrollment.updateOne(
    { _id: enrollmentId },
    { $set: set, ...(inc ? { $inc: inc } : {}) },
  );
}

async function sentProgress(projectId: Types.ObjectId, customerId: Types.ObjectId): Promise<number> {
  const sent = await DevelopmentLetter.find({
    projectId,
    customerId,
    status: { $in: ['sent', 'opened'] },
  }).select('outreachStep').lean();
  const explicit = sent
    .map((letter) => Number(letter.outreachStep))
    .filter((step) => Number.isInteger(step) && step >= 1 && step <= MAX_AUTO_STEPS);
  return Math.min(MAX_AUTO_STEPS, Math.max(sent.length, ...explicit, 0));
}

async function findDraft(projectId: Types.ObjectId, customerId: Types.ObjectId, step: number) {
  return DevelopmentLetter.findOne({
    projectId,
    customerId,
    outreachStep: step,
    // Exclude 'cancelled' drafts so superseded/re-verified stale drafts never block fresh regenerated drafts.
    status: { $in: ['draft', 'queued', 'scheduled', 'sending', 'retrying', 'sent', 'opened', 'failed'] },
  }).sort({ createdAt: -1 });
}

async function hasActiveTask(projectId: Types.ObjectId, customerId: Types.ObjectId, step: number) {
  return AgentTask.exists({
    projectId,
    customerId,
    outreachStep: step,
    status: { $in: ['queued', 'running', 'paused', 'waiting_input', 'awaiting_review'] },
  });
}

function effectiveDailyLimit(config: InstanceType<typeof OutreachAutomationConfig>): number {
  return config.rolloutMode === 'pilot' ? Math.min(5, config.dailyLimit) : config.dailyLimit;
}

async function processEnrollment(
  config: InstanceType<typeof OutreachAutomationConfig>,
  enrollment: InstanceType<typeof OutreachAutomationEnrollment>,
  actor: AuthUser,
  now: Date,
  allowSend: boolean,
): Promise<{ sent: boolean; queued?: boolean }> {
  const customer = await Customer.findOne({
    _id: enrollment.customerId,
    projectId: config.projectId,
    ownerId: config.userId,
  });
  if (!customer) {
    await markEnrollment(enrollment._id, { status: 'blocked', lastError: '客户已删除或归属已变化' });
    return { sent: false };
  }
  const step = Math.max(Number(customer.outreachStep ?? 0), await sentProgress(config.projectId, customer._id));
  if (step >= MAX_AUTO_STEPS) {
    await markEnrollment(enrollment._id, { status: 'completed', currentStep: step, lastError: null });
    return { sent: false };
  }
  const replied = Boolean(customer.outreachRepliedAt)
    || await hasInboundReplySince(config.projectId, customer._id, customer.outreachLastAt);
  if (replied) {
    await cancelPendingOutreachLetters(config.projectId, customer._id);
  }
  if (!AUTO_TARGET_STATUSES.includes(customer.status as (typeof AUTO_TARGET_STATUSES)[number])
    || replied
    || customer.outreachAbandonedAt) {
    await markEnrollment(enrollment._id, {
      status: 'blocked',
      currentStep: step,
      lastError: replied ? '客户已回复，自动开发已停止' : '客户已不在可开发状态',
    });
    return { sent: false };
  }
  if (await hasProtectedCustomerMail(String(customer._id), String(config.projectId))) {
    await markEnrollment(enrollment._id, { status: 'blocked', lastError: '检测到退订、退信或拒绝信号，已停止自动开发' });
    return { sent: false };
  }

  await markEnrollment(enrollment._id, { currentStep: step });
  const nextStep = step + 1;
  if (nextStep > 1) {
    const due = customer.nextFollowUpAt ? new Date(customer.nextFollowUpAt) : null;
    if (due && due.getTime() > now.getTime()) {
      await markEnrollment(enrollment._id, { nextRunAt: due, lastError: null });
      return { sent: false };
    }
  }

  const draft = await findDraft(config.projectId, customer._id, nextStep);
  if (!draft) {
    if (await hasActiveTask(config.projectId, customer._id, nextStep)) {
      await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 30_000) });
      return { sent: false };
    }
    // Check recent failed tasks for this exact (customer, step).
    // CRITICAL: Distinguish local circuit-breaker/capacity rejections (never sent to upstream)
    // from actual upstream attempts (timeout / 502 / workflow limit).
    // Never let circuit rejections burn the 3-failure customer budget!
    const recentFailed = await AgentTask.find({
      projectId: config.projectId,
      userId: config.userId,
      customerId: customer._id,
      outreachStep: nextStep,
      status: 'failed',
      createdAt: { $gte: new Date(now.getTime() - DAY_MS) },
    }).sort({ updatedAt: -1 }).limit(12).select('error updatedAt currentStep').lean();
    const upstreamFailed = recentFailed.filter((t) => !isCircuitRejectError(t.error));
    const circuitFailed = recentFailed.filter((t) => isCircuitRejectError(t.error));

    if (upstreamFailed.length > 0) {
      const latestUpstreamFail = upstreamFailed[0]!;
      const reason = humanizeTaskError(latestUpstreamFail.error);
      if (upstreamFailed.length >= 3) {
        await markEnrollment(enrollment._id, {
          status: 'failed',
          lastError: `AI 上游连续失败 ${upstreamFailed.length} 次（${reason}），已停止自动重建，请单条试跑排查`,
          nextRunAt: new Date(now.getTime() + DAY_MS),
        });
        return { sent: false };
      }
      const backoffMs = TASK_BACKOFF_MS[Math.min(upstreamFailed.length - 1, TASK_BACKOFF_MS.length - 1)];
      const retryAt = new Date(new Date(latestUpstreamFail.updatedAt).getTime() + backoffMs);
      if (now.getTime() < retryAt.getTime()) {
        await markEnrollment(enrollment._id, {
          lastError: `AI 上游失败（${reason}），等待自动退避重试`,
          nextRunAt: retryAt,
        });
        return { sent: false };
      }
    }

    // Do NOT create doomed AgentTasks while the AI circuit breaker is open/probing;
    // defer cleanly until cooldown expires without burning customer retries.
    const circuit = modelCircuitState();
    if (circuit.open) {
      await markEnrollment(enrollment._id, {
        lastError: 'AI 通道熔断冷却中（未发往上游，不计入失败次数），探测恢复后自动继续',
        nextRunAt: new Date(now.getTime() + Math.max(circuit.cooldownRemainingMs, 30_000)),
      });
      return { sent: false };
    }
    if (circuitFailed.length > 0) {
      const latestCircuitFail = circuitFailed[0]!;
      const circuitRetryAt = new Date(new Date(latestCircuitFail.updatedAt).getTime() + 30_000);
      if (now.getTime() < circuitRetryAt.getTime()) {
        await markEnrollment(enrollment._id, {
          lastError: 'AI 通道刚触发熔断保护（未发往上游，不计入失败次数），等待冷却后自动恢复',
          nextRunAt: circuitRetryAt,
        });
        return { sent: false };
      }
    }
    // Backpressure cap: never flood 60 queued tasks into the worker while the AI provider is busy/slow.
    const inFlightCampaignTasks = await AgentTask.countDocuments({
      projectId: config.projectId,
      userId: config.userId,
      outreachStep: { $in: [1, 2, 3] },
      status: { $in: ['queued', 'running'] },
    });
    if (inFlightCampaignTasks >= MAX_INFLIGHT_OUTREACH_TASKS) {
      await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 60_000) });
      return { sent: false };
    }
    if (enrollment.queuedStep === nextStep && enrollment.queuedAt
      && now.getTime() - new Date(enrollment.queuedAt).getTime() < 60_000) {
      await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 30_000) });
      return { sent: false };
    }
    try {
      const queued = await queueOutreachStep(actor, String(customer._id), nextStep as OutreachStep);
      await markEnrollment(enrollment._id, {
        status: 'active',
        queuedStep: nextStep,
        queuedAt: now,
        nextRunAt: new Date(now.getTime() + 30_000),
        lastError: null,
        ...(queued.taskId ? { taskIds: [...enrollment.taskIds, new Types.ObjectId(queued.taskId)] } : {}),
      });
    } catch (error) {
      const attempts = Number(enrollment.attempts ?? 0) + 1;
      const message = error instanceof Error ? error.message : '第几封草稿生成失败';
      await markEnrollment(
        enrollment._id,
        {
          status: attempts >= 3 ? 'failed' : 'active',
          lastError: message,
          nextRunAt: new Date(now.getTime() + (attempts >= 3 ? DAY_MS : 5 * 60_000)),
        },
        { attempts: 1 },
      );
    }
    return { sent: false, queued: true };
  }

  if (['sent', 'opened'].includes(draft.status)) {
    await markEnrollment(enrollment._id, { currentStep: nextStep, nextRunAt: now });
    return { sent: false };
  }
  if (['queued', 'scheduled', 'sending', 'retrying'].includes(draft.status)) {
    await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 60_000) });
    return { sent: false };
  }
  if (draft.status !== 'draft') {
    await markEnrollment(enrollment._id, { status: 'failed', lastError: `第 ${nextStep} 封状态异常：${draft.status}` });
    return { sent: false };
  }
  if (draft.review?.decision === 'rejected') {
    await markEnrollment(enrollment._id, { status: 'paused', lastError: '草稿已被人工标记为不通过，自动发送已暂停' });
    return { sent: false };
  }
  if (draft.needsReview) {
    await markEnrollment(enrollment._id, { status: 'blocked', lastError: '草稿的核验未通过，已跳过该客户' });
    return { sent: false };
  }
  if (!draft.knowledgeReview) {
    await markEnrollment(enrollment._id, { status: 'blocked', lastError: '草稿缺少依据审核，已跳过该客户' });
    return { sent: false };
  }
  if (draft.knowledgeReview.bodyHash && draftHash(draft.contentText) !== draft.knowledgeReview.bodyHash) {
    await markEnrollment(enrollment._id, { status: 'paused', lastError: '草稿内容在生成后发生变化，自动发送已暂停' });
    return { sent: false };
  }
  if (!draft.subject?.trim() || !draft.contentText?.trim() || /\{\{[^}]+\}\}/.test(draft.contentText)) {
    await markEnrollment(enrollment._id, { status: 'failed', lastError: '草稿内容不完整或仍有未替换的占位符' });
    return { sent: false };
  }
  if (config.rolloutMode === 'shadow') {
    try {
      await assertAutomaticDraftCanSend(draft, actor);
      await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + DAY_MS), lastError: '模拟校验通过' });
    } catch (error) {
      await markEnrollment(enrollment._id, { status: 'blocked', lastError: error instanceof ApiError ? error.message : '模拟校验未完成' });
    }
    return { sent: false };
  }
  // Per-recipient local timezone, DST, and local working day check
  const buyerSchedule = config.useBuyerTimezone || customer.timezone
    ? resolveBuyerTimezone({ timezone: customer.timezone, country: customer.country, address: customer.address, phone: customer.phone }, config.timezone)
    : { timezone: config.timezone, source: 'fallback' as const, workdays: [1, 2, 3, 4, 5] };
  const recipientWindow = {
    windowStart: config.windowStart,
    windowEnd: config.windowEnd,
    timezone: buyerSchedule.timezone,
    workdays: buyerSchedule.workdays,
  };
  const recipientWindowOpen = isWithinSendWindow(recipientWindow, now);
  if ((!config.useBuyerTimezone && !customer.timezone && !allowSend) || !recipientWindowOpen) {
    // 夜间/非当地工作日仍然可以准备下一封草稿，但不能越过买家当地发送时段。
    await markEnrollment(enrollment._id, {
      nextRunAt: nextSendWindow(recipientWindow, now),
      lastError: null,
    });
    return { sent: false };
  }
  if (await domainAtLimit(config._id, draft.recipientEmail, config.perDomainLimit, now)) {
    await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 30 * 60_000) });
    return { sent: false };
  }
  if (!await reserveDay(config.projectId, config._id, config.timezone, effectiveDailyLimit(config), now)) {
    await markEnrollment(enrollment._id, { nextRunAt: new Date(now.getTime() + 60 * 60_000) });
    return { sent: false };
  }

  try {
    const result = await resendLetter(
      String(draft._id),
      {
        markAsDeveloped: true,
        requestKey: `auto-${String(config._id)}-${String(enrollment._id)}-step${nextStep}`,
      },
      actor,
      { campaignId: config._id, enrollmentId: enrollment._id },
    );
    if (!result.delivered) {
      const actualStatus = String(result.letter?.status ?? '');
      if (WAITING_DELIVERY_STATUSES.has(actualStatus)) {
        await markEnrollment(enrollment._id, {
          nextRunAt: new Date(now.getTime() + 60_000),
          lastError: null,
        });
        return { sent: false };
      }
      if (actualStatus === 'cancelled') {
        const cancelReason = result.letter?.error
          ? `第 ${nextStep} 封邮件已取消（未发送）：${result.letter.error}`
          : `第 ${nextStep} 封邮件已取消（未发送）`;
        throw new Error(cancelReason);
      }
      throw new Error(result.message || 'SMTP 未接受自动开发信');
    }
    const refreshed = await Customer.findById(customer._id).select('outreachStep nextFollowUpAt').lean();
    const sentStep = Number(refreshed?.outreachStep ?? nextStep);
    await markEnrollment(enrollment._id, {
      status: sentStep >= MAX_AUTO_STEPS ? 'completed' : 'active',
      currentStep: sentStep,
      nextRunAt: refreshed?.nextFollowUpAt ?? new Date(now.getTime() + 3 * DAY_MS),
      lastSentAt: now,
      lastError: null,
      queuedStep: undefined,
      queuedAt: undefined,
    });
    const nextPacingAt = new Date(now.getTime() + nextRandomizedPacingMs(config.minPacingSeconds, config.maxPacingSeconds));
    await OutreachAutomationConfig.updateOne({ _id: config._id }, { $set: { nextPacingAt } }).catch(() => undefined);
    logger.info(`自动开发已发送：customer=${String(customer._id)} step=${sentStep}`);
    return { sent: true };
  } catch (error) {
    await releaseDay(config._id, config.timezone, now);
    const message = error instanceof Error ? error.message : '自动发送失败';
    await markEnrollment(enrollment._id, {
      status: 'paused',
      lastError: message,
      nextRunAt: new Date(now.getTime() + 10 * 60_000),
    });
    logger.warn(`自动开发暂停一个客户：${message}`);
    return { sent: false };
  }
}

let ticking = false;

export async function tickOutreachAutomation(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  const syncedProjects = new Set<string>();
  try {
    const configs = await OutreachAutomationConfig.find({ enabled: true }).sort({ lastTickAt: 1, _id: 1 }).limit(50);
    for (const config of configs) {
      await OutreachAutomationConfig.updateOne({ _id: config._id }, { $set: { lastTickAt: now } });
      if (!await campaignPacingReady(config, now)) continue;
      let actor: AuthUser;
      try {
        actor = await getActorForConfig(config);
      } catch (error) {
        await OutreachAutomationConfig.updateOne(
          { _id: config._id },
          { $set: { enabled: false, pausedReason: error instanceof Error ? error.message : '账号或项目不可用' }, $inc: { version: 1 } },
        );
        await OutreachAutomationEnrollment.updateMany(
          { campaignId: config._id, status: 'active' },
          { $set: { status: 'paused', nextRunAt: now } },
        );
        continue;
      }

      const processCampaign = async () => {
      const risk = config.rolloutMode === 'shadow' ? undefined : await campaignPauseReason(config.projectId, config._id, now, actor.organizationId);
      if (risk) {
        await OutreachAutomationConfig.updateOne({ _id: config._id, enabled: true }, {
          $set: { enabled: false, pausedReason: risk }, $inc: { version: 1 },
        });
        await OutreachAutomationEnrollment.updateMany({ campaignId: config._id, status: 'active' }, {
          $set: { status: 'paused', nextRunAt: now },
        });
        return;
      }
      const mailbox = await getCurrentMailSender(String(config.projectId), String(config.userId));
      if (config.rolloutMode !== 'shadow' && (!mailbox.canSend || mailbox.channel !== 'smtp')) {
        await OutreachAutomationConfig.updateOne(
          { _id: config._id },
          {
            $set: {
              enabled: false,
              pausedReason: mailbox.reason || '个人发件邮箱不可用，自动开发已暂停',
            },
            $inc: { version: 1 },
          },
        );
        await OutreachAutomationEnrollment.updateMany(
          { campaignId: config._id, status: 'active' },
          { $set: { status: 'paused', nextRunAt: now } },
        );
        return;
      }

      const allowSend = isWithinSendWindow(configDto(config), now);
      const today = await OutreachAutomationDay.findOne({
        campaignId: config._id,
        day: dayIn(config.timezone, now),
      }).select('sent').lean();
      if (config.rolloutMode !== 'shadow' && Number(today?.sent ?? 0) >= effectiveDailyLimit(config)) return;
      if (!syncedProjects.has(String(config.projectId))) {
        syncedProjects.add(String(config.projectId));
        try {
          await syncOutreachFollowUps(config.projectId, now);
        } catch (error) {
          logger.warn(`自动开发同步回复失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const rows = await OutreachAutomationEnrollment.find({
        campaignId: config._id,
        status: 'active',
        nextRunAt: { $lte: now },
      }).sort({ nextRunAt: 1 }).limit(20);

      for (const row of rows) {
        const result = await processEnrollment(config, row, actor, now, allowSend);
        if (result.sent || result.queued) break;
      }
      };
      if (actor.organizationId) await runWithTenant({ organizationId: actor.organizationId, source: 'outreach-worker' }, processCampaign);
      else await processCampaign();
    }
  } catch (error) {
    logger.warn(`自动开发 tick 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    ticking = false;
  }
}

let timer: NodeJS.Timeout | undefined;

export function startOutreachAutomationWorker(): void {
  if (timer || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
  timer = setInterval(() => {
    void tickOutreachAutomation().catch((error) => {
      logger.warn('自动开发 worker 失败', error instanceof Error ? error.message : String(error));
    });
  }, TICK_MS);
  timer.unref?.();
}

export function stopOutreachAutomationWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
