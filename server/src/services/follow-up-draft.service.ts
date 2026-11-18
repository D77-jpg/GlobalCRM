import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { createLogger } from '../config/logger';
import { DevelopmentLetter, Project } from '../models';
import { getCustomerByIdOrThrow } from './customer.service';
import { createCustomerAnalysis } from './agent/customer-analysis.service';
import { previousOutreachDrafts } from './agent/outreach-history';
import { salutationFor } from './agent/knowledge-grounding';
import { knowledgeReviewSendIssue } from './agent/knowledge-send-gate';
import { resolveProjectSalesProfile, outreachStepGoal, type OutreachStep } from './project-profile';
import { stripSignatureText } from './letter-signature';
import { OUTREACH_MAX_STEPS } from '../constants';
import { escapeHtml, stripReplySubjectPrefix } from '../utils/text';

const log = createLogger('follow-up-draft');

export interface FollowUpDraft {
  subject: string;
  content: string;
  text: string;
  step: number;
  previousSubject: string;
  previousSentAt: string;
  source: 'ai' | 'template';
  note: string;
}

function toHtml(text: string): string {
  return text.split(/\n{2,}/).filter(Boolean).map(paragraph => '<p>' + escapeHtml(paragraph).replace(/\n/g, '<br>') + '</p>').join('\n');
}

export async function draftFollowUpLetter(customerId: string, actor: AuthUser): Promise<FollowUpDraft> {
  const customer = await getCustomerByIdOrThrow(customerId, actor);
  const previous = await DevelopmentLetter.findOne({
    projectId: customer.projectId, customerId: customer._id, status: { $in: ['sent', 'opened'] },
  }).sort({ sentAt: -1, createdAt: -1 }).select('sentAt createdAt subject contentText outreachStep updatedAt').lean();

  if (!previous) throw ApiError.badRequest('这个客户还没有发出过开发信，先发第 1 封再跟');

  const step = Math.min(OUTREACH_MAX_STEPS, Math.max(1, Number(customer.outreachStep || previous.outreachStep || 1)) + 1) as OutreachStep;
  const previousSubject = previous.subject || '(no subject)';
  const previousSentAt = (previous.sentAt ?? previous.createdAt).toISOString();
  const subject = stripReplySubjectPrefix(previousSubject);
  const project = await Project.findById(customer.projectId).select('code slug name companyName industry website mailFrom senderName brandProfile').lean();
  const profile = resolveProjectSalesProfile(project);
  const createDraft = (text: string, source: FollowUpDraft['source'], note: string): FollowUpDraft => ({
    subject, content: toHtml(text), text, step, previousSubject, previousSentAt, source, note,
  });

  try {
    const history = await previousOutreachDrafts(String(customer.projectId), customerId, step);
    const analysis = await createCustomerAnalysis({
      customerId,
      idempotencyKey: ['followup', String(previous._id), step, customer.updatedAt.getTime(), previous.updatedAt.getTime()].join(':'),
    }, actor, {
      firstOutreach: true, outreachStep: step, taskKind: 'first_outreach', userRequest: outreachStepGoal(profile, step),
      previousOutreach: history.length ? history : [{ step: step - 1, subject: previousSubject, bodyText: stripSignatureText(previous.contentText, [], profile.signature).slice(0, 1800) }],
    });
    const text = stripSignatureText(analysis.emailDraft.bodyText, [], profile.signature);
    if (text && analysis.knowledgeReview && !knowledgeReviewSendIssue(analysis.knowledgeReview)) {
      return createDraft(text, 'ai', '已按实际发送内容和当前项目依据生成跟进草稿');
    }
  } catch {
    log.warn('Follow-up draft generation was unavailable');
  }

  const greeting = salutationFor(customer.name, customer.company);
  const text = step === 3
    ? [greeting, 'I will leave it here for now.', 'If someone else handles this area, could you point me in the right direction?', 'Thank you for your time.']
    : [greeting, 'I wanted to make the next step easy.', 'If this is an area you are reviewing, would sharing one priority help us narrow down what to discuss?'];
  return createDraft(text.join('\n\n'), 'template', '当前资料不足，已生成可编辑的简短跟进');
}
