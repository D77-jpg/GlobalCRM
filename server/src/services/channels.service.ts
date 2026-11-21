import { createHmac, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import {
  ChannelConfig,
  ChannelConversation,
  ChannelMessage,
  Customer,
  CustomerWorkbenchItem,
  FollowUp,
  Project,
  Quotation,
  type ChannelConversationDocument,
  type ChannelMessageDocument,
  type ConversationStatus,
  type IChannelAttachment,
  type OmnichannelType,
} from '../models';
import { runWithTenant } from '../models/tenant-context';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { requireProjectId } from '../utils/access';
import { getCustomerByIdOrThrow } from './customer.service';
import { decryptChannelCredential, encryptChannelCredential } from './credential-crypto';
import { translateLetter } from './agent/translation.service';

export interface ChannelConfigPublicDto {
  projectId: string;
  whatsappEnabled: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  displayPhoneNumber: string;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasVerifyToken: boolean;
  webhookPath: string;
  webhookLastReceivedAt?: string;
  webhookLastError?: string;
}

export interface ChannelConversationDto {
  id: string;
  customerId?: string;
  ownerId?: string;
  channel: OmnichannelType;
  externalContactId: string;
  contactName: string;
  contactCompany?: string;
  contactCountry?: string;
  contactPhone?: string;
  contactEmail?: string;
  status: ConversationStatus;
  starred: boolean;
  tags: string[];
  unreadCount: number;
  mode: 'api_live' | 'manual_assist';
  lastMessagePreview: string;
  lastMessageDirection: 'inbound' | 'outbound';
  lastMessageAt: string;
  createdAt: string;
}

export interface ChannelMessageDto {
  id: string;
  conversationId: string;
  channel: OmnichannelType;
  direction: 'inbound' | 'outbound';
  deliveryStatus: string;
  externalMessageId?: string;
  text: string;
  zhTranslation?: string;
  detectedLang?: string;
  attachments: IChannelAttachment[];
  senderName?: string;
  errorMessage?: string;
  sentAt: string;
}

function normalizePhoneDigits(raw?: string): string {
  return String(raw || '').replace(/\D/g, '');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function toConversationDto(doc: ChannelConversationDocument | (Record<string, unknown> & { _id: unknown })): ChannelConversationDto {
  const c = doc as unknown as ChannelConversationDocument;
  return {
    id: String(c._id),
    customerId: c.customerId ? String(c.customerId) : undefined,
    ownerId: c.ownerId ? String(c.ownerId) : undefined,
    channel: c.channel,
    externalContactId: c.externalContactId,
    contactName: c.contactName,
    contactCompany: c.contactCompany,
    contactCountry: c.contactCountry,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    status: c.status,
    starred: Boolean(c.starred),
    tags: Array.isArray(c.tags) ? c.tags : [],
    unreadCount: Number(c.unreadCount || 0),
    mode: c.mode || 'manual_assist',
    lastMessagePreview: c.lastMessagePreview || '',
    lastMessageDirection: c.lastMessageDirection || 'inbound',
    lastMessageAt: new Date(c.lastMessageAt).toISOString(),
    createdAt: new Date(c.createdAt).toISOString(),
  };
}

function toMessageDto(doc: ChannelMessageDocument | (Record<string, unknown> & { _id: unknown })): ChannelMessageDto {
  const m = doc as unknown as ChannelMessageDocument;
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    channel: m.channel,
    direction: m.direction,
    deliveryStatus: m.deliveryStatus,
    externalMessageId: m.externalMessageId,
    text: m.text,
    zhTranslation: m.zhTranslation,
    detectedLang: m.detectedLang,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    senderName: m.senderName,
    errorMessage: m.errorMessage,
    sentAt: new Date(m.sentAt).toISOString(),
  };
}

function canManageChannelConfig(actor: AuthUser): boolean {
  return actor.role === 'admin' || actor.role === 'project_admin';
}

/* -------------------- WhatsApp Cloud API Config -------------------- */

export async function getChannelConfig(actor: AuthUser): Promise<ChannelConfigPublicDto> {
  const projectId = String(requireProjectId(actor));
  const doc = await ChannelConfig.findOne({ projectId }).lean();
  return {
    projectId,
    whatsappEnabled: Boolean(doc?.whatsappEnabled),
    phoneNumberId: doc?.phoneNumberId || '',
    businessAccountId: doc?.businessAccountId || '',
    displayPhoneNumber: doc?.displayPhoneNumber || '',
    hasAccessToken: Boolean(doc?.accessTokenEncrypted?.ciphertext),
    hasAppSecret: Boolean(doc?.appSecretEncrypted?.ciphertext),
    hasVerifyToken: Boolean(doc?.verifyTokenEncrypted?.ciphertext),
    webhookPath: `/api/channels/whatsapp/webhook/${projectId}`,
    webhookLastReceivedAt: doc?.webhookLastReceivedAt ? new Date(doc.webhookLastReceivedAt).toISOString() : undefined,
    webhookLastError: doc?.webhookLastError,
  };
}

export async function updateChannelConfig(
  input: {
    whatsappEnabled?: boolean;
    phoneNumberId?: string;
    businessAccountId?: string;
    displayPhoneNumber?: string;
    accessToken?: string;
    appSecret?: string;
    verifyToken?: string;
  },
  actor: AuthUser,
): Promise<ChannelConfigPublicDto> {
  if (!canManageChannelConfig(actor)) {
    throw ApiError.forbidden('仅管理员或项目管理员可配置 WhatsApp Cloud API');
  }
  const projectId = requireProjectId(actor);
  let doc = await ChannelConfig.findOne({ projectId });
  if (!doc) {
    doc = new ChannelConfig({ projectId: new Types.ObjectId(projectId) });
  }
  if (input.whatsappEnabled !== undefined) doc.whatsappEnabled = input.whatsappEnabled;
  if (input.phoneNumberId !== undefined) doc.phoneNumberId = input.phoneNumberId.trim();
  if (input.businessAccountId !== undefined) doc.businessAccountId = input.businessAccountId.trim();
  if (input.displayPhoneNumber !== undefined) doc.displayPhoneNumber = input.displayPhoneNumber.trim();
  if (input.accessToken && input.accessToken.trim()) {
    doc.accessTokenEncrypted = encryptChannelCredential(input.accessToken.trim());
  }
  if (input.appSecret && input.appSecret.trim()) {
    doc.appSecretEncrypted = encryptChannelCredential(input.appSecret.trim());
  }
  if (input.verifyToken && input.verifyToken.trim()) {
    doc.verifyTokenEncrypted = encryptChannelCredential(input.verifyToken.trim());
  }
  if (doc.whatsappEnabled) {
    if (!doc.phoneNumberId || !doc.accessTokenEncrypted?.ciphertext || !doc.appSecretEncrypted?.ciphertext || !doc.verifyTokenEncrypted?.ciphertext) {
      throw ApiError.badRequest('启用官方 WhatsApp Cloud API 前需完整填写 Phone Number ID、Access Token、App Secret 和 Verify Token');
    }
  }
  doc.updatedBy = new Types.ObjectId(actor.id);
  await doc.save();
  return getChannelConfig(actor);
}

/* -------------------- Meta WhatsApp Business Cloud API Webhook -------------------- */

export async function verifyWhatsAppWebhookChallenge(
  projectId: string,
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
): Promise<string> {
  if (!Types.ObjectId.isValid(projectId)) throw ApiError.badRequest('无效的项目标识');
  if (mode !== 'subscribe' || !token || !challenge) throw ApiError.forbidden('Webhook 验证参数无效');

  const project = await runWithTenant({ bypass: true, source: 'wa-webhook-verify' }, () =>
    Project.findById(projectId).select('_id organizationId').lean(),
  );
  if (!project) throw ApiError.notFound('项目不存在');

  const cfg = await runWithTenant({ organizationId: String(project.organizationId), source: 'wa-webhook-verify' }, () =>
    ChannelConfig.findOne({ projectId }).lean(),
  );
  if (!cfg?.verifyTokenEncrypted) throw ApiError.forbidden('该项目尚未配置 WhatsApp Verify Token');

  const expected = decryptChannelCredential(cfg.verifyTokenEncrypted);
  if (!safeEqual(token, expected)) throw ApiError.forbidden('Verify Token 校验失败');
  return challenge;
}

interface MetaWebhookBody {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          caption?: string;
          image?: { caption?: string; mime_type?: string };
          document?: { filename?: string; caption?: string; mime_type?: string };
        }[];
        statuses?: {
          id?: string;
          status?: string;
          errors?: { title?: string; message?: string }[];
        }[];
      };
    }[];
  }[];
}

export async function handleWhatsAppWebhookPayload(
  projectId: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  parsedBody: MetaWebhookBody,
): Promise<{ processedMessages: number; processedStatuses: number }> {
  if (!Types.ObjectId.isValid(projectId)) throw ApiError.badRequest('无效的项目标识');
  const project = await runWithTenant({ bypass: true, source: 'wa-webhook-post' }, () =>
    Project.findById(projectId).select('_id organizationId').lean(),
  );
  if (!project) throw ApiError.notFound('项目不存在');

  return runWithTenant({ organizationId: String(project.organizationId), source: 'wa-webhook-post' }, async () => {
    const cfg = await ChannelConfig.findOne({ projectId });
    if (!cfg || !cfg.whatsappEnabled || !cfg.appSecretEncrypted) {
      throw ApiError.forbidden('WhatsApp Cloud API 未启用或未配置 App Secret');
    }

    const appSecret = decryptChannelCredential(cfg.appSecretEncrypted);
    const expectedSig = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    if (!signatureHeader || !safeEqual(signatureHeader.trim(), expectedSig)) {
      cfg.webhookLastError = '签名校验失败（X-Hub-Signature-256 不匹配）';
      await cfg.save();
      throw ApiError.unauthorized('Webhook 签名校验失败');
    }

    let processedMessages = 0;
    let processedStatuses = 0;
    const projectOid = new Types.ObjectId(projectId);

    for (const entry of parsedBody.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const contactMap = new Map<string, string>();
        for (const ct of value.contacts ?? []) {
          if (ct.wa_id && ct.profile?.name) contactMap.set(normalizePhoneDigits(ct.wa_id), ct.profile.name);
        }

        // Inbound messages
        for (const msg of value.messages ?? []) {
          const waId = normalizePhoneDigits(msg.from);
          const externalMessageId = msg.id ? String(msg.id) : undefined;
          if (!waId) continue;

          if (externalMessageId) {
            const exists = await ChannelMessage.exists({ projectId: projectOid, externalMessageId });
            if (exists) continue;
          }

          let text = msg.text?.body?.trim() || '';
          const attachments: IChannelAttachment[] = [];
          if (msg.type === 'image') {
            text = text || msg.image?.caption || '[图片消息]';
            attachments.push({ name: 'WhatsApp Image', mimeType: msg.image?.mime_type || 'image/jpeg' });
          } else if (msg.type === 'document') {
            text = text || msg.document?.caption || `[文件：${msg.document?.filename || 'Document'}]`;
            attachments.push({ name: msg.document?.filename || 'document', mimeType: msg.document?.mime_type });
          } else if (!text) {
            text = `[${msg.type || 'message'} 消息]`;
          }

          const sentAt = msg.timestamp && /^\d+$/.test(msg.timestamp) ? new Date(Number(msg.timestamp) * 1000) : new Date();
          const contactName = contactMap.get(waId) || `+${waId}`;

          let conv = await ChannelConversation.findOne({ projectId: projectOid, channel: 'whatsapp', externalContactId: waId });
          if (!conv) {
            // Try matching an existing CRM customer by phone suffix digits
            const tail = waId.slice(-8);
            const candidates = tail.length >= 7
              ? await Customer.find({ projectId: projectOid, phone: { $exists: true, $ne: '' } }).select('_id name company country phone email ownerId').limit(300).lean()
              : [];
            const matchedCustomer = candidates.find((c) => normalizePhoneDigits(c.phone).endsWith(tail));

            conv = await ChannelConversation.create({
              projectId: projectOid,
              customerId: matchedCustomer?._id,
              ownerId: matchedCustomer?.ownerId,
              channel: 'whatsapp',
              externalContactId: waId,
              contactName: matchedCustomer?.name || contactName,
              contactCompany: matchedCustomer?.company,
              contactCountry: matchedCustomer?.country,
              contactPhone: `+${waId}`,
              contactEmail: matchedCustomer?.email,
              status: 'open',
              mode: 'api_live',
              unreadCount: 1,
              lastMessagePreview: text.slice(0, 200),
              lastMessageDirection: 'inbound',
              lastMessageAt: sentAt,
            });
          } else {
            conv.mode = 'api_live';
            conv.unreadCount = (conv.unreadCount || 0) + 1;
            conv.lastMessagePreview = text.slice(0, 200);
            conv.lastMessageDirection = 'inbound';
            conv.lastMessageAt = sentAt;
            if (conv.status === 'resolved' || conv.status === 'archived') conv.status = 'open';
            await conv.save();
          }

          await ChannelMessage.create({
            projectId: projectOid,
            conversationId: conv._id,
            customerId: conv.customerId,
            channel: 'whatsapp',
            direction: 'inbound',
            deliveryStatus: 'received',
            externalMessageId,
            text,
            attachments,
            senderName: conv.contactName,
            sentAt,
          });

          if (conv.customerId) {
            await Customer.updateOne({ _id: conv.customerId, projectId: projectOid }, { $set: { lastContactDate: sentAt } });
          }

          processedMessages += 1;
        }

        // Delivery status updates
        for (const st of value.statuses ?? []) {
          if (!st.id || !st.status) continue;
          const mapped = st.status === 'sent' ? 'sent_api'
            : st.status === 'delivered' ? 'delivered'
              : st.status === 'read' ? 'read'
                : st.status === 'failed' ? 'failed'
                  : null;
          if (!mapped) continue;
          const errText = st.errors?.[0]?.message || st.errors?.[0]?.title;
          const res = await ChannelMessage.updateOne(
            { projectId: projectOid, externalMessageId: st.id },
            { $set: { deliveryStatus: mapped, ...(errText ? { errorMessage: errText.slice(0, 400) } : {}) } },
          );
          if (res.modifiedCount > 0) processedStatuses += 1;
        }
      }
    }

    cfg.webhookLastReceivedAt = new Date();
    cfg.webhookLastError = undefined;
    await cfg.save();
    return { processedMessages, processedStatuses };
  });
}

/* -------------------- Omnichannel Conversations & Messages -------------------- */

export async function listChannelConversations(
  actor: AuthUser,
  filters: {
    channel?: OmnichannelType;
    tab?: 'all' | 'unread' | 'followup' | 'starred';
    search?: string;
  },
): Promise<{
  items: ChannelConversationDto[];
  stats: {
    todayMessages: number;
    activeConversations: number;
    unreadTotal: number;
    pendingFollowup: number;
    starredCount: number;
    whatsappConnected: boolean;
  };
}> {
  const projectId = requireProjectId(actor);
  const projectOid = new Types.ObjectId(projectId);
  const baseFilter: Record<string, unknown> = { projectId: projectOid };
  if (actor.role !== 'admin' && actor.role !== 'project_admin') {
    baseFilter.$or = [{ ownerId: new Types.ObjectId(actor.id) }, { ownerId: { $exists: false } }, { ownerId: null }];
  }

  const queryFilter: Record<string, unknown> = { ...baseFilter };
  if (filters.channel) queryFilter.channel = filters.channel;
  if (filters.tab === 'unread') queryFilter.unreadCount = { $gt: 0 };
  else if (filters.tab === 'followup') queryFilter.status = 'pending_followup';
  else if (filters.tab === 'starred') queryFilter.starred = true;
  else queryFilter.status = { $ne: 'archived' };

  if (filters.search?.trim()) {
    const rx = new RegExp(filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    queryFilter.$and = [
      {
        $or: [
          { contactName: rx },
          { contactCompany: rx },
          { contactPhone: rx },
          { contactEmail: rx },
          { externalContactId: rx },
          { lastMessagePreview: rx },
          { tags: rx },
        ],
      },
    ];
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [docs, allStatsDocs, todayMessages, cfg] = await Promise.all([
    ChannelConversation.find(queryFilter).sort({ lastMessageAt: -1 }).limit(120).lean(),
    ChannelConversation.find({ ...baseFilter, status: { $ne: 'archived' } }).select('status starred unreadCount').lean(),
    ChannelMessage.countDocuments({ projectId: projectOid, sentAt: { $gte: startOfToday } }),
    ChannelConfig.findOne({ projectId: projectOid }).select('whatsappEnabled').lean(),
  ]);

  let unreadTotal = 0;
  let pendingFollowup = 0;
  let starredCount = 0;
  for (const d of allStatsDocs) {
    unreadTotal += Number(d.unreadCount || 0);
    if (d.status === 'pending_followup') pendingFollowup += 1;
    if (d.starred) starredCount += 1;
  }

  return {
    items: docs.map((d) => toConversationDto(d)),
    stats: {
      todayMessages,
      activeConversations: allStatsDocs.length,
      unreadTotal,
      pendingFollowup,
      starredCount,
      whatsappConnected: Boolean(cfg?.whatsappEnabled),
    },
  };
}

export async function createChannelConversation(
  input: {
    channel: OmnichannelType;
    customerId?: string;
    contactName?: string;
    contactCompany?: string;
    contactCountry?: string;
    contactPhone?: string;
    contactEmail?: string;
    externalContactId?: string;
    tags?: string[];
    initialInboundText?: string;
  },
  actor: AuthUser,
): Promise<{ conversation: ChannelConversationDto; initialMessage?: ChannelMessageDto }> {
  const projectId = requireProjectId(actor);
  const projectOid = new Types.ObjectId(projectId);

  let customer: { _id: Types.ObjectId; name: string; company?: string; country?: string; phone?: string; email?: string; ownerId?: Types.ObjectId } | null = null;
  if (input.customerId && Types.ObjectId.isValid(input.customerId)) {
    await getCustomerByIdOrThrow(input.customerId, actor);
    customer = await Customer.findOne({ _id: input.customerId, projectId: projectOid })
      .select('_id name company country phone email ownerId')
      .lean();
  }

  const contactName = (input.contactName?.trim() || customer?.name || '').trim();
  if (!contactName) throw ApiError.badRequest('请填写联系人名称或选择已有客户');

  const rawExtId = input.externalContactId?.trim()
    || (input.channel === 'whatsapp' ? normalizePhoneDigits(input.contactPhone || customer?.phone) : '')
    || input.contactEmail?.trim()
    || customer?.email
    || `${input.channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const externalContactId = input.channel === 'whatsapp' && normalizePhoneDigits(rawExtId).length >= 6
    ? normalizePhoneDigits(rawExtId)
    : rawExtId.slice(0, 150);

  let conv = await ChannelConversation.findOne({ projectId: projectOid, channel: input.channel, externalContactId });
  if (!conv) {
    conv = await ChannelConversation.create({
      projectId: projectOid,
      customerId: customer?._id,
      ownerId: customer?.ownerId || new Types.ObjectId(actor.id),
      channel: input.channel,
      externalContactId,
      contactName,
      contactCompany: input.contactCompany?.trim() || customer?.company,
      contactCountry: input.contactCountry?.trim() || customer?.country,
      contactPhone: input.contactPhone?.trim() || customer?.phone,
      contactEmail: input.contactEmail?.trim() || customer?.email,
      status: 'open',
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10),
      unreadCount: input.initialInboundText?.trim() ? 1 : 0,
      mode: 'manual_assist',
      lastMessagePreview: input.initialInboundText?.trim().slice(0, 200) || '会话已创建',
      lastMessageDirection: 'inbound',
      lastMessageAt: new Date(),
      createdBy: new Types.ObjectId(actor.id),
    });
  } else if (customer && !conv.customerId) {
    conv.customerId = customer._id;
    await conv.save();
  }

  let initialMessage: ChannelMessageDto | undefined;
  if (input.initialInboundText?.trim()) {
    const added = await addChannelMessage(String(conv._id), {
      direction: 'inbound',
      text: input.initialInboundText.trim(),
      autoTranslate: true,
    }, actor);
    initialMessage = added.message;
    conv = await ChannelConversation.findById(conv._id) ?? conv;
  }

  return { conversation: toConversationDto(conv), initialMessage };
}

async function getConversationOrThrow(id: string, actor: AuthUser): Promise<ChannelConversationDocument> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('会话 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const conv = await ChannelConversation.findOne({ _id: id, projectId });
  if (!conv) throw ApiError.notFound('会话不存在');
  if (actor.role !== 'admin' && actor.role !== 'project_admin' && conv.ownerId && String(conv.ownerId) !== actor.id) {
    throw ApiError.forbidden('无权访问该会话');
  }
  return conv;
}

export async function getChannelConversationDetail(
  id: string,
  actor: AuthUser,
): Promise<{
  conversation: ChannelConversationDto;
  messages: ChannelMessageDto[];
  customer: {
    id: string;
    name: string;
    company?: string;
    country?: string;
    email?: string;
    phone?: string;
    status: string;
    intentScore?: number;
    tags: string[];
    requirementNotes?: string;
  } | null;
  quotations: {
    id: string;
    quotationNo: string;
    status: string;
    approvalStatus?: string;
    currency: string;
    grandTotal?: number;
    totalAmount: number;
    incoterm?: string;
    createdAt: string;
  }[];
  openItemsCount: number;
}> {
  const conv = await getConversationOrThrow(id, actor);
  const projectId = requireProjectId(actor);

  if (conv.unreadCount > 0) {
    conv.unreadCount = 0;
    await conv.save();
  }

  const messages = await ChannelMessage.find({ projectId, conversationId: conv._id })
    .sort({ sentAt: 1 })
    .limit(200)
    .lean();

  let customer: {
    id: string;
    name: string;
    company?: string;
    country?: string;
    email?: string;
    phone?: string;
    status: string;
    intentScore?: number;
    tags: string[];
    requirementNotes?: string;
  } | null = null;
  let quotations: {
    id: string;
    quotationNo: string;
    status: string;
    approvalStatus?: string;
    currency: string;
    grandTotal?: number;
    totalAmount: number;
    incoterm?: string;
    createdAt: string;
  }[] = [];
  let openItemsCount = 0;

  if (conv.customerId) {
    const [custDoc, quoteDocs, openCount] = await Promise.all([
      Customer.findOne({ _id: conv.customerId, projectId })
        .select('name company country email phone status intentScore tags requirementNotes')
        .lean(),
      Quotation.find({ projectId, customerId: conv.customerId })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('quotationNo status approvalStatus currency grandTotal totalAmount incoterm createdAt')
        .lean(),
      CustomerWorkbenchItem.countDocuments({ projectId, customerId: conv.customerId, status: { $in: ['open', 'result_ready'] } }),
    ]);

    if (custDoc) {
      customer = {
        id: String(custDoc._id),
        name: custDoc.name,
        company: custDoc.company,
        country: custDoc.country,
        email: custDoc.email,
        phone: custDoc.phone,
        status: custDoc.status,
        intentScore: custDoc.intentScore,
        tags: custDoc.tags ?? [],
        requirementNotes: custDoc.requirementNotes,
      };
    }
    quotations = quoteDocs.map((q) => ({
      id: String(q._id),
      quotationNo: q.quotationNo,
      status: q.status,
      approvalStatus: q.approvalStatus,
      currency: q.currency,
      grandTotal: q.grandTotal,
      totalAmount: q.totalAmount,
      incoterm: q.incoterm,
      createdAt: new Date(q.createdAt).toISOString(),
    }));
    openItemsCount = openCount;
  }

  return {
    conversation: toConversationDto(conv),
    messages: messages.map((m) => toMessageDto(m)),
    customer,
    quotations,
    openItemsCount,
  };
}

export async function updateChannelConversation(
  id: string,
  patch: {
    status?: ConversationStatus;
    starred?: boolean;
    tags?: string[];
    customerId?: string | null;
    contactName?: string;
    contactCompany?: string;
    contactCountry?: string;
    contactPhone?: string;
    contactEmail?: string;
  },
  actor: AuthUser,
): Promise<ChannelConversationDto> {
  const conv = await getConversationOrThrow(id, actor);
  if (patch.status !== undefined) conv.status = patch.status;
  if (patch.starred !== undefined) conv.starred = patch.starred;
  if (patch.tags !== undefined) conv.tags = patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 12);
  if (patch.contactName !== undefined) conv.contactName = patch.contactName.trim();
  if (patch.contactCompany !== undefined) conv.contactCompany = patch.contactCompany.trim();
  if (patch.contactCountry !== undefined) conv.contactCountry = patch.contactCountry.trim();
  if (patch.contactPhone !== undefined) conv.contactPhone = patch.contactPhone.trim();
  if (patch.contactEmail !== undefined) conv.contactEmail = patch.contactEmail.trim();

  if (patch.customerId !== undefined) {
    if (patch.customerId === null || patch.customerId === '') {
      conv.customerId = undefined;
    } else if (Types.ObjectId.isValid(patch.customerId)) {
      await getCustomerByIdOrThrow(patch.customerId, actor);
      conv.customerId = new Types.ObjectId(patch.customerId);
    } else {
      throw ApiError.badRequest('客户 ID 格式不正确');
    }
  }
  await conv.save();
  return toConversationDto(conv);
}

export async function addChannelMessage(
  conversationId: string,
  input: {
    direction: 'inbound' | 'outbound';
    text: string;
    zhTranslation?: string;
    sendViaApi?: boolean;
    autoTranslate?: boolean;
    attachments?: IChannelAttachment[];
  },
  actor: AuthUser,
): Promise<{ message: ChannelMessageDto; apiDelivered: boolean; apiError?: string }> {
  const conv = await getConversationOrThrow(conversationId, actor);
  const projectId = requireProjectId(actor);
  const projectOid = new Types.ObjectId(projectId);
  const text = input.text.trim();
  if (!text) throw ApiError.badRequest('消息内容不能为空');

  let zhTranslation = input.zhTranslation?.trim() || undefined;
  if (!zhTranslation && input.autoTranslate && /[A-Za-z]{3,}/.test(text)) {
    try {
      const tr = await translateLetter({ body: text });
      if (tr.body && tr.body.trim() && tr.body.trim() !== text) {
        zhTranslation = tr.body.trim();
      }
    } catch {
      // Optional translation should never block sending/logging a message
    }
  }

  let deliveryStatus: 'received' | 'logged_manual' | 'sent_api' | 'failed' =
    input.direction === 'inbound' ? 'received' : 'logged_manual';
  let externalMessageId: string | undefined;
  let apiDelivered = false;
  let apiError: string | undefined;

  if (input.direction === 'outbound' && input.sendViaApi && conv.channel === 'whatsapp') {
    const cfg = await ChannelConfig.findOne({ projectId: projectOid });
    if (!cfg || !cfg.whatsappEnabled || !cfg.phoneNumberId || !cfg.accessTokenEncrypted) {
      throw ApiError.badRequest('当前项目未启用官方 WhatsApp Cloud API，请先配置或使用「记录并复制」模式');
    }
    const toDigits = normalizePhoneDigits(conv.contactPhone || conv.externalContactId);
    if (toDigits.length < 7) {
      throw ApiError.badRequest('该会话缺少有效的国际手机号（含国家区号），无法通过 WhatsApp API 直发');
    }
    const token = decryptChannelCredential(cfg.accessTokenEncrypted);
    const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toDigits,
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      });
      const body = await res.json().catch(() => ({})) as { messages?: { id?: string }[]; error?: { message?: string } };
      if (res.ok && body.messages?.[0]?.id) {
        externalMessageId = body.messages[0].id;
        deliveryStatus = 'sent_api';
        apiDelivered = true;
      } else {
        deliveryStatus = 'failed';
        apiError = body.error?.message || `WhatsApp Cloud API 返回 HTTP ${res.status}`;
      }
    } catch (error) {
      deliveryStatus = 'failed';
      apiError = error instanceof Error ? error.message : 'WhatsApp Cloud API 网络请求失败';
    }
  }

  const now = new Date();
  const msgDoc = await ChannelMessage.create({
    projectId: projectOid,
    conversationId: conv._id,
    customerId: conv.customerId,
    channel: conv.channel,
    direction: input.direction,
    deliveryStatus,
    externalMessageId,
    text,
    zhTranslation,
    attachments: input.attachments ?? [],
    senderName: input.direction === 'inbound' ? conv.contactName : (actor.displayName || actor.username),
    createdBy: new Types.ObjectId(actor.id),
    errorMessage: apiError?.slice(0, 400),
    sentAt: now,
  });

  conv.lastMessagePreview = text.slice(0, 200);
  conv.lastMessageDirection = input.direction;
  conv.lastMessageAt = now;
  if (input.direction === 'inbound') {
    conv.unreadCount = 0; // Active agent just logged it in view
    if (conv.status === 'resolved') conv.status = 'open';
  }
  await conv.save();

  // Sync to linked CRM customer timeline automatically
  if (conv.customerId && deliveryStatus !== 'failed') {
    const labelMap: Record<OmnichannelType, string> = {
      whatsapp: 'WhatsApp',
      alibaba: 'Alibaba',
      instagram: 'Instagram',
      trademanager: 'TradeManager',
      wechat: '微信',
      web_chat: '在线客服',
    };
    const prefix = input.direction === 'inbound'
      ? `[${labelMap[conv.channel]} 客户来信]`
      : `[${labelMap[conv.channel]} 我方回复]`;
    await Promise.all([
      Customer.updateOne({ _id: conv.customerId, projectId: projectOid }, { $set: { lastContactDate: now } }),
      FollowUp.create({
        projectId: projectOid,
        customerId: conv.customerId,
        method: conv.channel === 'whatsapp' ? 'whatsapp' : 'chat',
        content: `${prefix} ${text.slice(0, 380)}`,
        result: input.direction === 'inbound' ? 'replied' : 'other',
        followUpAt: now,
        createdBy: new Types.ObjectId(actor.id),
      }),
    ]);
  }

  return { message: toMessageDto(msgDoc), apiDelivered, apiError };
}

export async function translateChannelMessage(messageId: string, actor: AuthUser): Promise<ChannelMessageDto> {
  if (!Types.ObjectId.isValid(messageId)) throw ApiError.badRequest('消息 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const msg = await ChannelMessage.findOne({ _id: messageId, projectId });
  if (!msg) throw ApiError.notFound('消息不存在');
  await getConversationOrThrow(String(msg.conversationId), actor);

  if (msg.zhTranslation?.trim()) {
    return toMessageDto(msg);
  }
  const tr = await translateLetter({ body: msg.text });
  msg.zhTranslation = tr.body.trim();
  await msg.save();
  return toMessageDto(msg);
}

export async function createCustomerFromConversation(
  conversationId: string,
  actor: AuthUser,
): Promise<{ customerId: string; conversation: ChannelConversationDto }> {
  const conv = await getConversationOrThrow(conversationId, actor);
  if (conv.customerId) {
    return { customerId: String(conv.customerId), conversation: toConversationDto(conv) };
  }
  const projectId = requireProjectId(actor);
  const projectOid = new Types.ObjectId(projectId);
  const created = await Customer.create({
    projectId: projectOid,
    name: conv.contactName,
    company: conv.contactCompany || `${conv.contactName} (${conv.channel.toUpperCase()})`,
    country: conv.contactCountry || '待补充',
    phone: conv.contactPhone || (conv.channel === 'whatsapp' ? `+${normalizePhoneDigits(conv.externalContactId)}` : undefined),
    email: conv.contactEmail || undefined,
    status: 'replied',
    leadSource: conv.channel === 'whatsapp' ? 'WhatsApp' : conv.channel,
    ownerId: conv.ownerId || new Types.ObjectId(actor.id),
    lastContactDate: conv.lastMessageAt,
    requirementNotes: conv.lastMessagePreview ? `来自 ${conv.channel} 会话：${conv.lastMessagePreview}` : undefined,
  });

  conv.customerId = created._id;
  await conv.save();
  await ChannelMessage.updateMany(
    { projectId: projectOid, conversationId: conv._id },
    { $set: { customerId: created._id } },
  );

  return { customerId: String(created._id), conversation: toConversationDto(conv) };
}
