import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type CustomsSourceKind = 'api' | 'csv' | 'object_storage';
export type CustomsSourceStatus = 'active' | 'paused' | 'error' | 'disabled';
export type CustomsCompanyType = 'importer' | 'exporter' | 'both' | 'unknown';
export type CustomsCompanyStatus = 'active' | 'merged' | 'ignored';
export type CustomsMatchType = 'customer' | 'prospect';
export type CustomsMatchMethod = 'domain' | 'vat' | 'eori' | 'name_country' | 'address' | 'fuzzy' | 'manual';
export type CustomsMatchStatus = 'suggested' | 'confirmed' | 'rejected';

export interface ICustomsSource {
  projectId: Types.ObjectId;
  name: string;
  provider: string;
  kind: CustomsSourceKind;
  status: CustomsSourceStatus;
  credentialsEncrypted?: string;
  coverageCountries: string[];
  fieldMapping?: Record<string, unknown>;
  syncCursor?: string;
  lastSyncAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICustomsCompany {
  projectId: Types.ObjectId;
  canonicalName: string;
  normalizedName: string;
  country: string;
  address?: string;
  domain?: string;
  vat?: string;
  eori?: string;
  registrationNo?: string;
  companyType: CustomsCompanyType;
  sourceIds: Types.ObjectId[];
  aliases: string[];
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  shipmentCount: number;
  totalAmountUsd: number;
  status: CustomsCompanyStatus;
  mergedIntoId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICustomsShipment {
  projectId: Types.ObjectId;
  sourceId: Types.ObjectId;
  sourceRecordId: string;
  importerCompanyId: Types.ObjectId;
  exporterCompanyId?: Types.ObjectId;
  importerNameRaw: string;
  exporterNameRaw?: string;
  importerCountry: string;
  exporterCountry?: string;
  hsCode?: string;
  hsCodeRaw?: string;
  productDescription?: string;
  quantity?: number;
  quantityUnit?: string;
  weightKg?: number;
  amount?: number;
  currency?: string;
  amountUsd?: number;
  shipmentDate: Date;
  arrivalDate?: Date;
  portOfLoading?: string;
  portOfDischarge?: string;
  transportMode?: string;
  billOfLading?: string;
  dataDate?: Date;
  raw?: Record<string, unknown>;
  fingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICustomsMatch {
  projectId: Types.ObjectId;
  companyId: Types.ObjectId;
  crmType: CustomsMatchType;
  crmId: Types.ObjectId;
  method: CustomsMatchMethod;
  confidence: number;
  evidence: string[];
  status: CustomsMatchStatus;
  confirmedBy?: Types.ObjectId;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomsSourceDocument = HydratedDocument<ICustomsSource>;
export type CustomsSourceModel = Model<ICustomsSource>;
export type CustomsCompanyDocument = HydratedDocument<ICustomsCompany>;
export type CustomsCompanyModel = Model<ICustomsCompany>;
export type CustomsShipmentDocument = HydratedDocument<ICustomsShipment>;
export type CustomsShipmentModel = Model<ICustomsShipment>;
export type CustomsMatchDocument = HydratedDocument<ICustomsMatch>;
export type CustomsMatchModel = Model<ICustomsMatch>;

const CustomsSourceSchema = new Schema<ICustomsSource>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  provider: { type: String, required: true, trim: true, maxlength: 100 },
  kind: { type: String, enum: ['api', 'csv', 'object_storage'], default: 'csv' },
  status: { type: String, enum: ['active', 'paused', 'error', 'disabled'], default: 'active', index: true },
  credentialsEncrypted: { type: String, select: false },
  coverageCountries: { type: [String], default: [] },
  fieldMapping: { type: Schema.Types.Mixed },
  syncCursor: { type: String, trim: true },
  lastSyncAt: Date,
  lastSuccessAt: Date,
  lastError: { type: String, maxlength: 1000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false });
CustomsSourceSchema.index({ projectId: 1, provider: 1 }, { unique: true });
CustomsSourceSchema.index({ projectId: 1, status: 1 });

const CustomsCompanySchema = new Schema<ICustomsCompany>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  canonicalName: { type: String, required: true, trim: true, maxlength: 300 },
  normalizedName: { type: String, required: true, trim: true, maxlength: 300, index: true },
  country: { type: String, required: true, trim: true, uppercase: true, maxlength: 2, index: true },
  address: { type: String, trim: true, maxlength: 1000 },
  domain: { type: String, trim: true, lowercase: true, maxlength: 300 },
  vat: { type: String, trim: true, maxlength: 80 },
  eori: { type: String, trim: true, maxlength: 80 },
  registrationNo: { type: String, trim: true, maxlength: 80 },
  companyType: { type: String, enum: ['importer', 'exporter', 'both', 'unknown'], default: 'unknown', index: true },
  sourceIds: { type: [Schema.Types.ObjectId], ref: 'CustomsSource', default: [] },
  aliases: { type: [String], default: [] },
  firstSeenAt: Date,
  lastSeenAt: Date,
  shipmentCount: { type: Number, default: 0, min: 0 },
  totalAmountUsd: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'merged', 'ignored'], default: 'active', index: true },
  mergedIntoId: { type: Schema.Types.ObjectId, ref: 'CustomsCompany' },
}, { timestamps: true, versionKey: false });
CustomsCompanySchema.index({ projectId: 1, normalizedName: 1, country: 1 });
CustomsCompanySchema.index({ projectId: 1, domain: 1 });
CustomsCompanySchema.index({ projectId: 1, vat: 1 });
CustomsCompanySchema.index({ projectId: 1, eori: 1 });
CustomsCompanySchema.index({ projectId: 1, status: 1, lastSeenAt: -1 });

const CustomsShipmentSchema = new Schema<ICustomsShipment>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  sourceId: { type: Schema.Types.ObjectId, ref: 'CustomsSource', required: true, index: true },
  sourceRecordId: { type: String, required: true, trim: true, maxlength: 200 },
  importerCompanyId: { type: Schema.Types.ObjectId, ref: 'CustomsCompany', required: true, index: true },
  exporterCompanyId: { type: Schema.Types.ObjectId, ref: 'CustomsCompany', index: true },
  importerNameRaw: { type: String, required: true, trim: true, maxlength: 500 },
  exporterNameRaw: { type: String, trim: true, maxlength: 500 },
  importerCountry: { type: String, required: true, trim: true, uppercase: true, maxlength: 2 },
  exporterCountry: { type: String, trim: true, uppercase: true, maxlength: 2 },
  hsCode: { type: String, trim: true, maxlength: 6, index: true },
  hsCodeRaw: { type: String, trim: true, maxlength: 20 },
  productDescription: { type: String, trim: true, maxlength: 4000 },
  quantity: { type: Number, min: 0 },
  quantityUnit: { type: String, trim: true, maxlength: 40 },
  weightKg: { type: Number, min: 0 },
  amount: { type: Number, min: 0 },
  currency: { type: String, trim: true, uppercase: true, maxlength: 3 },
  amountUsd: { type: Number, min: 0, index: true },
  shipmentDate: { type: Date, required: true, index: true },
  arrivalDate: Date,
  portOfLoading: { type: String, trim: true, maxlength: 160 },
  portOfDischarge: { type: String, trim: true, maxlength: 160 },
  transportMode: { type: String, trim: true, maxlength: 40 },
  billOfLading: { type: String, trim: true, maxlength: 160 },
  dataDate: Date,
  raw: { type: Schema.Types.Mixed },
  fingerprint: { type: String, required: true, trim: true, maxlength: 200 },
}, { timestamps: true, versionKey: false });
CustomsShipmentSchema.index({ projectId: 1, sourceId: 1, sourceRecordId: 1 }, { unique: true });
CustomsShipmentSchema.index({ projectId: 1, importerCompanyId: 1, shipmentDate: -1 });
CustomsShipmentSchema.index({ projectId: 1, exporterCompanyId: 1, shipmentDate: -1 });
CustomsShipmentSchema.index({ projectId: 1, hsCode: 1, shipmentDate: -1 });
CustomsShipmentSchema.index({ projectId: 1, fingerprint: 1 });
CustomsShipmentSchema.index({ projectId: 1, dataDate: -1 });
CustomsShipmentSchema.index(
  { projectId: 1, importerNameRaw: 'text', exporterNameRaw: 'text', productDescription: 'text' },
  { name: 'customs_shipment_text' },
);

const CustomsMatchSchema = new Schema<ICustomsMatch>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  companyId: { type: Schema.Types.ObjectId, ref: 'CustomsCompany', required: true, index: true },
  crmType: { type: String, enum: ['customer', 'prospect'], required: true, index: true },
  crmId: { type: Schema.Types.ObjectId, required: true, index: true },
  method: { type: String, enum: ['domain', 'vat', 'eori', 'name_country', 'address', 'fuzzy', 'manual'], required: true },
  confidence: { type: Number, required: true, min: 0, max: 1 },
  evidence: { type: [String], default: [] },
  status: { type: String, enum: ['suggested', 'confirmed', 'rejected'], default: 'suggested', index: true },
  confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  confirmedAt: Date,
}, { timestamps: true, versionKey: false });
CustomsMatchSchema.index({ projectId: 1, companyId: 1, crmType: 1, crmId: 1 }, { unique: true });
CustomsMatchSchema.index({ projectId: 1, crmType: 1, crmId: 1, status: 1 });

export const CustomsSource = model<ICustomsSource, CustomsSourceModel>('CustomsSource', CustomsSourceSchema);
export const CustomsCompany = model<ICustomsCompany, CustomsCompanyModel>('CustomsCompany', CustomsCompanySchema);
export const CustomsShipment = model<ICustomsShipment, CustomsShipmentModel>('CustomsShipment', CustomsShipmentSchema);
export const CustomsMatch = model<ICustomsMatch, CustomsMatchModel>('CustomsMatch', CustomsMatchSchema);
export const customsModels = [CustomsSource, CustomsCompany, CustomsShipment, CustomsMatch];
