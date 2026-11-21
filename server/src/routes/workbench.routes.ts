import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/pagination';
import {
  confirmProjectPolicy,
  createProjectPolicy,
  deleteProjectPolicy,
  getProjectWorkbenchConfig,
  listProjectPolicies,
  seedWorkbenchPreset,
  updateProjectPolicy,
  updateProjectWorkbenchConfig,
} from '../services/workbench-policy.service';
import {
  answerKnowledgeQuestion,
  createCustomerWorkbenchItem,
  deleteCustomerWorkbenchItem,
  draftMultiChannelInquiry,
  draftUpdateForWorkbenchItem,
  importMarkdownBundle,
  learnFromFinalEdit,
  listCustomerWorkbenchItems,
  rewriteWorkbenchDraft,
  updateCustomerWorkbenchItem,
} from '../services/workbench-copilot.service';
import {
  convertRfqToQuotation,
  createRfq,
  deleteRfq,
  evaluateRfq,
  exportRfqCostingXlsx,
  listRfqs,
  updateRfq,
} from '../services/workbench-rfq.service';
import {
  composeDeterministicKbReply,
  runDeterministicGuard,
  runGuardrailSelftest,
  scoreWorkbenchReply,
} from '../services/agent/deterministic-guard.service';
import { ProjectPolicy } from '../models';
import { requireProjectId } from '../utils/access';
import { QUOTATION_CURRENCY } from '../constants';

const router = Router();
router.use(requireAuth);

const idParams = z.object({ id: z.string().regex(/^[a-fA-F0-9]{24}$/) });
const policyCategoryEnum = z.enum([
  'moq', 'pricing', 'samples', 'lead_time', 'payment', 'shipping', 'material', 'quality', 'compliance', 'company', 'other',
]);

/* -------------------- Policies & Workbench Config -------------------- */

router.get('/policies', asyncHandler(async (req, res) => {
  const items = await listProjectPolicies(req.user!, {
    category: typeof req.query.category === 'string' ? req.query.category : undefined,
    confirmed: typeof req.query.confirmed === 'string' ? req.query.confirmed : undefined,
    external: typeof req.query.external === 'string' ? req.query.external : undefined,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
  });
  sendSuccess(res, items);
}));

router.post('/policies', requireRole('admin', 'project_admin'), validate({
  body: z.object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/),
    topic: z.string().trim().min(1).max(120),
    category: policyCategoryEnum.optional(),
    scope: z.string().trim().max(200).optional(),
    valueZh: z.string().trim().min(1).max(2000),
    valueEn: z.string().trim().max(2000).optional(),
    external: z.boolean().optional(),
    confirmed: z.boolean().optional(),
    conflictNote: z.string().trim().max(500).optional(),
    source: z.string().trim().max(200).optional(),
    ownerRole: z.string().trim().max(80).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await createProjectPolicy(req.body, req.user!), 201);
}));

router.put('/policies/:id', requireRole('admin', 'project_admin'), validate({
  params: idParams,
  body: z.object({
    topic: z.string().trim().min(1).max(120).optional(),
    category: policyCategoryEnum.optional(),
    scope: z.string().trim().max(200).optional(),
    valueZh: z.string().trim().min(1).max(2000).optional(),
    valueEn: z.string().trim().max(2000).optional(),
    external: z.boolean().optional(),
    confirmed: z.boolean().optional(),
    conflictNote: z.string().trim().max(500).optional(),
    source: z.string().trim().max(200).optional(),
    ownerRole: z.string().trim().max(80).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateProjectPolicy(req.params.id, req.body, req.user!));
}));

router.post('/policies/:id/confirm', requireRole('admin', 'project_admin'), validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await confirmProjectPolicy(req.params.id, req.user!));
}));

router.delete('/policies/:id', requireRole('admin', 'project_admin'), validate({ params: idParams }), asyncHandler(async (req, res) => {
  await deleteProjectPolicy(req.params.id, req.user!);
  sendSuccess(res, { deleted: true });
}));

router.post('/policies/seed-preset', requireRole('admin', 'project_admin'), validate({
  body: z.object({ preset: z.enum(['genesis', 'general']).default('genesis') }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await seedWorkbenchPreset(req.body.preset, req.user!));
}));

router.get('/config', asyncHandler(async (req, res) => {
  sendSuccess(res, await getProjectWorkbenchConfig(req.user!));
}));

router.put('/config', requireRole('admin', 'project_admin'), validate({
  body: z.object({
    pricingMode: z.enum(['catalog_tiered', 'costing_approved']).optional(),
    guardrailRedlines: z.array(z.object({
      id: z.string().trim().min(1).max(60),
      pattern: z.string().trim().min(1).max(350),
      message: z.string().trim().min(1).max(400),
      severity: z.enum(['bad', 'warn']).default('bad'),
      skipSegment: z.string().trim().max(20).optional(),
      enabled: z.boolean().default(true),
    })).max(100).optional(),
    teamWritingRules: z.array(z.object({
      id: z.string().trim().min(1).max(60),
      text: z.string().trim().min(1).max(500),
      enabled: z.boolean().default(true),
      source: z.string().trim().max(120).optional(),
    })).max(100).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateProjectWorkbenchConfig(req.body, req.user!));
}));

/* -------------------- Deterministic Guardrails & Selftest -------------------- */

router.post('/guardrails/check', validate({
  body: z.object({
    subject: z.string().max(300).default(''),
    body: z.string().max(20000),
    inboundText: z.string().max(12000).optional(),
    threadText: z.string().max(12000).optional(),
    contactName: z.string().max(120).optional(),
    attachedOutFiles: z.array(z.string().max(200)).max(20).optional(),
    channel: z.enum(['email', 'whatsapp', 'alibaba', 'trademanager', 'instagram', 'web', 'chat']).optional(),
    complaintLevel: z.enum(['', 'R1', 'R2', 'R3', 'R4']).optional(),
    threadSubject: z.string().max(300).optional(),
    destination: z.string().max(160).optional(),
  }),
}), asyncHandler(async (req, res) => {
  const projectId = requireProjectId(req.user!);
  const [policies, config] = await Promise.all([
    ProjectPolicy.find({ projectId }).lean(),
    getProjectWorkbenchConfig(req.user!),
  ]);
  const ctx = {
    brandKey: config.brandKey,
    policies,
    redlines: config.guardrailRedlines,
    inboundText: req.body.inboundText,
    threadText: req.body.threadText,
    contactName: req.body.contactName,
    attachedOutFiles: req.body.attachedOutFiles,
    channel: req.body.channel ?? 'email',
    complaintLevel: req.body.complaintLevel ?? '',
    threadSubject: req.body.threadSubject,
    destination: req.body.destination,
  };
  const checks = runDeterministicGuard(req.body.subject, req.body.body, ctx);
  const score = scoreWorkbenchReply(req.body.subject, req.body.body, ctx);
  sendSuccess(res, { checks, score });
}));

router.post('/guardrails/kb-compose', validate({
  body: z.object({
    inboundText: z.string().min(1).max(12000),
    threadText: z.string().max(12000).optional(),
    contactName: z.string().max(120).optional(),
    channel: z.enum(['email', 'whatsapp', 'alibaba', 'trademanager', 'instagram', 'web', 'chat']).optional(),
    threadSubject: z.string().max(300).optional(),
    destination: z.string().max(160).optional(),
  }),
}), asyncHandler(async (req, res) => {
  const projectId = requireProjectId(req.user!);
  const [policies, config] = await Promise.all([
    ProjectPolicy.find({ projectId }).lean(),
    getProjectWorkbenchConfig(req.user!),
  ]);
  const composed = composeDeterministicKbReply({
    brandKey: config.brandKey,
    policies,
    redlines: config.guardrailRedlines,
    inboundText: req.body.inboundText,
    threadText: req.body.threadText,
    contactName: req.body.contactName,
    channel: req.body.channel ?? 'email',
    threadSubject: req.body.threadSubject,
    destination: req.body.destination,
  });
  sendSuccess(res, composed);
}));

router.get('/guardrails/selftest', asyncHandler(async (req, res) => {
  const projectId = requireProjectId(req.user!);
  const [policies, config] = await Promise.all([
    ProjectPolicy.find({ projectId }).lean(),
    getProjectWorkbenchConfig(req.user!),
  ]);
  sendSuccess(res, runGuardrailSelftest(policies, config.guardrailRedlines));
}));

/* -------------------- Customer Workbench Items (Open Questions / Commitments / Tasks) -------------------- */

const ownerRoleEnum = z.enum(['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management']);

router.get('/items', asyncHandler(async (req, res) => {
  sendSuccess(res, await listCustomerWorkbenchItems(req.user!, {
    customerId: typeof req.query.customerId === 'string' ? req.query.customerId : undefined,
    kind: typeof req.query.kind === 'string' ? req.query.kind as 'open_question' | 'commitment' | 'internal_task' : undefined,
    status: typeof req.query.status === 'string' ? req.query.status as 'open' | 'result_ready' | 'resolved' | 'dismissed' : undefined,
  }));
}));

router.post('/items', validate({
  body: z.object({
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/),
    kind: z.enum(['open_question', 'commitment', 'internal_task']),
    title: z.string().trim().min(1).max(500),
    quote: z.string().trim().max(1200).optional(),
    handling: z.enum(['ANSWERED', 'ASKED', 'CHECKING', 'NOTED', 'DECLINED']).optional(),
    grade: z.enum(['A', 'B', 'C']).optional(),
    ownerRole: ownerRoleEnum.optional(),
    dueAt: z.coerce.date().optional(),
    resultNote: z.string().trim().max(2000).optional(),
    sourceMailId: z.string().trim().max(128).optional(),
    sourceAnalysisId: z.string().trim().max(128).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await createCustomerWorkbenchItem(req.body, req.user!), 201);
}));

router.patch('/items/:id', validate({
  params: idParams,
  body: z.object({
    status: z.enum(['open', 'result_ready', 'resolved', 'dismissed']).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    ownerRole: ownerRoleEnum.optional(),
    dueAt: z.coerce.date().nullable().optional(),
    resultNote: z.string().trim().max(2000).optional(),
    grade: z.enum(['A', 'B', 'C']).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateCustomerWorkbenchItem(req.params.id, req.body, req.user!));
}));

router.delete('/items/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  await deleteCustomerWorkbenchItem(req.params.id, req.user!);
  sendSuccess(res, { deleted: true });
}));

router.post('/items/:id/draft-update', validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await draftUpdateForWorkbenchItem(req.params.id, req.user!));
}));

/* -------------------- Multi-Channel Inquiry Copilot / Rewrite / Learn / Knowledge QA -------------------- */

router.post('/draft-inquiry', validate({
  body: z.object({
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
    channel: z.enum(['email', 'whatsapp', 'alibaba', 'trademanager', 'instagram', 'web', 'chat']).optional(),
    subject: z.string().max(300).optional(),
    inboundText: z.string().trim().min(1).max(15000),
    threadText: z.string().max(15000).optional(),
    contactName: z.string().max(120).optional(),
    attachedOutFiles: z.array(z.string().max(200)).max(20).optional(),
    inboundAttachments: z.array(z.object({
      name: z.string().min(1).max(200),
      status: z.enum(['read', 'partial', 'binary', 'unread']),
      text: z.string().max(12000).optional(),
      note: z.string().max(300).optional(),
    })).max(12).optional(),
    instruction: z.string().max(1000).optional(),
    complaintLevel: z.enum(['', 'R1', 'R2', 'R3', 'R4']).optional(),
    destination: z.string().max(160).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await draftMultiChannelInquiry(req.body, req.user!));
}));

router.post('/rewrite', validate({
  body: z.object({
    subject: z.string().max(300).optional(),
    body: z.string().trim().min(1).max(20000),
    tone: z.enum(['concise', 'professional', 'friendly', 'formal']),
    instruction: z.string().max(1000).optional(),
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/).optional(),
    inboundText: z.string().max(12000).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await rewriteWorkbenchDraft(req.body, req.user!));
}));

router.post('/learn-from-edit', validate({
  body: z.object({
    inboundText: z.string().max(8000).default(''),
    aiDraft: z.string().trim().min(1).max(20000),
    finalSent: z.string().trim().min(1).max(20000),
    note: z.string().max(500).optional(),
    autoAdoptWritingRules: z.boolean().optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await learnFromFinalEdit(req.body, req.user!));
}));

router.post('/knowledge-qa', validate({
  body: z.object({ question: z.string().trim().min(1).max(1000) }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await answerKnowledgeQuestion(req.body.question, req.user!));
}));

router.post('/knowledge-import-markdown', requireRole('admin', 'project_admin'), validate({
  body: z.object({
    files: z.array(z.object({
      path: z.string().trim().min(1).max(300),
      content: z.string().max(120000),
    })).max(60).optional(),
    zipBase64: z.string().max(8 * 1024 * 1024).optional(),
    sourceLabel: z.string().trim().max(120).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await importMarkdownBundle(req.body, req.user!), 201);
}));

/* -------------------- Custom RFQ Costing Engine -------------------- */

const rfqLineSchema = z.object({
  product: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(80).optional(),
  material: z.string().trim().max(160).optional(),
  size: z.string().trim().max(120).optional(),
  qty: z.string().trim().max(120).default(''),
  logo: z.string().trim().max(160).optional(),
  color: z.string().trim().max(160).optional(),
  print: z.string().trim().max(160).optional(),
  closure: z.string().trim().max(120).optional(),
  insert: z.string().trim().max(160).optional(),
  packaging: z.string().trim().max(160).optional(),
  note: z.string().trim().max(500).optional(),
  approvedUnitPrice: z.number().min(0).optional(),
  approvedCurrency: z.enum(QUOTATION_CURRENCY).optional(),
  pricingStatus: z.enum(['pending', 'approved']).optional(),
});

router.get('/rfqs', asyncHandler(async (req, res) => {
  sendSuccess(res, await listRfqs(req.user!, typeof req.query.customerId === 'string' ? req.query.customerId : undefined));
}));

router.post('/rfqs/evaluate', validate({
  body: z.object({
    lines: z.array(rfqLineSchema).max(60),
    destination: z.string().max(160).optional(),
    incoterm: z.string().max(40).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, evaluateRfq(req.body.lines, req.body.destination, req.body.incoterm));
}));

router.post('/rfqs', validate({
  body: z.object({
    customerId: z.string().regex(/^[a-fA-F0-9]{24}$/),
    title: z.string().trim().min(1).max(200),
    destination: z.string().trim().max(160).optional(),
    incoterm: z.string().trim().max(40).optional(),
    channel: z.string().trim().max(40).optional(),
    lines: z.array(rfqLineSchema).min(1).max(60),
    notes: z.string().trim().max(2000).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await createRfq(req.body, req.user!), 201);
}));

router.put('/rfqs/:id', validate({
  params: idParams,
  body: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    destination: z.string().trim().max(160).optional(),
    incoterm: z.string().trim().max(40).optional(),
    channel: z.string().trim().max(40).optional(),
    lines: z.array(rfqLineSchema).min(1).max(60).optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await updateRfq(req.params.id, req.body, req.user!));
}));

router.delete('/rfqs/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  await deleteRfq(req.params.id, req.user!);
  sendSuccess(res, { deleted: true });
}));

router.get('/rfqs/:id/costing-xlsx', validate({ params: idParams }), asyncHandler(async (req, res) => {
  const { filename, buffer } = await exportRfqCostingXlsx(req.params.id, req.user!);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

router.post('/rfqs/:id/convert-quotation', validate({ params: idParams }), asyncHandler(async (req, res) => {
  sendSuccess(res, await convertRfqToQuotation(req.params.id, req.user!), 201);
}));

export default router;
