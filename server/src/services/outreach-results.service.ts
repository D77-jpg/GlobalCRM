import type { Types } from 'mongoose';
import {
  AgentMailThreadAnalysis,
  Customer,
  DevelopmentLetter,
  EmailSuppression,
  Project,
  Quotation,
} from '../models';
import { MailMessage } from '../models/MailMessage';
import { freshReplyText } from '../utils/text';
import { detectProtectedMailSignal } from './agent/mail-thread-analysis.service';
import { resolveProjectSalesProfile } from './project-profile';

const DAY = 86_400_000;
const DELIVERED_STATUSES = ['sent', 'opened'] as const;
const MAX_ANALYZED_LETTERS = 10_000;
const MAX_ANALYZED_REPLIES = 15_000;
const DEFAULT_MIN_SAMPLE = 20;

export type ReplyCategory =
  | 'interested'
  | 'referral'
  | 'not_interested'
  | 'auto_reply'
  | 'unsubscribe'
  | 'bounce'
  | 'complaint'
  | 'neutral';

export interface ClassifiedReply {
  category: ReplyCategory;
  isValidReply: boolean;
  isInquiry: boolean;
  isSampleRequest: boolean;
  source: 'thread_analysis' | 'heuristic';
}

const AUTO_REPLY_PATTERN = /\b(?:out of office|automatic reply|auto[- ]?reply|vacation reply|away from (?:the )?office|i am currently out|auto[- ]?response|delivery status notification|undeliverable)\b|自动回复|休假中|外出自动回复/i;
const REFERRAL_PATTERN = /\b(?:forward(?:ed|ing)? (?:your|this)|cc'?ing|looping in|reach out to|contact (?:our|my)|handles? (?:our )?(?:sourcing|procurement|purchasing|packaging|buying)|right person is)\b|转交|转给|抄送|请联系.{0,20}(?:负责|采购|同事)/i;
const REJECTION_PATTERN = /\b(?:not interested|no thank(?:s| you)|already have a (?:supplier|vendor|factory)|happy with our current|do not need|don't need|no need right now|pass for now|not looking for)\b|暂不需要|不感兴趣|已有稳定供应商|暂时不用/i;
const NEGATED_INQUIRY_PATTERN = /\b(?:no|not|don't|do not|never)\s+(?:need|want|require|looking for)\b.{0,30}\b(?:quote|quotation|pricing|price|rfq)\b|不需要报价|暂不询价/i;
const INQUIRY_PATTERN = /\b(?:quotation|quote|pricing|price list|rfq|unit price|moq|lead time|catalog(?:ue)?|how much)\b|报价|询价|价格表|起订量/i;
const NEGATED_SAMPLE_PATTERN = /\b(?:no|not|don't|do not|never)\s+(?:need|want|require)\b.{0,30}\bsamples?\b|不需要样品|不用寄样/i;
const SAMPLE_PATTERN = /\b(?:send|request|provide|see|receive|need|like|order|arrange|ship)\b.{0,50}\b(?:samples?|swatches?|color card)\b|\bsample\s+(?:order|kit|request)\b|寄样|要样|样品申请|打样|色卡/i;
const POSITIVE_INTEREST_PATTERN = /\b(?:interested|sounds? good|let'?s (?:talk|connect|discuss|chat)|worth a look|please (?:send|share)|happy to (?:review|compare|look)|can you (?:send|share)|tell me more)\b|有兴趣|可以看看|发份资料|发一下/i;

export function normalizeMsgId(value?: string | null): string {
  return String(value ?? '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

export function classifyReplySignal(
  reply: { from?: string; subject?: string; text?: string; html?: string },
  persistedIntent?: string,
): ClassifiedReply {
  const body = freshReplyText(reply.text, reply.html);
  const subject = reply.subject ?? '';
  const combined = `${subject}\n${body}`;

  if (AUTO_REPLY_PATTERN.test(subject) || AUTO_REPLY_PATTERN.test(body.slice(0, 350))) {
    return { category: 'auto_reply', isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }

  const protectedSig = detectProtectedMailSignal({ from: reply.from, subject, text: body });
  if (protectedSig.classification === 'bounce') {
    return { category: 'bounce', isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }
  if (protectedSig.classification === 'unsubscribe') {
    return { category: 'unsubscribe', isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }
  if (protectedSig.classification === 'spam') {
    return { category: 'complaint', isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }

  if (persistedIntent) {
    if (['inquiry', 'quotation_request', 'negotiation', 'sample_request', 'order', 'positive'].includes(persistedIntent)) {
      const isInquiry = ['inquiry', 'quotation_request', 'negotiation', 'order'].includes(persistedIntent)
        || (INQUIRY_PATTERN.test(body) && !NEGATED_INQUIRY_PATTERN.test(body));
      const isSampleRequest = persistedIntent === 'sample_request'
        || (SAMPLE_PATTERN.test(body) && !NEGATED_SAMPLE_PATTERN.test(body));
      return { category: 'interested', isValidReply: true, isInquiry, isSampleRequest, source: 'thread_analysis' };
    }
    if (persistedIntent === 'rejection') {
      return { category: 'not_interested', isValidReply: true, isInquiry: false, isSampleRequest: false, source: 'thread_analysis' };
    }
    if (persistedIntent === 'unsubscribe' || persistedIntent === 'bounce' || persistedIntent === 'spam') {
      const mapped = persistedIntent === 'spam' ? 'complaint' : persistedIntent;
      return { category: mapped, isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'thread_analysis' };
    }
  }

  if (!body.trim()) {
    return { category: 'neutral', isValidReply: false, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }
  if (REFERRAL_PATTERN.test(body)) {
    return { category: 'referral', isValidReply: true, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }
  if (protectedSig.classification === 'rejection' || REJECTION_PATTERN.test(body)) {
    return { category: 'not_interested', isValidReply: true, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
  }

  const isInquiry = INQUIRY_PATTERN.test(combined) && !NEGATED_INQUIRY_PATTERN.test(body);
  const isSampleRequest = SAMPLE_PATTERN.test(combined) && !NEGATED_SAMPLE_PATTERN.test(body);
  if (isInquiry || isSampleRequest || POSITIVE_INTEREST_PATTERN.test(body)) {
    return { category: 'interested', isValidReply: true, isInquiry, isSampleRequest, source: 'heuristic' };
  }

  return { category: 'neutral', isValidReply: true, isInquiry: false, isSampleRequest: false, source: 'heuristic' };
}

interface CampaignAttemptsResult {
  attempts: {
    _id: Types.ObjectId;
    customerId: Types.ObjectId;
    recipientEmail: string;
    messageId?: string;
    threadId?: string;
    status: string;
    sentAt?: Date;
    createdAt: Date;
    outreachStep?: number;
    automationRuleVersion?: string;
    hardBouncedAt?: Date;
    contentText?: string;
    aiSnapshot?: { subject?: string; contentText?: string };
    tracking?: {
      openedAt?: Date;
      clickedAt?: Date;
      dedupedOpenCount?: number;
      dedupedClickCount?: number;
      automatedOpenCount?: number;
      automatedClickCount?: number;
      unclassifiedOpenedAt?: Date;
      unclassifiedClickedAt?: Date;
    };
    knowledgeReview?: {
      context?: {
        writingVersion?: string;
        playbook?: {
          segmentCode?: string;
          segmentName?: string;
          preferenceCode?: string;
          preferenceName?: string;
        };
      };
    };
  }[];
  totalMatched: number;
  truncated: boolean;
}

async function fetchAttempts(
  filter: Record<string, unknown>,
  since: Date,
  maxRecords = MAX_ANALYZED_LETTERS,
): Promise<CampaignAttemptsResult> {
  const query = {
    ...filter,
    $or: [
      { status: { $in: DELIVERED_STATUSES }, sentAt: { $gte: since } },
      { status: 'failed', hardBouncedAt: { $gte: since } },
    ],
  };
  const [totalMatched, rows] = await Promise.all([
    DevelopmentLetter.countDocuments(query),
    DevelopmentLetter.find(query)
      .select('customerId recipientEmail messageId threadId status sentAt createdAt outreachStep automationRuleVersion hardBouncedAt contentText aiSnapshot tracking.openedAt tracking.clickedAt tracking.dedupedOpenCount tracking.dedupedClickCount tracking.automatedOpenCount tracking.automatedClickCount tracking.unclassifiedOpenedAt tracking.unclassifiedClickedAt knowledgeReview.context.writingVersion knowledgeReview.context.playbook')
      // Newest first so recent risk signals and latest sends are NEVER truncated behind old records!
      .sort({ sentAt: -1, createdAt: -1 })
      .limit(maxRecords)
      .lean(),
  ]);
  return {
    attempts: rows as unknown as CampaignAttemptsResult['attempts'],
    totalMatched,
    truncated: totalMatched > rows.length,
  };
}

async function projectSuppressionSignals(
  projectId: Types.ObjectId,
  attempts: CampaignAttemptsResult['attempts'],
  organizationId?: string,
) {
  const firstAttempt = new Map<string, Date>();
  for (const attempt of attempts) {
    const date = attempt.sentAt ?? attempt.createdAt;
    const email = attempt.recipientEmail.toLowerCase();
    if (!firstAttempt.has(email) || firstAttempt.get(email)! > date) firstAttempt.set(email, date);
  }
  if (!firstAttempt.size) return [];
  const signals = await EmailSuppression.find({
    ...(organizationId ? { organizationId } : {}),
    $or: [{ projectId }, { scopeKey: 'global' }],
    email: { $in: [...firstAttempt.keys()] },
    reason: { $in: ['hard_bounce', 'unsubscribe', 'complaint', 'spam'] },
    source: { $in: ['link', 'inbound', 'smtp'] },
  }).select('email createdAt reason').lean();
  return signals.filter((signal) => signal.createdAt >= firstAttempt.get(signal.email)!);
}

export async function campaignPauseReason(
  projectId: Types.ObjectId,
  campaignId: Types.ObjectId,
  now: Date,
  organizationId?: string,
): Promise<string | undefined> {
  const { attempts } = await fetchAttempts({ projectId, automationCampaignId: campaignId }, new Date(now.getTime() - 7 * DAY));
  const signals = await projectSuppressionSignals(projectId, attempts, organizationId);
  if (signals.some((signal) => signal.reason === 'complaint' || signal.reason === 'spam')) {
    return '近期收到自动开发相关投诉，已暂停该邮箱的自动开发';
  }
  const recipients = new Set(attempts.map((attempt) => attempt.recipientEmail.toLowerCase()));
  if (!recipients.size) return undefined;
  const bounces = new Set([
    ...attempts.filter((attempt) => attempt.status === 'failed' || Boolean(attempt.hardBouncedAt)).map((attempt) => attempt.recipientEmail.toLowerCase()),
    ...signals.filter((signal) => signal.reason === 'hard_bounce').map((signal) => signal.email),
  ]);
  if (bounces.size >= 3 && bounces.size / recipients.size >= 0.10) return '近七天硬退信异常，已暂停该邮箱的自动开发';
  const optOuts = new Set(signals.filter((signal) => signal.reason === 'unsubscribe').map((signal) => signal.email));
  if (optOuts.size >= 3 && optOuts.size / recipients.size >= 0.10) return '近七天退订异常，已暂停该邮箱的自动开发';
  return undefined;
}

export interface OutreachResultGroup {
  brandKey: string;
  angleCode: string;
  angle: string;
  preferenceCode: string;
  preferenceName: string;
  step: number;
  version: string;
  sent: number;
  uniqueCustomers: number;
  humanEdited: number;
  hardBounces: number;
  optOuts: number;
  complaints: number;
  opened: number;
  clicked: number;
  proxyOpens: number;
  scannerClicks: number;
  replies: number;
  interested: number;
  referrals: number;
  notInterested: number;
  inquiries: number;
  sampleRequests: number;
  quoted: number;
  won: number;
  openRate: number;
  replyRate: number;
  negativeRate: number;
  insufficientSample: boolean;
  highOpenLowReply: boolean;
  recommendation: 'keep' | 'rewrite' | 'pause' | 'insufficient_sample';
  recommendationReason: string;
}

export interface CampaignResultsReport {
  windowDays: number;
  minSample: number;
  brandKey: string;
  totalMatched: number;
  analyzedCount: number;
  truncated: boolean;
  denominatorNote: string;
  complaintCoverageNotice: string;
  groups: OutreachResultGroup[];
  unmatchedReplies: {
    total: number;
    interested: number;
    referrals: number;
    notInterested: number;
    note: string;
  };
  optOuts: number;
  observedComplaints: number;
  observedBounces: number;
}

export async function campaignResults(
  projectId: Types.ObjectId,
  campaignId?: Types.ObjectId,
  organizationId?: string,
  options: { windowDays?: number; minSample?: number } = {},
): Promise<CampaignResultsReport> {
  const windowDays = Math.max(1, Math.min(180, options.windowDays ?? 30));
  const minSample = Math.max(5, Math.min(200, options.minSample ?? DEFAULT_MIN_SAMPLE));
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * DAY);

  const project = await Project.findById(projectId).select('code slug name companyName industry brandProfile').lean();
  const brandKey = resolveProjectSalesProfile(project).key;

  const filter: Record<string, unknown> = { projectId, ...(campaignId ? { automationCampaignId: campaignId } : {}) };
  const { attempts, totalMatched, truncated } = await fetchAttempts(filter, since);

  // Build normalized messageId & threadId attribution maps
  const sentByMsgId = new Map<string, CampaignAttemptsResult['attempts'][number]>();
  const sentByThread = new Map<string, CampaignAttemptsResult['attempts'][number][]>();
  const customerIds = new Set<string>();
  const recipientLastAttempt = new Map<string, CampaignAttemptsResult['attempts'][number]>();

  for (const attempt of attempts) {
    customerIds.add(String(attempt.customerId));
    const email = attempt.recipientEmail.toLowerCase();
    if (!recipientLastAttempt.has(email)) recipientLastAttempt.set(email, attempt);
    if (attempt.status === 'failed') continue;
    if (attempt.messageId) {
      sentByMsgId.set(normalizeMsgId(attempt.messageId), attempt);
    }
    if (attempt.threadId) {
      const list = sentByThread.get(attempt.threadId) ?? [];
      list.push(attempt);
      sentByThread.set(attempt.threadId, list);
    }
  }

  // Fetch all inbound replies for these customers in window (newest first)
  const customerOids = [...customerIds].map((id) => attempts.find((a) => String(a.customerId) === id)!.customerId);
  const [replies, analyses, quotations, wonCustomers, signals] = await Promise.all([
    customerOids.length
      ? MailMessage.find({ projectId, deleted: { $ne: true }, customerId: { $in: customerOids }, sentAt: { $gte: since } })
        .select('customerId subject inReplyTo references threadId from text html sentAt')
        .sort({ sentAt: -1 })
        .limit(MAX_ANALYZED_REPLIES)
        .lean()
      : [],
    customerOids.length
      ? AgentMailThreadAnalysis.find({ projectId, customerId: { $in: customerOids }, createdAt: { $gte: since } })
        .select('customerId intent.category intent.evidenceMessageIds createdAt')
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean()
      : [],
    customerOids.length
      ? Quotation.find({ projectId, customerId: { $in: customerOids }, createdAt: { $gte: since } })
        .select('customerId createdAt status')
        .lean()
      : [],
    customerOids.length
      ? Customer.find({ projectId, _id: { $in: customerOids }, status: 'won' }).select('_id updatedAt').lean()
      : [],
    projectSuppressionSignals(projectId, attempts, organizationId),
  ]);

  const analysisByMsgId = new Map<string, string>();
  for (const a of analyses) {
    const cat = a.intent?.category;
    if (!cat) continue;
    for (const mid of a.intent?.evidenceMessageIds ?? []) {
      const key = String(mid);
      if (!analysisByMsgId.has(key)) analysisByMsgId.set(key, cat);
    }
  }

  interface MutableGroup {
    brandKey: string;
    angleCode: string;
    angle: string;
    preferenceCode: string;
    preferenceName: string;
    step: number;
    version: string;
    sent: number;
    customers: Set<string>;
    humanEdited: number;
    hardBounces: number;
    optOuts: number;
    complaints: number;
    opened: number;
    clicked: number;
    proxyOpens: number;
    scannerClicks: number;
    replies: number;
    interested: number;
    referrals: number;
    notInterested: number;
    inquiries: number;
    sampleRequests: number;
    quotedCustomers: Set<string>;
    wonCustomers: Set<string>;
  }

  const groups = new Map<string, MutableGroup>();
  const groupKey = (attempt: CampaignAttemptsResult['attempts'][number]) => JSON.stringify([
    attempt.knowledgeReview?.context?.playbook?.segmentCode ?? '',
    attempt.knowledgeReview?.context?.playbook?.preferenceCode ?? '',
    attempt.outreachStep ?? 0,
    attempt.automationRuleVersion ?? attempt.knowledgeReview?.context?.writingVersion ?? 'legacy',
  ]);

  const ensureGroup = (attempt: CampaignAttemptsResult['attempts'][number]): MutableGroup => {
    const key = groupKey(attempt);
    let g = groups.get(key);
    if (!g) {
      g = {
        brandKey,
        angleCode: attempt.knowledgeReview?.context?.playbook?.segmentCode ?? 'unrecorded',
        angle: attempt.knowledgeReview?.context?.playbook?.segmentName ?? '未记录切入点',
        preferenceCode: attempt.knowledgeReview?.context?.playbook?.preferenceCode ?? '',
        preferenceName: attempt.knowledgeReview?.context?.playbook?.preferenceName ?? '',
        step: attempt.outreachStep ?? 0,
        version: attempt.automationRuleVersion ?? attempt.knowledgeReview?.context?.writingVersion ?? 'legacy',
        sent: 0,
        customers: new Set(),
        humanEdited: 0,
        hardBounces: 0,
        optOuts: 0,
        complaints: 0,
        opened: 0,
        clicked: 0,
        proxyOpens: 0,
        scannerClicks: 0,
        replies: 0,
        interested: 0,
        referrals: 0,
        notInterested: 0,
        inquiries: 0,
        sampleRequests: 0,
        quotedCustomers: new Set(),
        wonCustomers: new Set(),
      };
      groups.set(key, g);
    }
    return g;
  };

  // Track earliest verified sent attempt per customer per group for quote/won attribution
  const customerLatestSent = new Map<string, CampaignAttemptsResult['attempts'][number]>();
  for (const attempt of attempts) {
    const g = ensureGroup(attempt);
    g.customers.add(String(attempt.customerId));
    if (attempt.status === 'failed') {
      g.hardBounces++;
    } else {
      g.sent++;
      if (attempt.hardBouncedAt) g.hardBounces++;
      const cid = String(attempt.customerId);
      if (!customerLatestSent.has(cid)) customerLatestSent.set(cid, attempt);
    }
    if (attempt.aiSnapshot?.contentText && attempt.contentText && attempt.aiSnapshot.contentText.trim() !== attempt.contentText.trim()) {
      g.humanEdited++;
    }
    if (attempt.tracking?.unclassifiedOpenedAt || (attempt.tracking?.dedupedOpenCount ?? 0) > 0) g.opened++;
    if (attempt.tracking?.unclassifiedClickedAt || (attempt.tracking?.dedupedClickCount ?? 0) > 0) g.clicked++;
    if (attempt.tracking?.automatedOpenCount) g.proxyOpens++;
    if (attempt.tracking?.automatedClickCount) g.scannerClicks++;
  }

  // Attribute suppressions (optOut, bounce, complaint) to the recipient's latest attempt's angle+step
  const attributedSuppression = new Set<string>();
  for (const sig of signals) {
    const attempt = recipientLastAttempt.get(sig.email.toLowerCase());
    if (!attempt) continue;
    const g = ensureGroup(attempt);
    const dedup = `${groupKey(attempt)}:${sig.email}:${sig.reason}`;
    if (attributedSuppression.has(dedup)) continue;
    attributedSuppression.add(dedup);
    if (sig.reason === 'unsubscribe') g.optOuts++;
    else if (sig.reason === 'complaint' || sig.reason === 'spam') g.complaints++;
    else if (sig.reason === 'hard_bounce' && attempt.status !== 'failed' && !attempt.hardBouncedAt) g.hardBounces++;
  }

  // Attribute replies via verifiable thread headers (In-Reply-To -> References -> ThreadId)
  const counted = new Set<string>();
  const unmatchedReplies = { total: 0, interested: 0, referrals: 0, notInterested: 0 };
  const attributedCustomerAttempt = new Map<string, CampaignAttemptsResult['attempts'][number]>();

  for (const reply of replies) {
    const inReplyNorm = normalizeMsgId(reply.inReplyTo);
    let parent = inReplyNorm ? sentByMsgId.get(inReplyNorm) : undefined;
    if (!parent && Array.isArray(reply.references)) {
      for (let i = reply.references.length - 1; i >= 0; i--) {
        const found = sentByMsgId.get(normalizeMsgId(reply.references[i]));
        if (found) { parent = found; break; }
      }
    }
    if (!parent && reply.threadId) {
      const candidates = sentByThread.get(reply.threadId) ?? [];
      parent = candidates.find((c) => String(c.customerId) === String(reply.customerId) && reply.sentAt >= (c.sentAt ?? c.createdAt));
    }

    const persistedIntent = analysisByMsgId.get(String(reply._id));
    const classified = classifyReplySignal(reply, persistedIntent);
    if (!classified.isValidReply) continue;

    if (!parent || String(parent.customerId) !== String(reply.customerId) || reply.sentAt < (parent.sentAt ?? parent.createdAt)) {
      unmatchedReplies.total++;
      if (classified.category === 'interested') unmatchedReplies.interested++;
      if (classified.category === 'referral') unmatchedReplies.referrals++;
      if (classified.category === 'not_interested') unmatchedReplies.notInterested++;
      continue;
    }

    const g = ensureGroup(parent);
    attributedCustomerAttempt.set(String(parent.customerId), parent);
    const parentId = String(parent._id);
    const mark = (field: string, fn: () => void) => {
      const k = `${parentId}:${field}`;
      if (!counted.has(k)) { counted.add(k); fn(); }
    };

    mark('replies', () => { g.replies++; });
    if (classified.category === 'interested') mark('interested', () => { g.interested++; });
    if (classified.category === 'referral') mark('referrals', () => { g.referrals++; });
    if (classified.category === 'not_interested') mark('notInterested', () => { g.notInterested++; });
    if (classified.isInquiry) mark('inquiries', () => { g.inquiries++; });
    if (classified.isSampleRequest) mark('sampleRequests', () => { g.sampleRequests++; });
  }

  // Attribute quotations & won deals ONLY to customers with a verified sent letter before the quote/win
  for (const q of quotations) {
    const cid = String(q.customerId);
    const attempt = attributedCustomerAttempt.get(cid) ?? customerLatestSent.get(cid);
    if (!attempt) continue;
    if (q.createdAt >= (attempt.sentAt ?? attempt.createdAt)) {
      ensureGroup(attempt).quotedCustomers.add(cid);
    }
  }
  for (const won of wonCustomers) {
    const cid = String(won._id);
    const attempt = attributedCustomerAttempt.get(cid) ?? customerLatestSent.get(cid);
    if (!attempt) continue;
    ensureGroup(attempt).wonCustomers.add(cid);
  }

  const finalGroups: OutreachResultGroup[] = [...groups.values()].map((g) => {
    const denom = Math.max(1, g.sent);
    const openRate = Number((g.opened / denom).toFixed(4));
    const replyRate = Number((g.replies / denom).toFixed(4));
    const negativeRate = Number(((g.optOuts + g.hardBounces + g.complaints) / denom).toFixed(4));
    const insufficientSample = g.sent < minSample;
    const highOpenLowReply = !insufficientSample && openRate >= 0.35 && replyRate <= 0.02;

    let recommendation: OutreachResultGroup['recommendation'] = 'keep';
    let recommendationReason = '有效回复与互动表现正常，建议继续保留该角度观察';
    if (insufficientSample) {
      recommendation = 'insufficient_sample';
      recommendationReason = `已发送 ${g.sent} 封，未达到最低样本门槛（${minSample} 封），暂不下结论`;
    } else if (g.complaints > 0 || negativeRate >= 0.08) {
      recommendation = 'pause';
      recommendationReason = `负面反馈偏高（退订 ${g.optOuts}、退信 ${g.hardBounces}、投诉 ${g.complaints}，占比 ${(negativeRate * 100).toFixed(1)}%），建议立即停用该切入点`;
    } else if (highOpenLowReply || (g.replies === 0 && g.inquiries === 0 && g.sampleRequests === 0)) {
      recommendation = 'rewrite';
      recommendationReason = highOpenLowReply
        ? `触发「打开多、回复少」复盘信号（打开率 ${(openRate * 100).toFixed(1)}%，有效回复率 ${(replyRate * 100).toFixed(1)}%），说明主题吸引点击但正文或 CTA 未打动买家，建议改写正文与提问`
        : `达到样本量但尚无有效回复/询价/要样，建议重写该角度话术或调整目标人群`;
    } else if (g.interested + g.inquiries + g.sampleRequests + g.quotedCustomers.size > 0) {
      recommendation = 'keep';
      recommendationReason = `已产出有效意向/询价/要样或报价（意向 ${g.interested}、询价 ${g.inquiries}、要样 ${g.sampleRequests}、报价 ${g.quotedCustomers.size}），建议保留并提炼优秀范本`;
    }

    return {
      brandKey: g.brandKey,
      angleCode: g.angleCode,
      angle: g.angle,
      preferenceCode: g.preferenceCode,
      preferenceName: g.preferenceName,
      step: g.step,
      version: g.version,
      sent: g.sent,
      uniqueCustomers: g.customers.size,
      humanEdited: g.humanEdited,
      hardBounces: g.hardBounces,
      optOuts: g.optOuts,
      complaints: g.complaints,
      opened: g.opened,
      clicked: g.clicked,
      proxyOpens: g.proxyOpens,
      scannerClicks: g.scannerClicks,
      replies: g.replies,
      interested: g.interested,
      referrals: g.referrals,
      notInterested: g.notInterested,
      inquiries: g.inquiries,
      sampleRequests: g.sampleRequests,
      quoted: g.quotedCustomers.size,
      won: g.wonCustomers.size,
      openRate,
      replyRate,
      negativeRate,
      insufficientSample,
      highOpenLowReply,
      recommendation,
      recommendationReason,
    };
  });

  return {
    windowDays,
    minSample,
    brandKey,
    totalMatched,
    analyzedCount: attempts.length,
    truncated,
    denominatorNote: `分母为近 ${windowDays} 天按最新发信时间倒序统计的已投递开发信（最多分析 ${MAX_ANALYZED_LETTERS} 封${truncated ? '，本次已达上限并截断较早记录' : ''}）；无法通过 In-Reply-To / References / ThreadId 核实归因的客户回复单列在 unmatchedReplies，不计入角度回复率。`,
    complaintCoverageNotice: '投诉统计仅覆盖已通过收件同步（ARF 反馈报告/滥用通知）或退订链接回传的信号，外部邮箱服务商未公开的静默举报无法观测。',
    groups: finalGroups,
    unmatchedReplies: {
      ...unmatchedReplies,
      note: '这些客户回复未能通过邮件线程头匹配到具体开发信，已单独列出而不强行归因。',
    },
    optOuts: new Set(signals.filter((signal) => signal.reason === 'unsubscribe').map((signal) => signal.email)).size,
    observedComplaints: new Set(signals.filter((signal) => ['complaint', 'spam'].includes(signal.reason)).map((signal) => signal.email)).size,
    observedBounces: new Set(signals.filter((signal) => signal.reason === 'hard_bounce').map((signal) => signal.email)).size,
  };
}

/** Cross-brand comparison rollup across active projects in an organization. */
export async function crossBrandOutreachResults(organizationId: string, windowDays = 30) {
  const projects = await Project.find({ organizationId, status: 'active' })
    .select('_id name code slug brandProfile')
    .lean();
  const byProject = await Promise.all(
    projects.map(async (p) => {
      const report = await campaignResults(p._id, undefined, organizationId, { windowDays });
      const sent = report.groups.reduce((s, g) => s + g.sent, 0);
      const replies = report.groups.reduce((s, g) => s + g.replies, 0);
      const interested = report.groups.reduce((s, g) => s + g.interested, 0);
      const inquiries = report.groups.reduce((s, g) => s + g.inquiries, 0);
      const sampleRequests = report.groups.reduce((s, g) => s + g.sampleRequests, 0);
      const quoted = report.groups.reduce((s, g) => s + g.quoted, 0);
      const won = report.groups.reduce((s, g) => s + g.won, 0);
      return {
        projectId: String(p._id),
        projectName: p.name,
        brandKey: report.brandKey,
        sent,
        replies,
        interested,
        inquiries,
        sampleRequests,
        quoted,
        won,
        replyRate: sent ? Number((replies / sent).toFixed(4)) : 0,
        optOuts: report.optOuts,
        observedBounces: report.observedBounces,
        observedComplaints: report.observedComplaints,
        highOpenLowReplyGroups: report.groups.filter((g) => g.highOpenLowReply).length,
      };
    }),
  );
  return { windowDays, projects: byProject };
}
