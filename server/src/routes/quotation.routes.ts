/**
 * 报价单路由（顶层）
 * ------------------------------------------------------------------
 * 客户详情页的报价单走嵌套路由 /customers/:id/quotations（见 customer.routes）；
 * 这里提供跨客户的列表 / 详情 / 新建，用于「按状态查询、按客户筛选」等场景。
 */
import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/auth.middleware';
import { z } from 'zod';
import {
  createQuotationSchema,
  idParamsSchema,
  listQuotationsQuerySchema,
  reviewQuotationApprovalSchema,
} from '../validators/quotation.validator';
import {
  createQuotationHandler,
  downloadQuotationPdfHandler,
  getQuotationHandler,
  getQuotationSummaryHandler,
  listProductHistoricalQuotesHandler,
  listQuotationsHandler,
  reviewQuotationApprovalHandler,
  submitQuotationApprovalHandler,
} from '../controllers/quotation.controller';

const router = Router();

router.use(requireAuth);

/* ---------- 集合级操作 ---------- */
router.get('/', validate({ query: listQuotationsQuerySchema }), listQuotationsHandler);
router.get('/summary', getQuotationSummaryHandler);
router.get('/history-by-product', listProductHistoricalQuotesHandler);
router.post('/', validate({ body: createQuotationSchema }), createQuotationHandler);

/* ---------- 单条操作 ---------- */
router.get('/:id', validate({ params: idParamsSchema }), getQuotationHandler);
router.get('/:id/pdf', validate({ params: idParamsSchema }), downloadQuotationPdfHandler);
router.post('/:id/submit-approval', validate({ params: idParamsSchema, body: z.object({ note: z.string().trim().max(500).optional() }).default({}) }), submitQuotationApprovalHandler);
router.post('/:id/review-approval', validate({ params: idParamsSchema, body: reviewQuotationApprovalSchema }), reviewQuotationApprovalHandler);

export default router;
