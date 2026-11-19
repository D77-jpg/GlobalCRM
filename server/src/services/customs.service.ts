import { createHash } from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import { ApiError } from '../utils/ApiError';
import { countryCode } from '../utils/country';
import { domainFromAddress } from '../utils/domain';
import { Customer, Quotation } from '../models';
import { Prospect } from '../models/Prospect';
import { encryptCredential } from './credential-crypto';
import { resolveAgentProvider } from './agent/ai-settings.service';
import { resolveCustomsProviderAdapter } from './customs/providers';
import {
  CustomsAlert,
  CustomsCompany,
  CustomsMatch,
  CustomsScore,
  CustomsShipment,
  CustomsSource,
  CustomsUsage,
  CustomsWatch,
  type ICustomsCompany,
  type ICustomsShipment,
  type CustomsAlertStatus,
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

export async function testCustomsSource(projectId: Types.ObjectId, sourceId: string) {
  if (!Types.ObjectId.isValid(sourceId)) throw ApiError.badRequest('数据源 ID 无效');
  const source = await CustomsSource.findOne({ _id: sourceId, projectId }).lean();
  if (!source) throw ApiError.notFound('数据源不存在');
  const adapter = resolveCustomsProviderAdapter(source);
  const result = await adapter.test(source);
  return { sourceId, provider: source.provider, kind: source.kind, adapter: adapter.key, ...result };
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
      const shipment = await CustomsShipment.create({
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
      await createAlertsForShipment(projectId, shipment);
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

export interface CustomsConvertInput {
  ownerId?: string;
  notes?: string;
}

/** 把海关公司加入现有潜客池。重复转换返回原潜客，不重复建线索。 */
export async function convertCustomsCompanyToProspect(
  projectId: Types.ObjectId,
  actorId: Types.ObjectId,
  companyId: string,
  input: CustomsConvertInput = {},
) {
  if (!Types.ObjectId.isValid(companyId)) throw ApiError.badRequest('公司 ID 无效');
  const company = await CustomsCompany.findOne({ _id: companyId, projectId, status: 'active' }).lean();
  if (!company) throw ApiError.notFound('海关公司不存在');
  const ownerId = input.ownerId && Types.ObjectId.isValid(input.ownerId) ? new Types.ObjectId(input.ownerId) : actorId;
  const domain = company.domain?.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const existing = await Prospect.findOne({
    projectId,
    $or: [
      { customsCompanyId: company._id },
      ...(domain ? [{ domain }] : []),
    ],
  }).lean();
  if (existing) return { prospect: existing, created: false };

  const customer = await Customer.findOne({
    projectId,
    $or: [
      { customsCompanyId: company._id },
      ...(domain ? [{ website: new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] : []),
    ],
  }).lean();
  if (customer) throw ApiError.conflict('该海关公司已经关联现有客户，请先在客户详情中确认匹配');

  const scoreReasons = [
    `${company.shipmentCount} 票海关记录`,
    `累计金额 ${Math.round(company.totalAmountUsd).toLocaleString('en-US')} USD`,
  ];
  if (company.lastSeenAt) scoreReasons.push(`最近记录 ${company.lastSeenAt.toISOString().slice(0, 10)}`);
  const prospect = await Prospect.create({
    projectId,
    day: new Date().toISOString().slice(0, 10),
    domain: domain || `customs-${String(company._id)}.local`,
    website: domain ? `https://${domain}` : '',
    name: company.canonicalName.slice(0, 200),
    company: company.canonicalName.slice(0, 200),
    country: company.country,
    address: company.address,
    sourceUrl: '',
    source: 'customs',
    customsCompanyId: company._id,
    ownerId,
    notes: input.notes?.trim() || `来自海关数据：${company.canonicalName}`,
    score: Math.min(100, Math.round(Math.log10(company.totalAmountUsd + 1) * 12 + Math.min(company.shipmentCount, 20))),
    scoreReasons,
    status: 'ready',
    emails: [],
    convertedBy: undefined,
  });
  return { prospect: prospect.toObject(), created: true };
}

/** 客户详情的贸易动态。优先使用已确认的海关公司，否则按域名和公司名给出建议匹配。 */
export async function getCustomerCustomsTrade(projectId: Types.ObjectId, customerId: string) {
  if (!Types.ObjectId.isValid(customerId)) throw ApiError.badRequest('客户 ID 无效');
  const customer = await Customer.findOne({ _id: customerId, projectId }).lean();
  if (!customer) throw ApiError.notFound('客户不存在');
  const domain = domainFromAddress(customer.website || customer.email || '');
  const normalizedName = normalizeCompanyName(customer.company || customer.name);
  const country = normalizeCountry(customer.country);
  let company = customer.customsCompanyId
    ? await CustomsCompany.findOne({ _id: customer.customsCompanyId, projectId }).lean()
    : null;
  if (!company && (domain || normalizedName)) {
    company = await CustomsCompany.findOne({
      projectId,
      $or: [
        ...(domain ? [{ domain }] : []),
        ...(normalizedName && country ? [{ normalizedName, country }] : []),
      ],
    }).lean();
  }
  if (!company) {
    return {
      matched: false,
      customer: { id: String(customer._id), name: customer.name, company: customer.company ?? null },
      company: null,
      summary: null,
      recentShipments: [],
      topSuppliers: [],
      match: null,
    };
  }
  const detail = await getCustomsCompany(projectId, String(company._id));
  const watch = await CustomsWatch.findOne({ projectId, customerId: customer._id, enabled: true }).lean();
  return { matched: true, customer: { id: String(customer._id), name: customer.name, company: customer.company ?? null }, watch: watch ?? null, ...detail };
}

export interface CustomerCustomsEvidence {
  matched: boolean;
  companyId?: string;
  companyName?: string;
  matchMethod?: 'explicit_id' | 'domain' | 'name_country';
  confidence: 'high' | 'medium' | 'low';
  stale: boolean;
  latestShipmentAt?: Date;
  sourceName?: string;
  signals: {
    purchaseScale: 'high' | 'medium' | 'small';
    shipmentCount: number;
    totalWeightKg: number;
    totalValueUsd: number;
    importedCategories: string[];
    importedMaterials: string[];
    seasonalPeakMonths: number[];
    upcomingRestockWindow: boolean;
    supplierConcentration: 'single_source' | 'concentrated' | 'diversified';
    topSupplierShare: number;
    supplierCount: number;
  };
  summaryText: string;
}

const CUSTOMS_MATERIAL_PATTERNS: [string, RegExp][] = [
  ['velvet / microfiber / textile', /\b(?:velvet|microfiber|suede|cotton|linen|silk|fabric|textile|pouch)\b/i],
  ['paperboard / rigid box / kraft', /\b(?:paperboard|cardboard|kraft|rigid box|gift box|carton|paper bag|packaging)\b/i],
  ['leather / PU', /\b(?:leather|pu leather|faux leather|handbag|wallet)\b/i],
  ['cast iron / steel / urethane / rubber', /\b(?:cast iron|steel|urethane|rubber|dumbbell|barbell|kettlebell|weight plate|fitness)\b/i],
  ['canvas / acrylic / oil / wood frame', /\b(?:canvas|acrylic|oil painting|wall art|artwork|picture frame|wood frame)\b/i],
  ['glass / ceramic / wax', /\b(?:glass|ceramic|wax|candle|bottle|jar)\b/i],
  ['gold / silver / jewelry', /\b(?:jewelry|jewellery|silver|gold|ring|necklace|bracelet|watch)\b/i],
];

/**
 * 为开发信与切入点选择生成可核验的海关采购情报：
 * 1. 核验客户匹配方式（已确认ID / 域名 / 名称+国家）
 * 2. 核验来源时效（超过 365 天标记 stale，不参与高置信切入）与可信度
 * 3. 输出四类采购信号：采购规模、进口品类与材质、季节性补货、供应商集中度
 */
export async function getCustomerCustomsEvidence(
  projectId: Types.ObjectId,
  customerId: string,
  now = new Date(),
): Promise<CustomerCustomsEvidence | null> {
  if (!Types.ObjectId.isValid(customerId)) return null;
  const customer = await Customer.findOne({ _id: customerId, projectId }).select('name company website email country customsCompanyId customsMatchConfidence').lean();
  if (!customer) return null;

  let company = null;
  let matchMethod: CustomerCustomsEvidence['matchMethod'];
  if (customer.customsCompanyId) {
    company = await CustomsCompany.findOne({ _id: customer.customsCompanyId, projectId }).lean();
    if (company) matchMethod = 'explicit_id';
  }
  if (!company) {
    const domain = domainFromAddress(customer.website || customer.email || '');
    if (domain) {
      company = await CustomsCompany.findOne({ projectId, domain }).lean();
      if (company) matchMethod = 'domain';
    }
  }
  if (!company) {
    const normalizedName = normalizeCompanyName(customer.company || customer.name);
    const country = normalizeCountry(customer.country);
    if (normalizedName && country) {
      company = await CustomsCompany.findOne({ projectId, normalizedName, country }).lean();
      if (company) matchMethod = 'name_country';
    }
  }
  if (!company || !matchMethod) return null;

  const shipments = await CustomsShipment.find({
    projectId,
    $or: [{ importerCompanyId: company._id }, { exporterCompanyId: company._id }],
  })
    .sort({ shipmentDate: -1 })
    .limit(200)
    .select('shipmentDate hsCode productDescription weightKg amountUsd exporterNameRaw exporterCompanyId sourceId')
    .lean();

  if (!shipments.length) return null;

  const latestShipmentAt = shipments[0]?.shipmentDate ? new Date(shipments[0].shipmentDate) : undefined;
  const ageDays = latestShipmentAt ? (now.getTime() - latestShipmentAt.getTime()) / 86_400_000 : 9999;
  const stale = ageDays > 365;

  const sourceId = shipments[0]?.sourceId;
  const source = sourceId ? await CustomsSource.findById(sourceId).select('name status').lean() : null;
  const sourceVerified = Boolean(source && source.status !== 'disabled');

  // Credibility check
  const confidence: CustomerCustomsEvidence['confidence'] =
    stale || !sourceVerified
      ? 'low'
      : matchMethod === 'explicit_id' || (matchMethod === 'domain' && shipments.length >= 2)
        ? 'high'
        : shipments.length >= 2
          ? 'medium'
          : 'low';

  // 1. Purchase scale
  const shipmentCount = shipments.length;
  const totalWeightKg = shipments.reduce((sum, s) => sum + (Number(s.weightKg) || 0), 0);
  const totalValueUsd = shipments.reduce((sum, s) => sum + (Number(s.amountUsd) || 0), 0);
  const purchaseScale: 'high' | 'medium' | 'small' =
    shipmentCount >= 12 || totalValueUsd >= 100_000 || totalWeightKg >= 20_000
      ? 'high'
      : shipmentCount >= 4 || totalValueUsd >= 20_000 || totalWeightKg >= 3_000
        ? 'medium'
        : 'small';

  // 2. Imported categories & materials
  const categorySet = new Set<string>();
  const materialSet = new Set<string>();
  for (const s of shipments) {
    const desc = String(s.productDescription ?? '').trim();
    if (desc) categorySet.add(desc.slice(0, 80));
    if (s.hsCode) categorySet.add(`HS ${s.hsCode}`);
    for (const [label, regex] of CUSTOMS_MATERIAL_PATTERNS) {
      if (regex.test(desc)) materialSet.add(label);
    }
  }

  // 3. Seasonal restocking (peak months + check if current month or next 2 months hit peak)
  const monthCounts = new Map<number, number>();
  for (const s of shipments) {
    if (!s.shipmentDate) continue;
    const m = new Date(s.shipmentDate).getUTCMonth() + 1;
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }
  const avgMonth = shipmentCount / Math.max(1, monthCounts.size);
  const seasonalPeakMonths = [...monthCounts.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.ceil(avgMonth * 1.25)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m]) => m);
  const currentMonth = now.getUTCMonth() + 1;
  const nextMonths = new Set([currentMonth, (currentMonth % 12) + 1, ((currentMonth + 1) % 12) + 1]);
  const upcomingRestockWindow = seasonalPeakMonths.some((m) => nextMonths.has(m));

  // 4. Supplier concentration
  const supplierCounts = new Map<string, number>();
  for (const s of shipments) {
    const key = String(s.exporterCompanyId || s.exporterNameRaw || '').trim().toLowerCase();
    if (!key) continue;
    supplierCounts.set(key, (supplierCounts.get(key) ?? 0) + 1);
  }
  const supplierCount = supplierCounts.size;
  const maxSupplierShipments = Math.max(0, ...supplierCounts.values());
  const topSupplierShare = shipmentCount > 0 ? Number((maxSupplierShipments / shipmentCount).toFixed(2)) : 0;
  const supplierConcentration: 'single_source' | 'concentrated' | 'diversified' =
    supplierCount === 1 && shipmentCount >= 2
      ? 'single_source'
      : topSupplierShare >= 0.7 && shipmentCount >= 3
        ? 'concentrated'
        : 'diversified';

  const summaryParts = [
    `海关记录匹配方式：${matchMethod === 'explicit_id' ? '已确认关联' : matchMethod === 'domain' ? '域名精确匹配' : '公司名+国家匹配'}（可信度 ${confidence}${stale ? '，数据超 365 天已过期' : ''}）`,
    `采购规模：${purchaseScale}（${shipmentCount} 票${totalValueUsd > 0 ? `，约 $${Math.round(totalValueUsd)}` : ''}）`,
    categorySet.size ? `进口品类/HS：${[...categorySet].slice(0, 4).join('；')}` : '',
    materialSet.size ? `识别材质：${[...materialSet].slice(0, 4).join('、')}` : '',
    seasonalPeakMonths.length ? `补货高峰月：${seasonalPeakMonths.join('/')} 月${upcomingRestockWindow ? '（临近补货窗口）' : ''}` : '',
    supplierCount > 0 ? `供应商集中度：${supplierConcentration}（${supplierCount} 家，头部占比 ${Math.round(topSupplierShare * 100)}%）` : '',
  ].filter(Boolean);

  return {
    matched: true,
    companyId: String(company._id),
    companyName: company.canonicalName,
    matchMethod,
    confidence,
    stale,
    latestShipmentAt,
    sourceName: source?.name,
    signals: {
      purchaseScale,
      shipmentCount,
      totalWeightKg: Math.round(totalWeightKg),
      totalValueUsd: Math.round(totalValueUsd),
      importedCategories: [...categorySet].slice(0, 8),
      importedMaterials: [...materialSet].slice(0, 6),
      seasonalPeakMonths,
      upcomingRestockWindow,
      supplierConcentration,
      topSupplierShare,
      supplierCount,
    },
    summaryText: summaryParts.join('；'),
  };
}

export interface CustomsSuggestionResult {
  companyId: string;
  summary: string;
  suggestions: Array<{ title: string; text: string; evidenceIds: string[] }>;
  ai: {
    used: boolean;
    model?: string;
    recommendations?: Array<{ text: string; rationale: string }>;
    emailDraft?: { subject: string; bodyText: string };
    note?: string;
  };
}

/** 基于海关贸易动态生成客户跟进建议；AI 不可用时返回可解释的规则建议。 */
export async function getCustomerTradeSuggestions(projectId: Types.ObjectId, customerId: string): Promise<CustomsSuggestionResult> {
  const trade = await getCustomerCustomsTrade(projectId, customerId);
  if (!trade.matched || !trade.company) throw ApiError.conflict('还没有匹配到海关公司，请先在贸易情报中确认公司');
  const company = trade.company;
  const recent = trade.recentShipments ?? [];
  const productNames = [...new Set(recent.map((shipment) => shipment.productDescription?.trim()).filter(Boolean))].slice(0, 5) as string[];
  const latest = recent[0];
  const evidenceIds = recent.slice(0, 3).map((shipment) => String(shipment._id));
  const suggestions: CustomsSuggestionResult['suggestions'] = [
    {
      title: '先确认采购时间窗口',
      text: `这家公司最近一票记录在 ${latest?.shipmentDate ? new Date(latest.shipmentDate).toISOString().slice(0, 10) : '暂无日期'}，共 ${company.shipmentCount} 票记录，累计 ${Math.round(company.totalAmountUsd).toLocaleString('en-US')} USD。先确认下一次补货或新包装计划，再决定报价节奏。`,
      evidenceIds,
    },
    {
      title: '从产品结构切入',
      text: productNames.length
        ? `近期产品包括：${productNames.join('、')}。开发信可以围绕同类产品的包装一致性、补货和样品对比展开。`
        : '海关记录没有足够的产品描述，先补充产品和 HS 映射，再做针对性开发。',
      evidenceIds,
    },
    {
      title: '避免把海关记录当成采购承诺',
      text: '海关数据只能说明历史进口行为，不能证明当前有采购需求。建议先发一封低压力确认邮件，不直接承诺价格、MOQ 或交期。',
      evidenceIds,
    },
  ];

  const ai: CustomsSuggestionResult['ai'] = { used: false };
  try {
    const provider = await resolveAgentProvider();
    if (provider.isAvailable()) {
      const analysis = await provider.analyzeCustomer({
        input: {
          customerName: String(trade.customer?.name ?? company.canonicalName),
          customerEmail: undefined,
          userRequest: '根据以下海关进口记录，总结客户采购画像，并给出一个不虚构事实的跟进角度。不要承诺价格、MOQ 或交期。',
          sourceCatalog: [{
            sourceId: `customs-${String(company._id)}`,
            kind: 'customs',
            label: '海关进口记录',
            content: {
              company: company.canonicalName,
              country: company.country,
              shipmentCount: company.shipmentCount,
              totalAmountUsd: company.totalAmountUsd,
              productNames,
              recentShipments: recent.slice(0, 10).map((shipment) => ({
                shipmentDate: shipment.shipmentDate,
                productDescription: shipment.productDescription,
                hsCode: shipment.hsCode,
                amountUsd: shipment.amountUsd,
                exporterName: shipment.exporterNameRaw,
              })),
            },
          }],
        },
        safetyIdentifier: `customs:${String(projectId)}:${customerId}`,
      });
      ai.used = true;
      ai.model = provider.model;
      ai.recommendations = (analysis.recommendations ?? []).slice(0, 5).map((item) => ({ text: item.text, rationale: item.rationale }));
      ai.emailDraft = analysis.emailDraft;
      ai.note = 'AI 结果仅供业务员参考，发送前必须人工审核。';
    }
  } catch (error) {
    ai.note = error instanceof Error ? `AI 暂不可用：${error.message}` : 'AI 暂不可用';
  }

  return {
    companyId: String(company._id),
    summary: `${company.canonicalName} 共有 ${company.shipmentCount} 票海关记录，累计 ${Math.round(company.totalAmountUsd).toLocaleString('en-US')} USD。`,
    suggestions,
    ai,
  };
}

type ShipmentLike = {
  _id: Types.ObjectId;
  importerCompanyId: Types.ObjectId;
  exporterCompanyId?: Types.ObjectId;
  importerNameRaw: string;
  exporterNameRaw?: string;
  productDescription?: string;
  amountUsd?: number;
  shipmentDate: Date;
};

/** 导入新提单时，为已监控的公司生成新进口提醒。 */
export async function createAlertsForShipment(projectId: Types.ObjectId, shipment: ShipmentLike): Promise<number> {
  const companyIds = [shipment.importerCompanyId, shipment.exporterCompanyId].filter(Boolean) as Types.ObjectId[];
  if (!companyIds.length) return 0;
  const watches = await CustomsWatch.find({
    projectId,
    enabled: true,
    companyId: { $in: companyIds },
  }).lean();
  let created = 0;
  for (const watch of watches) {
    const evidenceId = String(shipment._id);
    const exists = await CustomsAlert.findOne({
      projectId,
      watchId: watch._id,
      'evidence.shipmentId': evidenceId,
    }).lean();
    if (exists) continue;
    await CustomsAlert.create({
      projectId,
      watchId: watch._id,
      companyId: watch.companyId,
      customerId: watch.customerId,
      type: 'new_shipment',
      severity: 'info',
      title: `新进口记录：${shipment.importerNameRaw}`,
      summary: `${shipment.shipmentDate.toISOString().slice(0, 10)} 新增一票${shipment.productDescription ? `“${shipment.productDescription}”` : '海关记录'}，金额 ${Math.round(shipment.amountUsd ?? 0).toLocaleString('en-US')} USD。`,
      evidence: [{
        shipmentId: evidenceId,
        importerName: shipment.importerNameRaw,
        exporterName: shipment.exporterNameRaw ?? null,
        amountUsd: shipment.amountUsd ?? 0,
        shipmentDate: shipment.shipmentDate,
      }],
      status: 'unread',
    });
    created += 1;
  }
  return created;
}

export async function listCustomsWatchlists(projectId: Types.ObjectId) {
  return CustomsWatch.find({ projectId }).sort({ createdAt: -1 }).lean();
}

export async function watchCustomsCompany(projectId: Types.ObjectId, actorId: Types.ObjectId, companyId: string) {
  if (!Types.ObjectId.isValid(companyId)) throw ApiError.badRequest('公司 ID 无效');
  const company = await CustomsCompany.findOne({ _id: companyId, projectId, status: 'active' }).lean();
  if (!company) throw ApiError.notFound('海关公司不存在');
  const existing = await CustomsWatch.findOne({ projectId, watchType: 'company', companyId: company._id });
  if (existing) {
    existing.enabled = true;
    await existing.save();
    return existing.toObject();
  }
  return (await CustomsWatch.create({
    projectId, watchType: 'company', companyId: company._id, enabled: true, createdBy: actorId,
  })).toObject();
}

export async function unwatchCustomsCompany(projectId: Types.ObjectId, companyId: string) {
  const watch = await CustomsWatch.findOneAndUpdate(
    { projectId, watchType: 'company', companyId },
    { $set: { enabled: false } },
    { new: true },
  ).lean();
  if (!watch) throw ApiError.notFound('监控记录不存在');
  return watch;
}

async function findCompanyForCustomer(projectId: Types.ObjectId, customer: { customsCompanyId?: Types.ObjectId; website?: string; email?: string; company?: string; name: string; country?: string }) {
  if (customer.customsCompanyId) {
    const linked = await CustomsCompany.findOne({ _id: customer.customsCompanyId, projectId }).lean();
    if (linked) return linked;
  }
  const domain = domainFromAddress(customer.website || customer.email || '');
  const normalizedName = normalizeCompanyName(customer.company || customer.name);
  const country = normalizeCountry(customer.country);
  if (!domain && !normalizedName) return null;
  return CustomsCompany.findOne({
    projectId,
    $or: [
      ...(domain ? [{ domain }] : []),
      ...(normalizedName && country ? [{ normalizedName, country }] : []),
    ],
  }).lean();
}

export async function watchCustomsCustomer(projectId: Types.ObjectId, actorId: Types.ObjectId, customerId: string) {
  if (!Types.ObjectId.isValid(customerId)) throw ApiError.badRequest('客户 ID 无效');
  const customer = await Customer.findOne({ _id: customerId, projectId }).lean();
  if (!customer) throw ApiError.notFound('客户不存在');
  const company = await findCompanyForCustomer(projectId, customer);
  if (!company) throw ApiError.conflict('还没有匹配到海关公司，请先在贸易情报中确认公司');
  const existing = await CustomsWatch.findOne({ projectId, watchType: 'customer', customerId: customer._id });
  const watch = existing ?? new CustomsWatch({ projectId, watchType: 'customer', customerId: customer._id, createdBy: actorId });
  watch.companyId = company._id;
  watch.enabled = true;
  await watch.save();
  await Customer.updateOne(
    { _id: customer._id, projectId },
    { $set: { customsCompanyId: company._id, customsMatchConfidence: 0.8, customsMatchedAt: new Date() } },
  );
  return watch.toObject();
}

export async function unwatchCustomsCustomer(projectId: Types.ObjectId, customerId: string) {
  const watch = await CustomsWatch.findOneAndUpdate(
    { projectId, watchType: 'customer', customerId },
    { $set: { enabled: false } },
    { new: true },
  ).lean();
  if (!watch) throw ApiError.notFound('监控记录不存在');
  return watch;
}

export async function listCustomsAlerts(projectId: Types.ObjectId, filters: { status?: CustomsAlertStatus; type?: string; customerId?: string; page: number; limit: number }) {
  const query: FilterQuery<Record<string, unknown>> = { projectId };
  if (filters.status) query.status = filters.status;
  if (filters.type) query.type = filters.type;
  if (filters.customerId) query.customerId = filters.customerId;
  const [items, total] = await Promise.all([
    CustomsAlert.find(query).sort({ createdAt: -1 }).skip((filters.page - 1) * filters.limit).limit(filters.limit).lean(),
    CustomsAlert.countDocuments(query),
  ]);
  return { items, total, page: filters.page, limit: filters.limit };
}

export async function updateCustomsAlert(projectId: Types.ObjectId, alertId: string, status: CustomsAlertStatus) {
  if (!Types.ObjectId.isValid(alertId)) throw ApiError.badRequest('提醒 ID 无效');
  const alert = await CustomsAlert.findOneAndUpdate(
    { _id: alertId, projectId },
    { $set: { status } },
    { new: true },
  ).lean();
  if (!alert) throw ApiError.notFound('提醒不存在');
  return alert;
}

export async function scoreCustomsCompany(projectId: Types.ObjectId, companyId: string) {
  if (!Types.ObjectId.isValid(companyId)) throw ApiError.badRequest('公司 ID 无效');
  const company = await CustomsCompany.findOne({ _id: companyId, projectId, status: 'active' }).lean();
  if (!company) throw ApiError.notFound('海关公司不存在');
  const daysSince = company.lastSeenAt ? Math.floor((Date.now() - new Date(company.lastSeenAt).getTime()) / 86_400_000) : 9999;
  const reasons = [
    { label: '海关记录数', value: `${company.shipmentCount} 票` },
    { label: '累计金额', value: `${Math.round(company.totalAmountUsd)} USD` },
    { label: '最近记录', value: company.lastSeenAt ? new Date(company.lastSeenAt).toISOString().slice(0, 10) : '无' },
  ];
  let score = 10;
  score += Math.min(30, company.shipmentCount * 3);
  score += Math.min(35, Math.log10(company.totalAmountUsd + 1) * 7);
  if (daysSince <= 90) score += 20;
  else if (daysSince <= 365) score += 10;
  score = Math.min(100, Math.round(score));
  const calculatedAt = new Date();
  await CustomsScore.findOneAndUpdate(
    { projectId, companyId: company._id },
    { $set: { score, reasons, calculatedAt, version: 1 } },
    { upsert: true, new: true },
  );
  return { score, reasons, calculatedAt: calculatedAt.toISOString() };
}

export async function recordCustomsUsage(
  projectId: Types.ObjectId,
  metric: 'search' | 'company_view' | 'export' | 'record_ingested',
  quantity = 1,
  userId?: Types.ObjectId,
  metadata?: Record<string, unknown>,
) {
  if (quantity <= 0) return;
  await CustomsUsage.create({ projectId, metric, quantity, userId, metadata });
}

/** 海关来源线索、客户、报价和成交的轻量归因。 */
export async function getCustomsAttribution(projectId: Types.ObjectId) {
  const prospects = await Prospect.find({ projectId, source: 'customs' })
    .select('status customerId createdAt').lean();
  const customerIds = prospects
    .map((prospect) => prospect.customerId)
    .filter(Boolean) as Types.ObjectId[];
  const customers = await Customer.find({
    projectId,
    $or: [
      { customsCompanyId: { $exists: true } },
      ...(customerIds.length ? [{ _id: { $in: customerIds } }] : []),
    ],
  }).select('status createdAt').lean();
  const quotations = customerIds.length
    ? await Quotation.find({ projectId, customerId: { $in: customerIds } }).select('status totalAmount currency customerId').lean()
    : [];
  const prospectStatus = prospects.reduce<Record<string, number>>((acc, prospect) => {
    acc[prospect.status] = (acc[prospect.status] ?? 0) + 1;
    return acc;
  }, {});
  const customerStatus = customers.reduce<Record<string, number>>((acc, customer) => {
    acc[customer.status] = (acc[customer.status] ?? 0) + 1;
    return acc;
  }, {});
  return {
    prospects: { total: prospects.length, byStatus: prospectStatus, converted: prospects.filter((prospect) => prospect.status === 'converted').length },
    customers: { total: customers.length, byStatus: customerStatus, won: customers.filter((customer) => customer.status === 'won').length },
    quotations: {
      total: quotations.length,
      accepted: quotations.filter((quotation) => quotation.status === 'accepted').length,
      value: quotations.reduce((sum, quotation) => sum + Number(quotation.totalAmount ?? 0), 0),
    },
  };
}

export async function getCustomsUsage(projectId: Types.ObjectId) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await CustomsUsage.aggregate([
    { $match: { projectId, createdAt: { $gte: start } } },
    { $group: { _id: '$metric', quantity: { $sum: '$quantity' } } },
  ]);
  const usage: Record<string, number> = { search: 0, company_view: 0, export: 0, record_ingested: 0 };
  for (const row of rows) usage[String(row._id)] = Number(row.quantity ?? 0);
  return {
    period: start.toISOString().slice(0, 7),
    search: usage.search,
    companyView: usage.company_view,
    export: usage.export,
    recordIngested: usage.record_ingested,
    limits: { search: 10000, companyView: 5000, export: 1000, recordIngested: 1000000 },
  };
}
