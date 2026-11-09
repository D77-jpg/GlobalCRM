import { Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { idParamsSchema } from '../validators/common';
import {
  customsAlertQuerySchema,
  customsAlertUpdateSchema,
  customsCompanyQuerySchema,
  customsConvertSchema,
  customsImportSchema,
  customsSearchQuerySchema,
  customsSourceSchema,
} from '../validators/customs.validator';
import {
  alertsHandler,
  companiesHandler,
  companyHandler,
  convertHandler,
  createSourceHandler,
  attributionHandler,
  customerSuggestionsHandler,
  customerTradeHandler,
  importHandler,
  scoreHandler,
  searchHandler,
  sourcesHandler,
  testSourceHandler,
  unwatchCompanyHandler,
  unwatchCustomerHandler,
  updateAlertHandler,
  usageHandler,
  watchCompanyHandler,
  watchCustomerHandler,
  watchlistsHandler,
} from '../controllers/customs.controller';

const router = Router();

router.get('/search', validate({ query: customsSearchQuerySchema }), searchHandler);
router.get('/companies', validate({ query: customsCompanyQuerySchema }), companiesHandler);
router.get('/companies/:id', validate({ params: idParamsSchema }), companyHandler);
router.get('/companies/:id/score', validate({ params: idParamsSchema }), scoreHandler);
router.post('/companies/:id/convert', validate({ params: idParamsSchema, body: customsConvertSchema }), convertHandler);
router.post('/companies/:id/watch', validate({ params: idParamsSchema }), watchCompanyHandler);
router.delete('/companies/:id/watch', validate({ params: idParamsSchema }), unwatchCompanyHandler);
router.get('/customers/:id/trade', validate({ params: idParamsSchema }), customerTradeHandler);
router.get('/customers/:id/suggestions', validate({ params: idParamsSchema }), customerSuggestionsHandler);
router.post('/customers/:id/watch', validate({ params: idParamsSchema }), watchCustomerHandler);
router.delete('/customers/:id/watch', validate({ params: idParamsSchema }), unwatchCustomerHandler);
router.get('/watchlists', watchlistsHandler);
router.get('/alerts', validate({ query: customsAlertQuerySchema }), alertsHandler);
router.patch('/alerts/:id', validate({ params: idParamsSchema, body: customsAlertUpdateSchema }), updateAlertHandler);
router.get('/usage', requireRole('admin'), usageHandler);
router.get('/attribution', requireRole('admin'), attributionHandler);
router.get('/sources', requireRole('admin'), sourcesHandler);
router.post('/sources', requireRole('admin'), validate({ body: customsSourceSchema }), createSourceHandler);
router.post('/sources/:id/test', requireRole('admin'), validate({ params: idParamsSchema }), testSourceHandler);
router.post('/import', requireRole('admin'), validate({ body: customsImportSchema }), importHandler);

export default router;
