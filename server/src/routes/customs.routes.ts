import { Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { idParamsSchema } from '../validators/common';
import {
  customsCompanyQuerySchema,
  customsImportSchema,
  customsSearchQuerySchema,
  customsSourceSchema,
} from '../validators/customs.validator';
import {
  companiesHandler,
  companyHandler,
  createSourceHandler,
  importHandler,
  searchHandler,
  sourcesHandler,
} from '../controllers/customs.controller';

const router = Router();

router.get('/search', validate({ query: customsSearchQuerySchema }), searchHandler);
router.get('/companies', validate({ query: customsCompanyQuerySchema }), companiesHandler);
router.get('/companies/:id', validate({ params: idParamsSchema }), companyHandler);
router.get('/sources', requireRole('admin'), sourcesHandler);
router.post('/sources', requireRole('admin'), validate({ body: customsSourceSchema }), createSourceHandler);
router.post('/import', requireRole('admin'), validate({ body: customsImportSchema }), importHandler);

export default router;
