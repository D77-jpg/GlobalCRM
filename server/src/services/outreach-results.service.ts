import type { Types } from 'mongoose';
import { DevelopmentLetter, EmailSuppression } from '../models';
import { MailMessage } from '../models/MailMessage';
import { freshReplyText } from '../utils/text';
import { detectProtectedMailSignal } from './agent/mail-thread-analysis.service';

const DAY = 86_400_000;
const delivered = ['sent', 'opened'];

async function campaignAttempts(projectId: Types.ObjectId, campaignId: Types.ObjectId, since: Date) {
  return DevelopmentLetter.find({ projectId, automationCampaignId: campaignId, $or: [
    { status: { $in: delivered }, sentAt: { $gte: since } },
    { status: 'failed', hardBouncedAt: { $gte: since } },
  ] }).select('customerId recipientEmail messageId status sentAt createdAt outreachStep automationRuleVersion tracking.openedAt tracking.clickedAt tracking.automatedOpenCount tracking.automatedClickCount tracking.unclassifiedOpenedAt tracking.unclassifiedClickedAt knowledgeReview.context.playbook.segmentCode knowledgeReview.context.playbook.segmentName')
    .sort({ createdAt: 1 }).limit(650).lean();
}

type Attempt = Awaited<ReturnType<typeof campaignAttempts>>[number];

async function suppressionSignals(attempts: Attempt[], organizationId?: string) {
  const firstAttempt = new Map<string, Date>();
  for (const attempt of attempts) {
    const date = attempt.sentAt ?? attempt.createdAt;
    const email = attempt.recipientEmail.toLowerCase();
    if (!firstAttempt.has(email) || firstAttempt.get(email)! > date) firstAttempt.set(email, date);
  }
  if (!firstAttempt.size) return [];
  const signals = await EmailSuppression.find({ organizationId: organizationId ?? null, email: { $in: [...firstAttempt.keys()] },
    reason: { $in: ['hard_bounce', 'unsubscribe', 'complaint', 'spam'] }, source: { $in: ['link', 'inbound', 'smtp'] },
  }).select('email createdAt reason').lean();
  return signals.filter(signal => signal.createdAt >= firstAttempt.get(signal.email)!);
}

export async function campaignPauseReason(projectId: Types.ObjectId, campaignId: Types.ObjectId, now: Date, organizationId?: string): Promise<string | undefined> {
  const attempts = await campaignAttempts(projectId, campaignId, new Date(now.getTime() - 7 * DAY));
  const signals = await suppressionSignals(attempts, organizationId);
  if (signals.some(signal => signal.reason === 'complaint' || signal.reason === 'spam')) return '近期收到自动开发相关投诉，已暂停该邮箱的自动开发';
  const recipients = new Set(attempts.map(attempt => attempt.recipientEmail.toLowerCase()));
  const bounces = new Set([...attempts.filter(attempt => attempt.status === 'failed').map(attempt => attempt.recipientEmail.toLowerCase()),
    ...signals.filter(signal => signal.reason === 'hard_bounce').map(signal => signal.email)]);
  if (bounces.size >= 3 && bounces.size / recipients.size >= 0.10) return '近七天硬退信异常，已暂停该邮箱的自动开发';
  const optOuts = new Set(signals.filter(signal => signal.reason === 'unsubscribe').map(signal => signal.email));
  if (optOuts.size >= 3 && optOuts.size / recipients.size >= 0.10) return '近七天退订异常，已暂停该邮箱的自动开发';
  return undefined;
}

export async function campaignResults(projectId: Types.ObjectId, campaignId: Types.ObjectId, organizationId?: string) {
  const now = new Date();
  const attempts = await campaignAttempts(projectId, campaignId, new Date(now.getTime() - 30 * DAY));
  const sentById = new Map(attempts.filter(attempt => attempt.messageId && attempt.status !== 'failed').map(attempt => [attempt.messageId!, attempt]));
  const replies = sentById.size ? await MailMessage.find({ projectId, deleted: { $ne: true }, inReplyTo: { $in: [...sentById.keys()] } })
    .select('customerId subject inReplyTo from text html sentAt').limit(1500).lean() : [];
  const groups = new Map<string, { angle: string; step: number; version: string; sent: number; hardBounces: number;
    opened: number; clicked: number; proxyOpens: number; scannerClicks: number; replies: number; inquiries: number; sampleRequests: number }>();
  const groupKey = (attempt: Attempt) => JSON.stringify([attempt.knowledgeReview?.context?.playbook?.segmentCode ?? '', attempt.outreachStep ?? 0, attempt.automationRuleVersion ?? 'legacy']);
  for (const attempt of attempts) {
    const key = groupKey(attempt);
    const group = groups.get(key) ?? { angle: attempt.knowledgeReview?.context?.playbook?.segmentName ?? '未记录切入点', step: attempt.outreachStep ?? 0,
      version: attempt.automationRuleVersion ?? 'legacy', sent: 0, hardBounces: 0, opened: 0, clicked: 0, proxyOpens: 0, scannerClicks: 0,
      replies: 0, inquiries: 0, sampleRequests: 0 };
    if (attempt.status === 'failed') group.hardBounces++;
    else group.sent++;
    if (attempt.tracking?.unclassifiedOpenedAt) group.opened++;
    if (attempt.tracking?.unclassifiedClickedAt) group.clicked++;
    if (attempt.tracking?.automatedOpenCount) group.proxyOpens++;
    if (attempt.tracking?.automatedClickCount) group.scannerClicks++;
    groups.set(key, group);
  }
  const counted = new Set<string>();
  for (const reply of replies) {
    const parent = sentById.get(reply.inReplyTo ?? '');
    if (!parent || String(parent.customerId) !== String(reply.customerId) || reply.sentAt < (parent.sentAt ?? parent.createdAt)) continue;
    const body = freshReplyText(reply.text, reply.html);
    if (!body || /out of office|automatic reply|auto[ -]reply/i.test(reply.subject ?? '') || detectProtectedMailSignal({ from: reply.from, subject: reply.subject, text: body }).classification !== 'normal') continue;
    const group = groups.get(groupKey(parent))!;
    const categories = ['replies', ...(/\b(?:quotation|quote|pricing|rfq)\b|报价|询价/i.test(body) ? ['inquiries'] : []),
      ...(/\b(?:send|request|provide|see|receive|need|like)\b.{0,60}\bsamples?\b|寄样|要样|样品申请/i.test(body) ? ['sampleRequests'] : [])] as const;
    for (const category of categories) {
      const field = category as 'replies' | 'inquiries' | 'sampleRequests';
      const key = `${parent.messageId}:${field}`;
      if (!counted.has(key)) { counted.add(key); group[field]++; }
    }
  }
  const signals = await suppressionSignals(attempts, organizationId);
  return { windowDays: 30, groups: [...groups.values()], optOuts: new Set(signals.filter(signal => signal.reason === 'unsubscribe').map(signal => signal.email)).size,
    observedComplaints: new Set(signals.filter(signal => ['complaint','spam'].includes(signal.reason)).map(signal => signal.email)).size,
    observedBounces: new Set(signals.filter(signal => signal.reason === 'hard_bounce').map(signal => signal.email)).size };
}
