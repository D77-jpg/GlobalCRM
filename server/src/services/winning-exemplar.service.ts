import { Types } from 'mongoose';
import { Customer, DevelopmentLetter, Project, Quotation } from '../models';
import { MailMessage } from '../models/MailMessage';
import { OutreachExemplar, type ExemplarOutcomeType } from '../models/OutreachExemplar';
import type { AuthUser } from '../types/express';
import { requireProjectId } from '../utils/access';
import { stripSignatureText } from './letter-signature';
import { resolveProjectSalesProfile } from './project-profile';
import { countEnglishWords, splitParagraphs } from './agent/outreach-quality';
import { classifyReplySignal, normalizeMsgId } from './outreach-results.service';

/** Redact PII (emails, phones, URLs, explicit customer/company names, currency prices) before storing as reusable exemplar. */
export function redactExemplarText(
  raw: string,
  context: { recipientName?: string; company?: string; recipientEmail?: string } = {},
): string {
  let text = raw;
  if (context.recipientEmail) {
    text = text.replace(new RegExp(context.recipientEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[EMAIL]');
  }
  if (context.company && context.company.trim().length >= 3) {
    text = text.replace(new RegExp(context.company.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[COMPANY]');
  }
  if (context.recipientName && context.recipientName.trim().length >= 2) {
    for (const part of context.recipientName.trim().split(/\s+/).filter((p) => p.length >= 2)) {
      text = text.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[CONTACT]');
    }
  }
  text = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/https?:\/\/[^\s)]+/gi, '[URL]')
    .replace(/(?:\+?\d[\d\s().-]{7,18}\d)/g, '[PHONE]')
    .replace(/(?:\$|€|£|USD|EUR|GBP)\s*\d[\d,.]*/gi, '[PRICE]');
  return text.trim();
}

/** Harvest sent emails with verified positive outcomes into PII-redacted brand/industry exemplars. */
export async function harvestWinningExemplars(actor: AuthUser, windowDays = 90) {
  const projectId = requireProjectId(actor);
  const project = await Project.findById(projectId).select('code slug name companyName industry brandProfile organizationId').lean();
  const profile = resolveProjectSalesProfile(project);
  const since = new Date(Date.now() - Math.max(7, Math.min(365, windowDays)) * 86_400_000);

  const letters = await DevelopmentLetter.find({
    projectId,
    status: { $in: ['sent', 'opened'] },
    sentAt: { $gte: since },
  })
    .sort({ sentAt: -1 })
    .limit(1000)
    .select('_id customerId subject contentText recipientName recipientEmail messageId threadId sentAt outreachStep knowledgeReview.context.playbook')
    .lean();

  if (!letters.length) return { harvested: 0, total: await OutreachExemplar.countDocuments({ projectId }) };

  const customerOids = [...new Set(letters.map((l) => String(l.customerId)))].map((id) => new Types.ObjectId(id));
  const [customers, replies, quotes] = await Promise.all([
    Customer.find({ projectId, _id: { $in: customerOids } }).select('_id name company industry status').lean(),
    MailMessage.find({ projectId, deleted: { $ne: true }, customerId: { $in: customerOids }, sentAt: { $gte: since } })
      .select('customerId subject inReplyTo references threadId from text html sentAt')
      .lean(),
    Quotation.find({ projectId, customerId: { $in: customerOids }, createdAt: { $gte: since } })
      .select('customerId createdAt')
      .lean(),
  ]);

  const customerMap = new Map(customers.map((c) => [String(c._id), c]));
  const letterByMsgId = new Map<string, (typeof letters)[number]>();
  const letterByThread = new Map<string, (typeof letters)[number][]>();
  for (const l of letters) {
    if (l.messageId) letterByMsgId.set(normalizeMsgId(l.messageId), l);
    if (l.threadId) {
      const list = letterByThread.get(l.threadId) ?? [];
      list.push(l);
      letterByThread.set(l.threadId, list);
    }
  }

  const winning = new Map<string, { letter: (typeof letters)[number]; outcome: ExemplarOutcomeType }>();
  const outcomePriority: Record<ExemplarOutcomeType, number> = {
    won: 5,
    quoted: 4,
    sample_request: 3,
    inquiry: 2,
    interested: 1,
  };
  const recordWin = (letter: (typeof letters)[number], outcome: ExemplarOutcomeType) => {
    const id = String(letter._id);
    const existing = winning.get(id);
    if (!existing || outcomePriority[outcome] > outcomePriority[existing.outcome]) {
      winning.set(id, { letter, outcome });
    }
  };

  for (const reply of replies) {
    const inReply = normalizeMsgId(reply.inReplyTo);
    let parent = inReply ? letterByMsgId.get(inReply) : undefined;
    if (!parent && Array.isArray(reply.references)) {
      for (let i = reply.references.length - 1; i >= 0; i--) {
        const hit = letterByMsgId.get(normalizeMsgId(reply.references[i]));
        if (hit) { parent = hit; break; }
      }
    }
    if (!parent && reply.threadId) {
      parent = (letterByThread.get(reply.threadId) ?? []).find(
        (c) => String(c.customerId) === String(reply.customerId) && reply.sentAt >= (c.sentAt ?? new Date(0)),
      );
    }
    if (!parent) continue;
    const classified = classifyReplySignal(reply);
    if (classified.isSampleRequest) recordWin(parent, 'sample_request');
    else if (classified.isInquiry) recordWin(parent, 'inquiry');
    else if (classified.category === 'interested') recordWin(parent, 'interested');
  }

  const quotedCustomers = new Set(quotes.map((q) => String(q.customerId)));
  for (const l of letters) {
    const cid = String(l.customerId);
    const cust = customerMap.get(cid);
    if (cust?.status === 'won') recordWin(l, 'won');
    else if (quotedCustomers.has(cid)) recordWin(l, 'quoted');
  }

  let harvested = 0;
  for (const { letter, outcome } of winning.values()) {
    const cust = customerMap.get(String(letter.customerId));
    const stripped = stripSignatureText(letter.contentText, [profile.signature.title, ...profile.signature.lines]);
    const redactedSubject = redactExemplarText(letter.subject, {
      recipientName: letter.recipientName,
      company: cust?.company,
      recipientEmail: letter.recipientEmail,
    }).slice(0, 300);
    const redactedBody = redactExemplarText(stripped, {
      recipientName: letter.recipientName,
      company: cust?.company,
      recipientEmail: letter.recipientEmail,
    }).slice(0, 3800);
    if (!redactedBody || countEnglishWords(redactedBody) < 12) continue;

    const paras = splitParagraphs(redactedBody);
    const wordCount = countEnglishWords(redactedBody);
    const playbook = letter.knowledgeReview?.context?.playbook;
    const structureNotes = `三段式/短段参考：${paras.length} 段，共 ${wordCount} 词，已核实结果：${outcome}`;

    const res = await OutreachExemplar.updateOne(
      { projectId, sourceLetterId: letter._id },
      {
        $setOnInsert: {
          projectId,
          ...(project?.organizationId ? { organizationId: project.organizationId } : {}),
          sourceLetterId: letter._id,
          brandKey: profile.key,
          ...(cust?.industry ? { industry: cust.industry } : {}),
          ...(playbook?.segmentCode ? { segmentCode: playbook.segmentCode } : {}),
          ...(playbook?.segmentName ? { segmentName: playbook.segmentName } : {}),
          ...(playbook?.preferenceCode ? { preferenceCode: playbook.preferenceCode } : {}),
          outreachStep: letter.outreachStep ?? 1,
          outcomeType: outcome,
          redactedSubject,
          redactedBody,
          structureNotes,
          wordCount,
          approved: true,
          harvestedAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount > 0) harvested++;
  }

  const total = await OutreachExemplar.countDocuments({ projectId });
  return { harvested, total };
}

export async function listWinningExemplars(
  projectId: Types.ObjectId,
  options: { segmentCode?: string; outreachStep?: number; limit?: number } = {},
) {
  const filter: Record<string, unknown> = { projectId, approved: true };
  if (options.segmentCode) filter.segmentCode = options.segmentCode;
  if (options.outreachStep) filter.outreachStep = options.outreachStep;
  const rows = await OutreachExemplar.find(filter)
    .sort({ harvestedAt: -1 })
    .limit(Math.max(1, Math.min(20, options.limit ?? 5)))
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    brandKey: r.brandKey,
    industry: r.industry,
    segmentCode: r.segmentCode,
    segmentName: r.segmentName,
    outreachStep: r.outreachStep,
    outcomeType: r.outcomeType,
    redactedSubject: r.redactedSubject,
    redactedBody: r.redactedBody,
    structureNotes: r.structureNotes,
    wordCount: r.wordCount,
    harvestedAt: r.harvestedAt,
  }));
}
