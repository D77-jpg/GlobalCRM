import { createHash } from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import { ApiError } from '../utils/ApiError';
import { countryCode } from '../utils/country';
import { encryptCredential } from './credential-crypto';
import {
  CustomsCompany,
  CustomsMatch,
  CustomsShipment,
  CustomsSource,
  type ICustomsCompany,
  type ICustomsShipment,
} from '../models/Customs';

const MAX_IMPORT_ROWS = 5000;
const LEGAL_SUFFIXES = /\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|sarl|sas|srl|spa|bv|nv|plc|llp|oy|ab|as|ag|kg|ug|pte|pty|imports?|exports?|trading|group|holdings?)\b\.?/gi;


export interface CustomsImportRow {
  sourceRecordId?: string;
  importerName: string;
  exporterName?: string;
  importerCountry: string;
  exporterCountry?: string;
  hsCode?: string;
  productDescription?: string;
  quantity?: number;
  quantityUnit?: string;
  weightKg?: number;
  amount?: number;
  currency?: string;
  amountUsd?: number;
  shipmentDate: string | Date;
  arrivalDate?: string | Date;
  portOfLoading?: string;
  portOfDischarge?: string;
  transportMode?: string;
  billOfLading?: string;
  dataDate?: string | Date;
  raw?: Record<string, unknown>;
}

export interface CustomsImportResult {
  read: number;
  written: number;
  skipped: number;
  errors: Array<{ index: number; message: string }>;
}

export interface CustomsSourceInput {
  name: string;
  provider: string;
  kind: 'api' | 'csv' | 'object_storage';
  coverageCountries: string[];
  credentials?: Record<string, unknown>;
}

function sourceDto(source: Record<string, unknown>) {
  return {
    id: String(source._id),
    name: source.name,
    provider: source.provider,
    kind: source.kind,
    status: source.status,
    coverageCountries: source.coverageCountries ?? [],
    lastSyncAt: source.lastSyncAt ?? null,
    lastSuccessAt: source.lastSuccessAt ?? null,
    lastError: source.lastError ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export async function listCustomsSources(projectId: Types.ObjectId) {
  const rows = await CustomsSource.find({ projectId }).sort({ createdAt: -1 }).lean();
  return rows.map((row) => sourceDto(row as unknown as Record<string, unknown>));
}

export async function createCustomsSource(
  projectId: Types.ObjectId,
  createdBy: Types.ObjectId,
  input: CustomsSourceInput,
) {
  const existing = await CustomsSource.findOne({ projectId, provider: input.provider });
  if (existing) throw ApiError.conflict('当前项目已经配置了该数据源');
  const credentials = input.credentials
    ? JSON.stringify(encryptCredential(JSON.stringify(input.credentials)))
    : undefined;
  const source = await CustomsSource.create({
    projectId,
    name: input.name,
    provider: input.provider,
    kind: input.kind,
    status: 'active',
    coverageCountries: input.coverageCountries
      .map((country) => normalizeCountry(country))
      .filter((country): country is string => Boolean(country)),
    credentialsEncrypted: credentials,
    createdBy,
  });
  return sourceDto(source.toObject() as unknown as Record<string, unknown>);
}

export interface CustomsSearchFilters {
  q?: string;
  hsCode?: string;
  importerCountry?: string;
  exporterCountry?: string;
  importerName?: string;
  exporterName?: string;
  dateFrom?: Date;
  dateTo?: Date;
  minAmountUsd?: number;
  maxAmountUsd?: number;
  port?: string;
  sourceId?: string;
  page: number;
  limit: number;
  sortBy?: 'shipmentDate' | 'amountUsd' | 'importerName';
  sortOrder?: 'asc' | 'desc';
}

export interface CustomsCompanyFilters {
  q?: string;
  country?: string;
  companyType?: 'importer' | 'exporter' | 'both' | 'unknown';
  minShipments?: number;
  minAmountUsd?: number;
  page: number;
  limit: number;
  sortBy?: 'lastSeenAt' | 'shipmentCount' | 'totalAmountUsd';
  sortOrder?: 'asc' | 'desc';
}

export function normalizeCompanyName(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeHsCode(value?: string): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : digits || undefined;
}

export function normalizeCountry(value?: string): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const code = countryCode(raw);
  if (code) return code.toUpperCase();
  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase();
  return undefined;
}

function toDate(value: string | Date | undefined, field: string): Date {
  if (!value) throw new Error(`缺少 ${field}`);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} 不是有效日期`);
  return date;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function fingerprintOf(importer: string, exporter: string, hsCode: string | undefined, date: Date, amount: number | undefined): string {
  return createHash('sha256')
    .update([importer, exporter, hsCode ?? '', date.toISOString().slice(0, 10), amount ?? ''].join('|'))
    .digest('hex');
}

async function upsertCompany(
  projectId: Types.ObjectId,
  sourceId: Types.ObjectId,
  name: string,
  country: string,
  companyType: 'importer' | 'exporter',
  date: Date,
  amountUsd: number | undefined,
): Promise<ICustomsCompany & { _id: Types.ObjectId }> {
  const canonicalName = name.trim();
  const normalizedName = normalizeCompanyName(canonicalName);
  if (!normalizedName) throw new Error('公司名称标准化后为空');
  const company = await CustomsCompany.findOneAndUpdate(
    { projectId, normalizedName, country },
    {
      $setOnInsert: {
        projectId,
        canonicalName,
        normalizedName,
        country,
        companyType,
        firstSeenAt: date,
        status: 'active',
      },
      $set: { lastSeenAt: date },
      $addToSet: { aliases: canonicalName, sourceIds: sourceId },
      $inc: { shipmentCount: 1, totalAmountUsd: amountUsd ?? 0 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  if (!company) throw new Error('公司记录保存失败');
  return company as ICustomsCompany & { _id: Types.ObjectId };
}

export async function importCustomsRows(
  projectId: Types.ObjectId,
  sourceId: string,
  rows: CustomsImportRow[],
  options: { dryRun?: boolean } = {},
): Promise<CustomsImportResult> {
  if (!Types.ObjectId.isValid(sourceId)) throw ApiError.badRequest('数据源 ID 无效');
  if (!Array.isArray(rows) || rows.length === 0) throw ApiError.badRequest('没有可导入的数据');
  if (rows.length > MAX_IMPORT_ROWS) throw ApiError.badRequest(`单次最多导入 ${MAX_IMPORT_ROWS} 行`);
  const source = await CustomsSource.findOne({ _id: sourceId, projectId });
  if (!source) throw ApiError.notFound('数据源不存在或不属于当前项目');
  if (source.status !== 'active') throw ApiError.conflict('数据源未启用');

  const result: CustomsImportResult = { read: rows.length, written: 0, skipped: 0, errors: [] };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      if (!hasValue(row.importerName)) throw new Error('缺少进口商名称');
      if (!hasValue(row.importerCountry)) throw new Error('缺少进口国');
      const importerCountry = normalizeCountry(row.importerCountry);
      if (!importerCountry) throw new Error('进口国必须是 ISO 两位码或已支持的国家名');
      const shipmentDate = toDate(row.shipmentDate, 'shipmentDate');
      const exporterCountry = normalizeCountry(row.exporterCountry);
      const amountUsd = row.amountUsd !== undefined ? Number(row.amountUsd) : undefined;
      const amount = row.amount !== undefined ? Number(row.amount) : undefined;
      const fingerprint = fingerprintOf(
        normalizeCompanyName(row.importerName),
        normalizeCompanyName(row.exporterName ?? ''),
        normalizeHsCode(row.hsCode),
        shipmentDate,
        amountUsd ?? amount,
      );
      const sourceRecordId = row.sourceRecordId?.trim() || fingerprint;
      const existing = await CustomsShipment.findOne({ projectId, sourceId, sourceRecordId }).lean();
      if (existing) {
        result.skipped += 1;
        continue;
      }
      if (options.dryRun) {
        result.written += 1;
        continue;
      }
      const importer = await upsertCompany(projectId, new Types.ObjectId(sourceId), row.importerName, importerCountry, 'importer', shipmentDate, amountUsd);
      const exporter = hasValue(row.exporterName) && exporterCountry
        ? await upsertCompany(projectId, new Types.ObjectId(sourceId), String(row.exporterName), exporterCountry, 'exporter', shipmentDate, amountUsd)
        : undefined;
      await CustomsShipment.create({
        projectId,
        sourceId: new Types.ObjectId(sourceId),
        sourceRecordId,
        importerCompanyId: importer._id,
        exporterCompanyId: exporter?._id,
        importerNameRaw: row.importerName.trim(),
        exporterNameRaw: row.exporterName?.trim(),
        importerCountry,
        exporterCountry,
        hsCode: normalizeHsCode(row.hsCode),
        hsCodeRaw: row.hsCode?.trim(),
        productDescription: row.productDescription?.trim(),
        quantity: row.quantity,
        quantityUnit: row.quantityUnit?.trim(),
        weightKg: row.weightKg,
        amount,
        currency: row.currency?.trim().toUpperCase(),
        amountUsd,
        shipmentDate,
        arrivalDate: row.arrivalDate ? toDate(row.arrivalDate, 'arrivalDate') : undefined,
        portOfLoading: row.portOfLoading?.trim(),
        portOfDischarge: row.portOfDischarge?.trim(),
        transportMode: row.transportMode?.trim(),
        billOfLading: row.billOfLading?.trim(),
        dataDate: row.dataDate ? toDate(row.dataDate, 'dataDate') : undefined,
        raw: row.raw,
        fingerprint,
      });
      result.written += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : '导入失败';
      if (result.errors.length < 50) result.errors.push({ index, message });
    }
  }
  if (!options.dryRun && result.written > 0) {
    await CustomsSource.updateOne(
      { _id: sourceId, projectId },
      { $set: { lastSyncAt: new Date(), lastSuccessAt: new Date(), lastError: null } },
    );
  }
  return result;
}

function regex(value: string): RegExp {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export async function searchCustomsShipments(projectId: Types.ObjectId, filters: CustomsSearchFilters) {
  const query: FilterQuery<ICustomsShipment> = { projectId };
  if (filters.q) {
    const pattern = regex(filters.q);
    query.$or = [
      { importerNameRaw: pattern },
      { exporterNameRaw: pattern },
      { productDescription: pattern },
      { billOfLading: pattern },
    ];
  }
  if (filters.hsCode) query.hsCode = normalizeHsCode(filters.hsCode);
  if (filters.importerCountry) query.importerCountry = normalizeCountry(filters.importerCountry);
  if (filters.exporterCountry) query.exporterCountry = normalizeCountry(filters.exporterCountry);
  if (filters.importerName) query.importerNameRaw = regex(filters.importerName);
  if (filters.exporterName) query.exporterNameRaw = regex(filters.exporterName);
  if (filters.dateFrom || filters.dateTo) {
    query.shipmentDate = {};
    if (filters.dateFrom) query.shipmentDate.$gte = filters.dateFrom;
    if (filters.dateTo) query.shipmentDate.$lte = filters.dateTo;
  }
  if (filters.minAmountUsd !== undefined || filters.maxAmountUsd !== undefined) {
    query.amountUsd = {};
    if (filters.minAmountUsd !== undefined) query.amountUsd.$gte = filters.minAmountUsd;
    if (filters.maxAmountUsd !== undefined) query.amountUsd.$lte = filters.maxAmountUsd;
  }
  if (filters.port) {
    const pattern = regex(filters.port);
    query.$and = [{ $or: [{ portOfLoading: pattern }, { portOfDischarge: pattern }] }];
  }
  if (filters.sourceId) query.sourceId = new Types.ObjectId(filters.sourceId);
  const sortBy = filters.sortBy === 'amountUsd' ? 'amountUsd' : filters.sortBy === 'importerName' ? 'importerNameRaw' : 'shipmentDate';
  const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;
  const [items, total] = await Promise.all([
    CustomsShipment.find(query)
      .populate('importerCompanyId', 'canonicalName country domain')
      .populate('exporterCompanyId', 'canonicalName country domain')
      .sort({ [sortBy]: sortOrder })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .lean(),
    CustomsShipment.countDocuments(query),
  ]);
  return { items, total, page: filters.page, limit: filters.limit };
}

export async function listCustomsCompanies(projectId: Types.ObjectId, filters: CustomsCompanyFilters) {
  const query: FilterQuery<ICustomsCompany> = { projectId, status: 'active' };
  if (filters.q) {
    const pattern = regex(filters.q);
    query.$or = [{ canonicalName: pattern }, { normalizedName: pattern }, { domain: pattern }];
  }
  if (filters.country) query.country = normalizeCountry(filters.country);
  if (filters.companyType) query.companyType = filters.companyType;
  if (filters.minShipments !== undefined) query.shipmentCount = { $gte: filters.minShipments };
  if (filters.minAmountUsd !== undefined) query.totalAmountUsd = { $gte: filters.minAmountUsd };
  const sortBy = filters.sortBy === 'shipmentCount' ? 'shipmentCount' : filters.sortBy === 'totalAmountUsd' ? 'totalAmountUsd' : 'lastSeenAt';
  const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;
  const [items, total] = await Promise.all([
    CustomsCompany.find(query).sort({ [sortBy]: sortOrder }).skip((filters.page - 1) * filters.limit).limit(filters.limit).lean(),
    CustomsCompany.countDocuments(query),
  ]);
  return { items, total, page: filters.page, limit: filters.limit };
}

export async function getCustomsCompany(projectId: Types.ObjectId, companyId: string) {
  if (!Types.ObjectId.isValid(companyId)) throw ApiError.badRequest('公司 ID 无效');
  const company = await CustomsCompany.findOne({ _id: companyId, projectId }).lean();
  if (!company) throw ApiError.notFound('海关公司不存在');
  const [recentShipments, topSuppliers, match] = await Promise.all([
    CustomsShipment.find({ projectId, importerCompanyId: company._id })
      .sort({ shipmentDate: -1 }).limit(30)
      .populate('exporterCompanyId', 'canonicalName country domain')
      .lean(),
    CustomsShipment.aggregate([
      { $match: { projectId, importerCompanyId: company._id, exporterCompanyId: { $ne: null } } },
      { $group: { _id: '$exporterCompanyId', shipments: { $sum: 1 }, amountUsd: { $sum: '$amountUsd' } } },
      { $sort: { amountUsd: -1, shipments: -1 } },
      { $limit: 10 },
    ]),
    CustomsMatch.findOne({ projectId, companyId: company._id, status: 'confirmed' }).lean(),
  ]);
  const supplierIds = topSuppliers.map((row) => row._id).filter(Boolean);
  const suppliers = await CustomsCompany.find({ _id: { $in: supplierIds }, projectId }).select('canonicalName country domain').lean();
  const supplierMap = new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));
  return {
    company,
    summary: {
      shipmentCount: company.shipmentCount,
      totalAmountUsd: company.totalAmountUsd,
      firstSeenAt: company.firstSeenAt ?? null,
      lastSeenAt: company.lastSeenAt ?? null,
    },
    recentShipments,
    topSuppliers: topSuppliers.map((row) => ({ ...row, company: supplierMap.get(String(row._id)) ?? null })),
    match: match ?? null,
  };
}
