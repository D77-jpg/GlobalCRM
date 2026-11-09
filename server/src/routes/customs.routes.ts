import { Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { idParamsSchema } from '../validators/common';
import {
  customsCompanyQuerySchema,
  customsConvertSchema,
  customsImportSchema,
  customsSearchQuerySchema,
  customsSourceSchema,
} from '../validators/customs.validator';
import {
  companiesHandler,
  companyHandler,
  convertHandler,
  createSourceHandler,
  customerTradeHandler,
  importHandler,
  searchHandler,
  sourcesHandler,
} from '../controllers/customs.controller';

const router = Router();

router.get('/search', validate({ query: customsSearchQuerySchema }), searchHandler);
router.get('/companies', validate({ query: customsCompanyQuerySchema }), companiesHandler);
router.get('/companies/:id', validate({ params: idParamsSchema }), companyHandler);
router.post('/companies/:id/convert', validate({ params: idParamsSchema, body: customsConvertSchema }), convertHandler);
router.get('/customers/:id/trade', validate({ params: idParamsSchema }), customerTradeHandler);
router.get('/sources', requireRole('admin'), sourcesHandler);
router.post('/sources', requireRole('admin'), validate({ body: customsSourceSchema }), createSourceHandler);
router.post('/import', requireRole('admin'), validate({ body: customsImportSchema }), importHandler);

export default router;
