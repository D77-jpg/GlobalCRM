import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { requireProjectId } from '../utils/access';
import { sendSuccess } from '../utils/pagination';
import type { CustomsAlertStatus } from '../models/Customs';
import {
  convertCustomsCompanyToProspect,
  createCustomsSource,
  getCustomerCustomsTrade,
  getCustomsCompany,
  getCustomsUsage,
  importCustomsRows,
  listCustomsAlerts,
  listCustomsCompanies,
  listCustomsSources,
  listCustomsWatchlists,
  recordCustomsUsage,
  scoreCustomsCompany,
  searchCustomsShipments,
  unwatchCustomsCompany,
  unwatchCustomsCustomer,
  updateCustomsAlert,
  watchCustomsCompany,
  watchCustomsCustomer,
  type CustomsCompanyFilters,
  type CustomsImportRow,
  type CustomsSearchFilters,
  type CustomsSourceInput,
} from '../services/customs.service';

export const searchHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const query = req.query as unknown as CustomsSearchFilters;
  const result = await searchCustomsShipments(projectId, query);
  await recordCustomsUsage(projectId, 'search', 1, new Types.ObjectId(req.user!.id), { hsCode: query.hsCode ?? null });
  sendSuccess(res, result);
});

export const companiesHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const query = req.query as unknown as CustomsCompanyFilters;
  sendSuccess(res, await listCustomsCompanies(projectId, query));
});

export const companyHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const result = await getCustomsCompany(projectId, req.params.id);
  await recordCustomsUsage(projectId, 'company_view', 1, new Types.ObjectId(req.user!.id));
  sendSuccess(res, result);
});

export const scoreHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await scoreCustomsCompany(projectId, req.params.id));
});

export const watchCompanyHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await watchCustomsCompany(projectId, new Types.ObjectId(req.user!.id), req.params.id));
});

export const unwatchCompanyHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await unwatchCustomsCompany(projectId, req.params.id));
});

export const watchCustomerHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await watchCustomsCustomer(projectId, new Types.ObjectId(req.user!.id), req.params.id));
});

export const unwatchCustomerHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await unwatchCustomsCustomer(projectId, req.params.id));
});

export const watchlistsHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await listCustomsWatchlists(projectId));
});

export const alertsHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const query = req.query as unknown as { status?: CustomsAlertStatus; type?: string; customerId?: string; page: number; limit: number };
  sendSuccess(res, await listCustomsAlerts(projectId, query));
});

export const updateAlertHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  const body = req.body as { status: CustomsAlertStatus };
  sendSuccess(res, await updateCustomsAlert(projectId, req.params.id, body.status));
});

export const usageHandler = asyncHandler(async (req: Request, res: Response) => {
  const projectId = requireProjectId(req.user!);
  sendSuccess(res, await getCustomsUsage(projectId));
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
  const result = await importCustomsRows(projectId, body.sourceId, body.rows, { dryRun: body.dryRun });
  if (!body.dryRun) await recordCustomsUsage(projectId, 'record_ingested', result.written, new Types.ObjectId(req.user!.id), { sourceId: body.sourceId });
  sendSuccess(res, result);
});
