import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type WorkbenchItemKind = 'open_question' | 'commitment' | 'internal_task';
export type WorkbenchItemStatus = 'open' | 'result_ready' | 'resolved' | 'dismissed';
export type WorkbenchOwnerRole = 'Sales' | 'Costing' | 'Engineering' | 'QC' | 'Logistics' | 'Customs' | 'Management';
export type CommitmentGrade = 'A' | 'B' | 'C';

export interface ICustomerWorkbenchItem {
  organizationId?: Types.ObjectId;
  projectId: Types.ObjectId;
  customerId: Types.ObjectId;
  kind: WorkbenchItemKind;
  status: WorkbenchItemStatus;
  title: string;
  /** Original buyer question or commitment quote from outgoing mail */
  quote?: string;
  /** Handling status from mail analysis */
  handling?: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED';
  /** Commitment grade: A verified fact, B authorized next step, C pending check */
  grade?: CommitmentGrade;
  ownerRole: WorkbenchOwnerRole;
  dueAt?: Date;
  /** Internal verification result filled by costing/engineering/QC */
  resultNote?: string;
  /** Source mail/analysis reference for traceability */
  sourceMailId?: string;
  sourceAnalysisId?: string;
  createdBy?: Types.ObjectId;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerWorkbenchItemDocument = HydratedDocument<ICustomerWorkbenchItem>;
export type CustomerWorkbenchItemModel = Model<ICustomerWorkbenchItem>;

const CustomerWorkbenchItemSchema = new Schema<ICustomerWorkbenchItem>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    kind: { type: String, enum: ['open_question', 'commitment', 'internal_task'], required: true, index: true },
    status: { type: String, enum: ['open', 'result_ready', 'resolved', 'dismissed'], default: 'open', index: true },
    title: { type: String, required: true, trim: true, maxlength: 500 },
    quote: { type: String, trim: true, maxlength: 1200 },
    handling: { type: String, enum: ['ANSWERED', 'ASKED', 'CHECKING', 'NOTED', 'DECLINED'] },
    grade: { type: String, enum: ['A', 'B', 'C'] },
    ownerRole: {
      type: String,
      enum: ['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management'],
      default: 'Sales',
    },
    dueAt: Date,
    resultNote: { type: String, trim: true, maxlength: 2000 },
    sourceMailId: { type: String, trim: true, maxlength: 128 },
    sourceAnalysisId: { type: String, trim: true, maxlength: 128 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true, versionKey: false, toJSON: { virtuals: true, versionKey: false } },
);

CustomerWorkbenchItemSchema.index({ projectId: 1, customerId: 1, status: 1, createdAt: -1 });
CustomerWorkbenchItemSchema.index({ projectId: 1, status: 1, kind: 1, dueAt: 1 });

export const CustomerWorkbenchItem = model<ICustomerWorkbenchItem, CustomerWorkbenchItemModel>(
  'CustomerWorkbenchItem',
  CustomerWorkbenchItemSchema,
);
export default CustomerWorkbenchItem;
