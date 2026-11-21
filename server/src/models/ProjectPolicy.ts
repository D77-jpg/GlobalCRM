import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type ProjectPolicyCategory =
  | 'moq'
  | 'pricing'
  | 'samples'
  | 'lead_time'
  | 'payment'
  | 'shipping'
  | 'material'
  | 'quality'
  | 'compliance'
  | 'company'
  | 'other';

export interface IProjectPolicy {
  organizationId?: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Stable policy code such as P-MOQ, P-PAYMENT, P-PROD-TIME */
  code: string;
  topic: string;
  category: ProjectPolicyCategory;
  scope?: string;
  valueZh: string;
  valueEn: string;
  /** Whether AI / sales may state these numbers/facts externally to buyers. */
  external: boolean;
  /** Whether management has signed off on this policy (false = 待老板拍板). */
  confirmed: boolean;
  conflictNote?: string;
  source?: string;
  ownerRole?: string;
  version: number;
  updatedBy?: Types.ObjectId;
  confirmedBy?: Types.ObjectId;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectPolicyDocument = HydratedDocument<IProjectPolicy>;
export type ProjectPolicyModel = Model<IProjectPolicy>;

const ProjectPolicySchema = new Schema<IProjectPolicy>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      match: [/^[A-Z0-9][A-Z0-9_-]{1,39}$/, '口径编号仅支持大写字母、数字、连字符和下划线'],
    },
    topic: { type: String, required: true, trim: true, maxlength: 120 },
    category: {
      type: String,
      enum: ['moq', 'pricing', 'samples', 'lead_time', 'payment', 'shipping', 'material', 'quality', 'compliance', 'company', 'other'],
      default: 'other',
      index: true,
    },
    scope: { type: String, trim: true, maxlength: 200 },
    valueZh: { type: String, required: true, trim: true, maxlength: 2000 },
    valueEn: { type: String, default: '', trim: true, maxlength: 2000 },
    external: { type: Boolean, default: true, index: true },
    confirmed: { type: Boolean, default: true, index: true },
    conflictNote: { type: String, trim: true, maxlength: 500 },
    source: { type: String, trim: true, maxlength: 200 },
    ownerRole: { type: String, trim: true, maxlength: 80 },
    version: { type: Number, default: 1, min: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: Date,
  },
  { timestamps: true, versionKey: false, toJSON: { virtuals: true, versionKey: false } },
);

ProjectPolicySchema.index({ projectId: 1, code: 1 }, { unique: true });
ProjectPolicySchema.index({ projectId: 1, category: 1, confirmed: 1 });

export const ProjectPolicy = model<IProjectPolicy, ProjectPolicyModel>('ProjectPolicy', ProjectPolicySchema);
export default ProjectPolicy;
