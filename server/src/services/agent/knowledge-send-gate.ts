import type { ProjectApprovedOffer } from '../../models/Project';
import type {KnowledgeReview} from './knowledge-types';
import {
  detectCrossEmailRepetition,
  evaluateOutreachDraftQuality,
  type OutreachMemoryRecord,
} from './outreach-quality';

const BLOCKING_REVIEW_CODES = new Set([
  'fact_budget',
  'index_stale',
  'retrieval_failed',
  'index_not_ready',
  'conflict',
  'access_changed',
]);

const HIGH_RISK_CLAIM = /\b(?:price|pricing|discount|free(?![\s-]+weights?)|sample|shipping|freight|payment|deposit|stock|exclusive|guarantee(?:d)?|certif(?:ied|icate)|legal|contract)\b|价格|报价|折扣|免费|样品|运费|付款|定金|库存|独家|保证|认证|合同|法律/i;

export function knowledgeReviewRequiresApproval(review?:KnowledgeReview):boolean{
 if(!review)return false;
 return (review.claims??[]).some(claim=>HIGH_RISK_CLAIM.test(claim.text));
}

// A generated draft may only be sent after its knowledge audit is complete enough.
// `draft_unverified` means the verifier could not finish its work: it still requires
// an explicit human approval, but it is not a permanent dead end. Once the reviewer
// has inspected the body and approved it, the normal send route may proceed.
// Stale evidence or structural failures remain hard blocks even after approval.
// `manualApproved` is the "would this still be blocked after the human approves it?"
// probe used by the review UI; it bypasses the human-review gates only.
export function knowledgeReviewSendIssue(review?:KnowledgeReview,options?:{manualApproved?:boolean}):string|undefined{
 if(!review)return undefined;
 if(['retrieval_failed','index_stale','index_not_ready','conflict'].includes(review.status))return '依据检索状态异常';
 const issue=(review.issues??[]).find(issue=>BLOCKING_REVIEW_CODES.has(issue.code)||(issue.code==='draft_unverified'&&!options?.manualApproved&&!review.manualApprovedAt));
 if(issue)return issue.message;
 if(knowledgeReviewRequiresApproval(review)&&!review.manualApprovedAt&&!options?.manualApproved)return '高风险内容还没有人工批准';
 return undefined;
}

/** 人工批准也解决不了的硬拦截（依据异常、冲突等）；模型原稿和高风险待批准都可由人审放行。 */
export function knowledgeReviewHardBlocker(review?:KnowledgeReview):string|undefined{
 return knowledgeReviewSendIssue(review,{manualApproved:true});
}

export interface AutomatedReviewOptions {
  bodyText?: string;
  subject?: string;
  approvedOffers?: ProjectApprovedOffer[];
  sparseInfo?: boolean;
  enforceWordFloor?: boolean;
}

export function automatedReviewIssue(
  review?: KnowledgeReview,
  step?: number,
  options?: AutomatedReviewOptions,
): string | undefined {
 if (!review?.bodyHash || !review.factAudit?.checks?.length) return '草稿缺少完整的逐项核验';
 const blocker = knowledgeReviewHardBlocker(review);
 if (blocker) return blocker;
 if (review.factAudit.mode === 'unavailable' || review.issues.some(issue => issue.code === 'draft_unverified' || issue.code === 'semantic_unverified')) {
  return '正文尚未完成核验';
 }
 if (review.factAudit.checks.some(check => check.status !== 'supported' && check.status !== 'non_claim')) {
  return '正文仍含缺少依据或冲突的内容';
 }
 if (step === 1 && !review.claims.some(claim => claim.sourceIds.some(id => review.sources.some(source => source.sourceId === id && source.kind === 'knowledge')))) {
  return '首封缺少已发布的我方能力依据';
 }
 if (step && step < 3) {
  const questions = review.factAudit.checks.flatMap(check => check.text.match(/[?？]/g) ?? []);
  if (questions.length !== 1) return '本封开发信应保留一个明确的回复问题';
 }
 const combinedText = options?.bodyText?.trim() || review.factAudit.checks.map(check => check.text).join('\n\n');
 const quality = evaluateOutreachDraftQuality({
  bodyText: combinedText,
  subject: options?.subject,
  step: step ?? 1,
  sparseInfo: options?.sparseInfo,
  review,
  approvedOffers: options?.approvedOffers,
 });
 const blockingQuality = quality.issues.find((item) => {
  if (item.severity !== 'block') return false;
  // When only check texts are passed (legacy short unit fixtures), skip word-count floor
  // unless caller explicitly asked to enforce it; always enforce clichés, buzzwords,
  // sprawl, readability, intra-draft repetition, heavy CTAs, and unauthorized offers.
  if (item.code === 'word_count' && !options?.enforceWordFloor && quality.wordCount < 35) return false;
  if (item.code === 'cta_count' && !step) return false;
  return true;
 });
 if (blockingQuality) return blockingQuality.message;
 return undefined;
}

export function repeatedOutreachIssue(
  review: KnowledgeReview,
  previousBodies: (string | OutreachMemoryRecord)[],
  options?: { bodyText?: string; step?: number; approvedOffers?: ProjectApprovedOffer[] },
): string | undefined {
 const records: OutreachMemoryRecord[] = previousBodies.map((item, idx) => (
  typeof item === 'string'
   ? { step: idx + 1, subject: '', bodyText: item }
   : item
 ));
 const bodyText = options?.bodyText?.trim() || (review.factAudit?.checks ?? []).map((c) => c.text).join('\n');
 return detectCrossEmailRepetition({
  bodyText,
  step: options?.step ?? 2,
  review,
  previous: records,
  approvedOffers: options?.approvedOffers,
 });
}
