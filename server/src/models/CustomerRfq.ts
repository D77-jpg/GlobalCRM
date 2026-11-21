import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { QUOTATION_CURRENCY, type QuotationCurrency } from '../constants';

export interface IRfqLine {
  product: string;
  sku?: string;
  material?: string;
  size?: string;
  /** Supports multi-tier quantities like "300/500/1000" */
  qty: string;
  logo?: string;
  color?: string;
  print?: string;
  closure?: string;
  insert?: string;
  packaging?: string;
  note?: string;
  /** Optional approved costing feedback filled by costing specialist */
  approvedUnitPrice?: number;
  approvedCurrency?: QuotationCurrency;
  pricingStatus?: 'pending' | 'approved';
}

export type RfqStatus = 'draft' | 'missing_info' | 'ready_for_costing' | 'costing_done' | 'quoted';

export interface ICustomerRfq {
  organizationId?: Types.ObjectId;
  projectId: Types.ObjectId;
  customerId: Types.ObjectId;
  rfqNo: string;
  title: string;
  destination?: string;
  incoterm?: string;
  channel?: string;
  status: RfqStatus;
  lines: IRfqLine[];
  notes?: string;
  /** Linked quotation once converted */
  quotationId?: Types.ObjectId;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerRfqDocument = HydratedDocument<ICustomerRfq>;
export type CustomerRfqModel = Model<ICustomerRfq>;

const RfqLineSchema = new Schema<IRfqLine>(
  {
    product: { type: String, required: true, trim: true, maxlength: 200 },
    sku: { type: String, trim: true, maxlength: 80 },
    material: { type: String, trim: true, maxlength: 160 },
    size: { type: String, trim: true, maxlength: 120 },
    qty: { type: String, default: '', trim: true, maxlength: 120 },
    logo: { type: String, trim: true, maxlength: 160 },
    color: { type: String, trim: true, maxlength: 160 },
    print: { type: String, trim: true, maxlength: 160 },
    closure: { type: String, trim: true, maxlength: 120 },
    insert: { type: String, trim: true, maxlength: 160 },
    packaging: { type: String, trim: true, maxlength: 160 },
    note: { type: String, trim: true, maxlength: 500 },
    approvedUnitPrice: { type: Number, min: 0 },
    approvedCurrency: { type: String, enum: QUOTATION_CURRENCY, uppercase: true },
    pricingStatus: { type: String, enum: ['pending', 'approved'], default: 'pending' },
  },
  { _id: false },
);

const CustomerRfqSchema = new Schema<ICustomerRfq>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    rfqNo: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    destination: { type: String, trim: true, maxlength: 160 },
    incoterm: { type: String, trim: true, maxlength: 40 },
    channel: { type: String, trim: true, maxlength: 40 },
    status: {
      type: String,
      enum: ['draft', 'missing_info', 'ready_for_costing', 'costing_done', 'quoted'],
      default: 'draft',
      index: true,
    },
    lines: { type: [RfqLineSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 2000 },
    quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, toJSON: { virtuals: true, versionKey: false } },
);

CustomerRfqSchema.index({ projectId: 1, rfqNo: 1 }, { unique: true });
CustomerRfqSchema.index({ projectId: 1, customerId: 1, updatedAt: -1 });

export const CustomerRfq = model<ICustomerRfq, CustomerRfqModel>('CustomerRfq', CustomerRfqSchema);
export default CustomerRfq;
