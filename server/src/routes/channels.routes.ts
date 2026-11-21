import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/pagination';
import { validate } from '../middleware/validate.middleware';
import { CONVERSATION_STATUSES, OMNICHANNEL_TYPES } from '../models';
import {
  addChannelMessage,
  createChannelConversation,
  createCustomerFromConversation,
  getChannelConfig,
  getChannelConversationDetail,
  handleWhatsAppWebhookPayload,
  listChannelConversations,
  translateChannelMessage,
  updateChannelConfig,
  updateChannelConversation,
  verifyWhatsAppWebhookChallenge,
} from '../services/channels.service';

const idParams = z.object({ id: z.string().regex(/^[a-fA-F0-9]{24}$/) });
const channelEnum = z.enum(OMNICHANNEL_TYPES);
const statusEnum = z.enum(CONVERSATION_STATUSES);

/* -------------------- Public Meta WhatsApp Business Cloud API Webhook -------------------- */

export const channelsWebhookRoutes = Router();

channelsWebhookRoutes.get('/whatsapp/webhook/:projectId', asyncHandler(async (req, res) => {
  const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : undefined;
  const token = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : undefined;
  const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : undefined;
  const verified = await verifyWhatsAppWebhookChallenge(req.params.projectId, mode, token, challenge);
  res.type('text/plain; charset=utf-8').status(200).send(verified);
}));

channelsWebhookRoutes.post('/whatsapp/webhook/:projectId', asyncHandler(async (req, res) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody
    ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), 'utf8');
  const signature = req.get('x-hub-signature-256');
  const result = await handleWhatsAppWebhookPayload(req.params.projectId, rawBody, signature, req.body ?? {});
  sendSuccess(res, result);
}));

/* -------------------- Authenticated Omnichannel Workbench Routes -------------------- */

export const channelsRoutes = Router();

channelsRoutes.get('/config', asyncHandler(async (req, res) => {
  sendSuccess(res, await getChannelConfig(req.user!));
}));

channelsRoutes.put('/config', validate({
  body: z.object({
    whatsappEnabled: z.boolean().optional(),
    phoneNumberId: z.string().max(120).optional(),
    businessAccountId: z.string().max(120).optional(),
    displayPhoneNumber: z.string().max(60).optional(),
    accessToken: z.string().max(1000).optional(),
    appSecret: z.string().max(500).optional(),
    verifyToken: z.string().max(500).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateChannelConfig(req.body, req.user!));
}));

channelsRoutes.get('/conversations', asyncHandler(async (req, res) => {
  const rawChannel = typeof req.query.channel === 'string' ? req.query.channel : undefined;
  const channel = rawChannel && (OMNICHANNEL_TYPES as readonly string[]).includes(rawChannel)
    ? rawChannel as (typeof OMNICHANNEL_TYPES)[number]
    : undefined;
  const rawTab = typeof req.query.tab === 'string' ? req.query.tab : undefined;
  const tab = rawTab && ['all', 'unread', 'followup', 'starred'].includes(rawTab)
    ? rawTab as 'all' | 'unread' | 'followup' | 'starred'
    : 'all';
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  sendSuccess(res, await listChannelConversations(req.user!, { channel, tab, search }));
}));

channelsRoutes.post('/conversations', validate({
  body: z.object({
    channel: channelEnum.default('whatsapp'),
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
    contactName: z.string().trim().max(160).optional(),
    contactCompany: z.string().trim().max(200).optional(),
    contactCountry: z.string().trim().max(80).optional(),
    contactPhone: z.string().trim().max(60).optional(),
    contactEmail: z.string().trim().max(160).optional(),
    externalContactId: z.string().trim().max(160).optional(),
    tags: z.array(z.string().trim().max(40)).max(10).optional(),
    initialInboundText: z.string().max(15000).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await createChannelConversation(req.body, req.user!), 201);
}));

channelsRoutes.get('/conversations/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await getChannelConversationDetail(req.params.id, req.user!));
}));

channelsRoutes.patch('/conversations/:id', validate({
  params: idParams,
  body: z.object({
    status: statusEnum.optional(),
    starred: z.boolean().optional(),
    tags: z.array(z.string().trim().max(40)).max(12).optional(),
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/).nullable().or(z.literal('')).optional(),
    contactName: z.string().trim().min(1).max(160).optional(),
    contactCompany: z.string().trim().max(200).optional(),
    contactCountry: z.string().trim().max(80).optional(),
    contactPhone: z.string().trim().max(60).optional(),
    contactEmail: z.string().trim().max(160).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateChannelConversation(req.params.id, req.body, req.user!));
}));

channelsRoutes.post('/conversations/:id/messages', validate({
  params: idParams,
  body: z.object({
    direction: z.enum(['inbound', 'outbound']),
    text: z.string().trim().min(1).max(15000),
    zhTranslation: z.string().max(15000).optional(),
    sendViaApi: z.boolean().optional(),
    autoTranslate: z.boolean().optional(),
    attachments: z.array(z.object({
      name: z.string().trim().min(1).max(200),
      mimeType: z.string().trim().max(120).optional(),
      size: z.number().min(0).optional(),
      quotationId: z.string().trim().max(60).optional(),
      quotationNo: z.string().trim().max(80).optional(),
    })).max(8).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await addChannelMessage(req.params.id, req.body, req.user!), 201);
}));

channelsRoutes.post('/conversations/:id/create-customer', validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await createCustomerFromConversation(req.params.id, req.user!), 201);
}));

channelsRoutes.post('/messages/:id/translate', validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await translateChannelMessage(req.params.id, req.user!));
}));

export default channelsRoutes;
