import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { MailMessage } from '../models/MailMessage';
import {
  ChannelConversation,
  ChannelMessage,
  Customer,
} from '../models';
import type { AuthUser } from '../types/express';
import { requireProjectId } from '../utils/access';
import { createLogger } from '../config/logger';

const logger = createLogger('alibaba-mail-ingest');

export interface AlibabaMailInput {
  from?: string;
  fromName?: string;
  subject?: string;
  text?: string;
  html?: string;
}

export interface ParsedAlibabaInquiry {
  feedbackId?: string;
  buyerName: string;
  buyerCountry?: string;
  buyerCompany?: string;
  buyerEmail?: string;
  messageText: string;
  hasAttachmentNotice: boolean;
  isAssignedNotice: boolean;
}

const ALIBABA_INQUIRY_SENDERS = new Set([
  'feedback@email.alibaba.com',
  'feedback@service.alibaba.com',
]);

const SKIPPED_ALIBABA_SENDERS = new Set([
  'credit@notice.alibaba.com',
  'supplier@service.alibaba.com',
  'noreply@notice.alibaba.com',
  'member@notice.alibaba.com',
]);

const FOOTER_STOP_PATTERNS: RegExp[] = [
  /^安装阿里卖家\s*APP/i,
  /^FAQ\s*[:：]/i,
  /^Email\s+Setting\s*\|/i,
  /^Help\s+center\s*\|/i,
  /^You received this email because you are registered on Alibaba\.com/i,
  /^Read our Privacy Policy/i,
  /^Alibaba\.com Hong Kong Limited/i,
  /^阿里巴巴香港有限公司/,
  /^香港銅鑼灣勿地臣街/,
  /^26\/F Tower One,\s*Times Square/i,
  /^==\s*\{/,
];

const HEADER_BOILERPLATE_PATTERNS: RegExp[] = [
  /^Trade\s+Center$/i,
  /^重要提示\s*Notice$/i,
  /^该买家隐藏了邮箱号码/,
  /^Email address of this buyer is hidden/i,
  /^Message Origin does not match Registered Location/i,
  /^IP\s*[:：]\s*[0-9.*]+$/i,
  /^【阿里巴巴提醒您】/,
  /^立即回复$/,
  /^Reply\s+Now$/i,
  /^View\s+Details$/i,
  /^\[Message\]$/i,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlToRoughText(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanCountry(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/\s+(?:has\s+sent\s+you|sent\s+you|left\s+you|replied\s+to|inquired\s+about)[\s\S]*$/i, '')
    .replace(/[.。,，!！:：]+$/g, '')
    .trim();
  if (!cleaned || cleaned.length > 80) return undefined;
  return cleaned;
}

function cleanBuyerName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^[【\[]+|[】\]]+$/g, '')
    .replace(/[.。,，!！:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 140) return undefined;
  return cleaned;
}

function extractFeedbackId(text: string): string | undefined {
  const jsonMatch = text.match(/==\s*(\{[\s\S]*?\})\s*==/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
      const raw = parsed.feedbackid ?? parsed.feedbackId ?? parsed.inquiryId;
      if (typeof raw === 'string' || typeof raw === 'number') {
        const val = String(raw).trim();
        if (/^[A-Za-z0-9_-]{3,80}$/.test(val)) return val;
      }
    } catch {
      // fall through to regex
    }
  }
  const rx = text.match(/"feedbackid"\s*:\s*"?([A-Za-z0-9_-]{3,80})"?/i);
  return rx?.[1];
}

export function isAlibabaInquiryMail(input: Pick<AlibabaMailInput, 'from' | 'fromName' | 'subject'>): boolean {
  const from = String(input.from || '').trim().toLowerCase();
  const fromName = String(input.fromName || '').trim().toLowerCase();
  const subject = String(input.subject || '').trim();

  if (!from) return false;
  if (SKIPPED_ALIBABA_SENDERS.has(from)) return false;

  // Exclude obvious Trade Assurance / logistics / marketing notices regardless of sender.
  if (/(?:Trade\s+Assurance|物流首单|直通车|账号休眠|payment\s+received|order\s+status)/i.test(subject)) {
    return false;
  }

  if (ALIBABA_INQUIRY_SENDERS.has(from) || ALIBABA_INQUIRY_SENDERS.has(fromName)) {
    return true;
  }

  if (/@(?:email|service)\.alibaba\.com$/i.test(from)) {
    return /(?:Alibaba\s+(?:Inquiry\s+)?Notification|sent you an inquiry|assigned you an inquiry)/i.test(subject);
  }

  return false;
}

export function parseAlibabaInquiryMail(input: AlibabaMailInput): ParsedAlibabaInquiry | null {
  if (!isAlibabaInquiryMail(input)) return null;

  const subject = String(input.subject || '').trim();
  const rawText = String(input.text || '').trim() || htmlToRoughText(input.html).trim();
  const feedbackId = extractFeedbackId(rawText);

  let buyerName: string | undefined;
  let buyerCountry: string | undefined;
  let isAssignedNotice = false;

  // Pattern 1: 【Alibaba Notification】Your manager has assigned you an inquiry from <Buyer> [from <Country>]
  const assignedMatch = subject.match(/assigned\s+you\s+an\s+inquiry\s+from\s+(.+)$/i);
  if (assignedMatch) {
    isAssignedNotice = true;
    const tail = assignedMatch[1].trim();
    const fromSplit = tail.match(/^(.+?)\s+from\s+(.+)$/i);
    if (fromSplit) {
      buyerName = cleanBuyerName(fromSplit[1]);
      buyerCountry = cleanCountry(fromSplit[2]);
    } else {
      buyerName = cleanBuyerName(tail);
    }
  }

  // Pattern 2: 【Alibaba Inquiry Notification】<Buyer> from <Country> has sent you an inquiry ...
  // Pattern 3: 【Alibaba Notification】<Buyer> from <Country>
  if (!buyerName) {
    const stripped = subject.replace(/^【[^】]*Alibaba[^】]*】\s*/i, '').replace(/^\[[^\]]*Alibaba[^\]]*\]\s*/i, '').trim();
    const standardMatch = stripped.match(/^(.+?)\s+from\s+(.+)$/i);
    if (standardMatch) {
      buyerName = cleanBuyerName(standardMatch[1]);
      buyerCountry = cleanCountry(standardMatch[2]);
    } else if (stripped && !/^(?:Alibaba|Notification|Inquiry)/i.test(stripped)) {
      buyerName = cleanBuyerName(stripped.replace(/\s+(?:has\s+sent|sent|left)\s+you[\s\S]*$/i, ''));
    }
  }

  // Extract clean inquiry body lines
  const allLines = rawText.split(/\r?\n/).map((l) => l.trim());
  let startIdx = 0;
  for (let i = 0; i < allLines.length; i += 1) {
    if (/^(?:立即回复|Reply\s+Now)$/i.test(allLines[i])) {
      startIdx = i + 1;
      break;
    }
  }

  const contentLines: string[] = [];
  for (let i = startIdx; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (!line) {
      if (contentLines.length > 0 && contentLines[contentLines.length - 1] !== '') {
        contentLines.push('');
      }
      continue;
    }
    if (FOOTER_STOP_PATTERNS.some((rx) => rx.test(line))) break;
    if (HEADER_BOILERPLATE_PATTERNS.some((rx) => rx.test(line))) continue;
    // Skip Alibaba FAQ numbered tips if they appear before footer
    if (/^[12]\.\s*(?:询盘标题变任务提醒|巧用产品推荐|及时回复率提升)/.test(line)) break;
    contentLines.push(line);
  }

  // Trim leading/trailing empty lines
  while (contentLines.length > 0 && contentLines[0] === '') contentLines.shift();
  while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();

  // If buyer name wasn't in subject, see if the first line looks like a buyer display name
  if (!buyerName && contentLines.length >= 2 && contentLines[0].length <= 60 && !/[?!。？！]/.test(contentLines[0])) {
    buyerName = cleanBuyerName(contentLines[0]);
  }

  const finalBuyerName = buyerName || (feedbackId ? `Alibaba Buyer #${feedbackId.slice(-6)}` : 'Alibaba Buyer');

  // Remove redundant leading lines that simply repeat the buyer's exact name (Alibaba template often echoes it 1-2x)
  let nonEmpty = contentLines.filter(Boolean);
  while (
    nonEmpty.length > 1
    && contentLines.length > 1
    && contentLines[0].toLowerCase() === finalBuyerName.toLowerCase()
  ) {
    contentLines.shift();
    while (contentLines.length > 0 && contentLines[0] === '') contentLines.shift();
    nonEmpty = contentLines.filter(Boolean);
  }
  // Also strip a leading first-name echo when buyerName has multiple words and >= 2 lines remain
  const firstWord = finalBuyerName.split(/\s+/)[0]?.toLowerCase();
  if (
    firstWord
    && firstWord.length >= 3
    && nonEmpty.length > 1
    && contentLines[0]?.toLowerCase() === firstWord
  ) {
    contentLines.shift();
    while (contentLines.length > 0 && contentLines[0] === '') contentLines.shift();
  }

  let messageText = contentLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const hasAttachmentNotice = /contains an attachment\.?\s*Please sign into Trade Center/i.test(rawText);

  if (!messageText || messageText.toLowerCase() === finalBuyerName.toLowerCase()) {
    const locationPart = buyerCountry ? ` (${buyerCountry})` : '';
    if (isAssignedNotice) {
      messageText = `主管分配了来自 ${finalBuyerName}${locationPart} 的阿里国际站询盘。该提醒邮件未附带正文预览，请前往阿里国际站消息中心查看完整询盘并回复。`;
    } else if (hasAttachmentNotice) {
      messageText = `买家 ${finalBuyerName}${locationPart} 在阿里国际站发送了带附件的新消息，请前往阿里国际站消息中心查看附件并回复。`;
    } else {
      messageText = `收到来自 ${finalBuyerName}${locationPart} 的阿里国际站新消息提醒。该条通知未附带原文预览，请前往阿里国际站消息中心查看完整消息并回复。`;
    }
  }

  return {
    feedbackId,
    buyerName: finalBuyerName.slice(0, 150),
    buyerCountry,
    messageText: messageText.slice(0, 15000),
    hasAttachmentNotice,
    isAssignedNotice,
  };
}

function buildExternalContactId(parsed: ParsedAlibabaInquiry, mailId: string): string {
  const slug = parsed.buyerName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  if (slug.length >= 3 && !slug.startsWith('alibaba-buyer')) {
    return `alibaba:${slug}`;
  }
  if (parsed.feedbackId) {
    return `alibaba:fb:${parsed.feedbackId}`;
  }
  return `alibaba:mail:${mailId}`;
}

export interface AlibabaMailDocLike {
  _id: unknown;
  projectId: unknown;
  customerId?: unknown;
  mailboxUserId?: unknown;
  messageId?: string | null;
  from?: string | null;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  sentAt?: Date | string | null;
}

function buildExternalMessageId(mailDoc: Pick<AlibabaMailDocLike, '_id' | 'messageId'>): string {
  const msgId = typeof mailDoc.messageId === 'string' ? mailDoc.messageId.trim() : '';
  if (msgId) {
    const hash = createHash('sha256').update(msgId).digest('hex').slice(0, 28);
    return `alibaba-mail:${hash}`;
  }
  return `alibaba-mail:id:${String(mailDoc._id)}`;
}

export interface IngestAlibabaMailResult {
  status: 'imported' | 'skipped';
  reason?: 'not_alibaba_inquiry' | 'duplicate';
  conversationId?: string;
  messageId?: string;
}

export async function ingestAlibabaMailToChannel(
  mailDoc: AlibabaMailDocLike,
  options?: { fallbackOwnerId?: string },
): Promise<IngestAlibabaMailResult> {
  const parsed = parseAlibabaInquiryMail({
    from: mailDoc.from ?? undefined,
    fromName: mailDoc.fromName ?? undefined,
    subject: mailDoc.subject ?? undefined,
    text: mailDoc.text ?? undefined,
    html: mailDoc.html ?? undefined,
  });
  if (!parsed) {
    return { status: 'skipped', reason: 'not_alibaba_inquiry' };
  }

  const projectOid = new Types.ObjectId(String(mailDoc.projectId));
  const externalMessageId = buildExternalMessageId(mailDoc);

  const alreadyImported = await ChannelMessage.exists({ projectId: projectOid, externalMessageId });
  if (alreadyImported) {
    return { status: 'skipped', reason: 'duplicate' };
  }

  const sentAt = mailDoc.sentAt && Number.isFinite(new Date(mailDoc.sentAt).getTime())
    ? new Date(mailDoc.sentAt)
    : new Date();

  // Try matching an existing CRM customer strictly inside this project (exact case-insensitive name match)
  let matchedCustomerId: Types.ObjectId | undefined = mailDoc.customerId
    ? new Types.ObjectId(String(mailDoc.customerId))
    : undefined;
  let matchedCustomerOwnerId: Types.ObjectId | undefined;

  if (!matchedCustomerId && parsed.buyerName && !parsed.buyerName.startsWith('Alibaba Buyer')) {
    const existingCustomer = await Customer.findOne({
      projectId: projectOid,
      name: new RegExp(`^${escapeRegex(parsed.buyerName)}$`, 'i'),
    }).select('_id ownerId').lean();
    if (existingCustomer) {
      matchedCustomerId = existingCustomer._id;
      matchedCustomerOwnerId = existingCustomer.ownerId;
    }
  }

  const ownerOid = mailDoc.mailboxUserId
    ? new Types.ObjectId(String(mailDoc.mailboxUserId))
    : matchedCustomerOwnerId
      ?? (options?.fallbackOwnerId && Types.ObjectId.isValid(options.fallbackOwnerId)
        ? new Types.ObjectId(options.fallbackOwnerId)
        : undefined);

  const externalContactId = buildExternalContactId(parsed, String(mailDoc._id));
  const baseTags = ['Alibaba 询盘'];
  if (parsed.hasAttachmentNotice) baseTags.push('含附件');

  let conv = await ChannelConversation.findOne({
    projectId: projectOid,
    channel: 'alibaba',
    externalContactId,
  });

  if (!conv) {
    try {
      conv = await ChannelConversation.create({
        projectId: projectOid,
        customerId: matchedCustomerId,
        ownerId: ownerOid,
        channel: 'alibaba',
        externalContactId,
        contactName: parsed.buyerName,
        contactCompany: parsed.buyerCompany,
        contactCountry: parsed.buyerCountry,
        contactEmail: parsed.buyerEmail,
        status: 'open',
        tags: baseTags,
        unreadCount: 1,
        mode: 'manual_assist',
        lastMessagePreview: parsed.messageText.slice(0, 200),
        lastMessageDirection: 'inbound',
        lastMessageAt: sentAt,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        conv = await ChannelConversation.findOne({
          projectId: projectOid,
          channel: 'alibaba',
          externalContactId,
        });
      } else {
        throw err;
      }
    }
  } else {
    if (!conv.contactCountry && parsed.buyerCountry) conv.contactCountry = parsed.buyerCountry;
    if (!conv.customerId && matchedCustomerId) conv.customerId = matchedCustomerId;
    if (!conv.ownerId && ownerOid) conv.ownerId = ownerOid;
    const tagSet = new Set(conv.tags || []);
    for (const t of baseTags) tagSet.add(t);
    conv.tags = [...tagSet].slice(0, 12);
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    if (!conv.lastMessageAt || sentAt.getTime() >= new Date(conv.lastMessageAt).getTime()) {
      conv.lastMessagePreview = parsed.messageText.slice(0, 200);
      conv.lastMessageDirection = 'inbound';
      conv.lastMessageAt = sentAt;
      if (conv.status === 'resolved') conv.status = 'open';
    }
    await conv.save();
  }

  if (!conv) {
    return { status: 'skipped', reason: 'duplicate' };
  }

  try {
    const msg = await ChannelMessage.create({
      projectId: projectOid,
      conversationId: conv._id,
      customerId: conv.customerId,
      channel: 'alibaba',
      direction: 'inbound',
      deliveryStatus: 'received',
      externalMessageId,
      text: parsed.messageText,
      attachments: [],
      senderName: parsed.buyerName,
      sentAt,
    });
    return {
      status: 'imported',
      conversationId: String(conv._id),
      messageId: String(msg._id),
    };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return { status: 'skipped', reason: 'duplicate' };
    }
    throw err;
  }
}

export async function syncAlibabaInquiriesFromMail(
  actor: AuthUser,
  options?: { limit?: number },
): Promise<{
  scanned: number;
  imported: number;
  skipped: number;
  conversationsTouched: number;
}> {
  const projectId = requireProjectId(actor);
  const projectOid = new Types.ObjectId(projectId);
  const limit = Math.min(Math.max(Number(options?.limit) || 200, 1), 500);

  const filter: Record<string, unknown> = {
    projectId: projectOid,
    from: { $regex: '@(?:email|service)\\.alibaba\\.com$', $options: 'i' },
  };

  if (actor.role !== 'admin' && actor.role !== 'project_admin') {
    filter.$or = [
      { visibility: 'project_shared' },
      { visibility: { $exists: false } },
      { mailboxUserId: new Types.ObjectId(actor.id) },
    ];
  }

  // Grab newest N first, then reverse to ingest chronologically oldest -> newest
  const docs = await MailMessage.find(filter)
    .sort({ sentAt: -1 })
    .limit(limit)
    .select('_id projectId customerId mailboxUserId messageId from fromName subject text html sentAt')
    .lean();

  docs.reverse();

  let imported = 0;
  let skipped = 0;
  const touched = new Set<string>();

  for (const doc of docs) {
    try {
      const res = await ingestAlibabaMailToChannel(doc, { fallbackOwnerId: actor.id });
      if (res.status === 'imported') {
        imported += 1;
        if (res.conversationId) touched.add(res.conversationId);
      } else {
        skipped += 1;
      }
    } catch (err) {
      skipped += 1;
      logger.warn('Alibaba 询盘邮件解析同步单条失败，已跳过继续', {
        projectId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return {
    scanned: docs.length,
    imported,
    skipped,
    conversationsTouched: touched.size,
  };
}
