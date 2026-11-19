import './tenant-setup';
import { Schema, model, Types, type HydratedDocument } from 'mongoose';

export type ExperimentStratum = 'brand' | 'data_tier' | 'contact_role';

export interface IOutreachExperiment {
  projectId: Types.ObjectId;
  organizationId?: Types.ObjectId;
  name: string;
  brandKey: string;
  stratifyBy: ExperimentStratum[];
  controlVersion: string;
  treatmentVersion: string;
  observationWindowDays: number;
  minSamplePerArm: number;
  status: 'draft' | 'running' | 'completed' | 'paused';
  startedAt?: Date;
  endsAt?: Date;
  assignments: {
    customerId: Types.ObjectId;
    arm: 'control' | 'treatment';
    writingVersion: string;
    stratumKey: string;
    assignedAt: Date;
  }[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type OutreachExperimentDocument = HydratedDocument<IOutreachExperiment>;

const schema = new Schema<IOutreachExperiment>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    brandKey: { type: String, required: true, trim: true, maxlength: 40 },
    stratifyBy: { type: [String], enum: ['brand', 'data_tier', 'contact_role'], default: ['data_tier', 'contact_role'] },
    controlVersion: { type: String, required: true, trim: true, maxlength: 60 },
    treatmentVersion: { type: String, required: true, trim: true, maxlength: 60 },
    observationWindowDays: { type: Number, default: 14, min: 3, max: 90 },
    minSamplePerArm: { type: Number, default: 30, min: 10, max: 1000 },
    status: { type: String, enum: ['draft', 'running', 'completed', 'paused'], default: 'running', index: true },
    startedAt: { type: Date, default: Date.now },
    endsAt: Date,
    assignments: {
      type: [{
        customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
        arm: { type: String, enum: ['control', 'treatment'], required: true },
        writingVersion: { type: String, required: true, maxlength: 60 },
        stratumKey: { type: String, required: true, maxlength: 120 },
        assignedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

schema.index({ projectId: 1, status: 1, createdAt: -1 });

export const OutreachExperiment = model<IOutreachExperiment>('OutreachExperiment', schema);
export default OutreachExperiment;
