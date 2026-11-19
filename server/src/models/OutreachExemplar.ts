import './tenant-setup';
import { Schema, model, Types, type HydratedDocument } from 'mongoose';

export type ExemplarOutcomeType = 'interested' | 'inquiry' | 'sample_request' | 'quoted' | 'won';

export interface IOutreachExemplar {
  projectId: Types.ObjectId;
  organizationId?: Types.ObjectId;
  sourceLetterId: Types.ObjectId;
  brandKey: string;
  industry?: string;
  segmentCode?: string;
  segmentName?: string;
  preferenceCode?: string;
  outreachStep: number;
  outcomeType: ExemplarOutcomeType;
  /** PII 脱敏后的主题与正文范本，不含真实客户名、邮箱、电话、公司名或报价数字 */
  redactedSubject: string;
  redactedBody: string;
  structureNotes: string;
  wordCount: number;
  approved: boolean;
  harvestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OutreachExemplarDocument = HydratedDocument<IOutreachExemplar>;

const schema = new Schema<IOutreachExemplar>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    sourceLetterId: { type: Schema.Types.ObjectId, ref: 'DevelopmentLetter', required: true },
    brandKey: { type: String, required: true, trim: true, maxlength: 40 },
    industry: { type: String, trim: true, maxlength: 120 },
    segmentCode: { type: String, trim: true, maxlength: 40 },
    segmentName: { type: String, trim: true, maxlength: 160 },
    preferenceCode: { type: String, trim: true, maxlength: 40 },
    outreachStep: { type: Number, default: 1, min: 1, max: 3 },
    outcomeType: { type: String, enum: ['interested', 'inquiry', 'sample_request', 'quoted', 'won'], required: true },
    redactedSubject: { type: String, required: true, trim: true, maxlength: 300 },
    redactedBody: { type: String, required: true, trim: true, maxlength: 4000 },
    structureNotes: { type: String, default: '', maxlength: 600 },
    wordCount: { type: Number, default: 0, min: 0 },
    approved: { type: Boolean, default: true },
    harvestedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

schema.index({ projectId: 1, sourceLetterId: 1 }, { unique: true });
schema.index({ projectId: 1, brandKey: 1, segmentCode: 1, outreachStep: 1 });

export const OutreachExemplar = model<IOutreachExemplar>('OutreachExemplar', schema);
export default OutreachExemplar;
