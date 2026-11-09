import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { requireProjectId } from '../utils/access';
import { sendSuccess } from '../utils/pagination';
import {
  convertCustomsCompanyToProspect,
  createCustomsSource,
  getCustomerCustomsTrade,
  getCustomsCompany,
  importCustomsRows,
  listCustomsCompanies,
  listCustomsSources,
  searchCustomsShipments,
  type CustomsCompanyFilters,
  type CustomsImportRow,
  type CustomsSearchFilters,
  type CustomsSourceInput,
} from '../services/customs.service';

export const searchHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const query = req.query as unknown as CustomsSearchFilters;
  const result = await searchCustomsShipments(projectId, query);
  sendSuccess(res, result);
});

export const companiesHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const query = req.query as unknown as CustomsCompanyFilters;
  sendSuccess(res, await listCustomsCompanies(projectId, query));
});

export const companyHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await getCustomsCompany(projectId, req.params.id));
});

export const convertHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const body = req.body as { ownerId?: string; notes?: string };
  sendSuccess(res, await convertCustomsCompanyToProspect(projectId, new Types.ObjectId(req.user!.id), req.params.id, body), 201);
});

export const customerTradeHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await getCustomerCustomsTrade(projectId, req.params.id));
});

export const sourcesHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await listCustomsSources(projectId));
});

export const createSourceHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const body = req.body as CustomsSourceInput;
  sendSuccess(res, await createCustomsSource(projectId, new Types.ObjectId(req.user!.id), body), 201);
});

export const importHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const body = req.body as { sourceId: string; rows: CustomsImportRow[]; dryRun?: boolean };
  sendSuccess(res, await importCustomsRows(projectId, body.sourceId, body.rows, { dryRun: body.dryRun }));
});
