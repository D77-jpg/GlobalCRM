import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common';

const optionalDate = z.coerce.date().optional();
const optionalCountry = z.string().trim().min(2).max(80).optional();
const optionalAmount = z.coerce.number().min(0).optional();

export const customsSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  hsCode: z.string().trim().max(20).optional(),
  importerCountry: optionalCountry,
  exporterCountry: optionalCountry,
  importerName: z.string().trim().max(200).optional(),
  exporterName: z.string().trim().max(200).optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
  minAmountUsd: optionalAmount,
  maxAmountUsd: optionalAmount,
  port: z.string().trim().max(160).optional(),
  sourceId: objectIdSchema.optional(),
  sortBy: z.enum(['shipmentDate', 'amountUsd', 'importerName']).optional(),
});

export const customsCompanyQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  country: optionalCountry,
  companyType: z.enum(['importer', 'exporter', 'both', 'unknown']).optional(),
  minShipments: z.coerce.number().int().min(0).optional(),
  minAmountUsd: optionalAmount,
  sortBy: z.enum(['lastSeenAt', 'shipmentCount', 'totalAmountUsd']).optional(),
});

export const customsImportSchema = z.object({
  sourceId: objectIdSchema,
  rows: z.array(z.record(z.string(), z.unknown())).min(1, '没有可导入的数据').max(5000, '单次最多导入 5000 行'),
  dryRun: z.boolean().optional(),
});

export const customsConvertSchema = z.object({
  ownerId: objectIdSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const customsSourceSchema = z.object({
  name: z.string().trim().min(2).max(160),
  provider: z.string().trim().min(2).max(100),
  kind: z.enum(['api', 'csv', 'object_storage']).default('csv'),
  coverageCountries: z.array(z.string().trim().min(2).max(80)).max(100).default([]),
  credentials: z.record(z.string(), z.unknown()).optional(),
});
