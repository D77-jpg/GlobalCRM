import type {KnowledgeReview} from './knowledge-types';

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

export function automatedReviewIssue(review?: KnowledgeReview, step?: number): string | undefined {
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
 if (review.factAudit.checks.some(check => /\b(?:i am reaching out to introduce|we are a leading manufacturer|high quality and competitive pric(?:e|es|ing)|following up on my email of)\b/i.test(check.text))) {
  return '正文仍包含生硬的群发套话';
 }
 return undefined;
}

export function repeatedOutreachIssue(review: KnowledgeReview, previousBodies: string[]): string | undefined {
 const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
 const sentences = (text: string) => text.split(/[.!?。！？\n]/u).map(normalize).filter(line => line.split(' ').length >= 5);
 const previous = new Set(previousBodies.flatMap(sentences));
 const proof = review.claims.flatMap(claim => sentences(claim.text));
 const questions = (text: string) => [...text.matchAll(/([^.!?。！？\n]+)[?？]/gu)].map(match => normalize(match[1] ?? '')).filter(Boolean);
 const asked = new Set(previousBodies.flatMap(questions));
 if (proof.length && proof.every(sentence => previous.has(sentence))) return '跟进内容重复了前一封的证明点';
 if (review.factAudit?.checks.some(check => questions(check.text).some(question => asked.has(question)))) return '跟进内容重复了之前的提问';
 return undefined;
}
