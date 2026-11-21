import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type ProjectStatus = 'active' | 'archived';

/**
 * Customer-editable brand / sales narrative. Every field is optional so
 * existing projects keep the built-in profile resolved by project code.
 */
export interface ProjectApprovedOffer {
  id: string;
  label: string;
  actionText: string;
  category: 'spec_sheet' | 'drawing' | 'swatch' | 'sample' | 'quote_range' | 'other';
  requiresEvidence: boolean;
  allowsFree: boolean;
  allowsSample: boolean;
  allowsShipping: boolean;
  conditions?: string;
  enabled: boolean;
}

export interface ProjectIndustryRule {
  code: string;
  name: string;
  requiredPattern?: string;
  excludedPattern?: string;
  keywords: string[];
  priority?: number;
}

export interface ProjectGuardrailRedline {
  id: string;
  pattern: string;
  message: string;
  severity: 'bad' | 'warn';
  skipSegment?: string;
  enabled: boolean;
}

export interface ProjectWritingRule {
  id: string;
  text: string;
  enabled: boolean;
  source?: string;
}

export interface ProjectBrandProfile {
  brandKey?: 'genesis' | 'ironhue' | 'velaturo' | 'general';
  pricingMode?: 'catalog_tiered' | 'costing_approved';
  guardrailRedlines?: ProjectGuardrailRedline[];
  teamWritingRules?: ProjectWritingRule[];
  approvedActions?: string[];
  approvedOffers?: ProjectApprovedOffer[];
  industryRules?: ProjectIndustryRule[];
  activeWritingVersion?: string;
  writingPausedReason?: string;
  logoPath?: string | null;
  defaultLetterSubject?: string;
  defaultLetterTemplate?: string;
  label?: string;
  identity?: string;
  offerSummary?: string;
  outreachFocus?: string;
  avoidTopics?: string;
  insightLabel?: string;
  insightExamples?: string;
  proofExamples?: string;
  ctaExamples?: string;
  subjectFocus?: string;
  signatureTitle?: string;
  signatureLines?: string[];
}

export interface ProjectMailCompliance {
  /** Gradual sending ramp-up for a new mailbox/domain. */
  warmupEnabled: boolean;
  warmupStartedAt?: Date;
  warmupStartLimit: number;
  warmupDailyIncrement: number;
  warmupMaxLimit: number;
  /** Project-wide hard cap per sender mailbox per UTC day. */
  dailySendLimit: number;
  /** Open/click telemetry is optional and can be disabled for privacy. */
  trackingEnabled: boolean;
}

export interface IProject {
  organizationId?: Types.ObjectId;
  name: string;
  slug: string;
  code: string;
  industry?: string;
  companyName: string;
  website?: string;
  moq?: string;
  senderName?: string;
  mailFrom?: string;
  mailProfileKey: string;
  /** 项目级发送通道开关；未设置时按环境变量 / mailProfileKey 的旧逻辑推断 */
  mailTransport?: 'mock' | 'smtp';
  /** Optional project logo: compressed data URL or an absolute https URL. */
  logoImage?: string;
  coverImage?: string;
  /** Brand, offer, outreach focus and signature edited in project settings. */
  brandProfile?: ProjectBrandProfile;
  /** Sending compliance controls (warm-up and project-level daily cap). */
  mailCompliance?: ProjectMailCompliance;
  /** Set by the first-use checklist; null/undefined means onboarding is pending. */
  onboardingCompletedAt?: Date;
  status: ProjectStatus;
  isDefault: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectDocument = HydratedDocument<IProject>;
export type ProjectModel = Model<IProject>;

const ProjectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '项目标识只能包含小写字母、数字和连字符'],
    },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    industry: { type: String, trim: true, maxlength: 120 },
    companyName: { type: String, required: true, trim: true, maxlength: 200 },
    website: { type: String, trim: true, maxlength: 300 },
    moq: { type: String, trim: true, maxlength: 120 },
    senderName: { type: String, trim: true, maxlength: 120 },
    mailFrom: { type: String, trim: true, maxlength: 300 },
    // 凭据不入库；通过服务端 PROJECT_MAIL_CONFIGS_JSON 用此键查找。
    mailProfileKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    // 项目级真实发送开关；undefined 保持旧配置兼容，显式 mock/smtp 优先于环境变量
    mailTransport: { type: String, enum: ['mock', 'smtp'] },
    // Compressed data URL (browser downscales to <=512px) or an absolute https URL.
    logoImage: { type: String, maxlength: 600000 },
    // Compressed data URL (browser downscales to <=1280px) or an absolute https URL.
    coverImage: { type: String, maxlength: 600000 },
    brandProfile: {
      brandKey: { type: String, enum: ['genesis', 'ironhue', 'velaturo', 'general'] },
      pricingMode: { type: String, enum: ['catalog_tiered', 'costing_approved'] },
      guardrailRedlines: {
        type: [{
          id: { type: String, required: true, trim: true, maxlength: 60 },
          pattern: { type: String, required: true, trim: true, maxlength: 350 },
          message: { type: String, required: true, trim: true, maxlength: 400 },
          severity: { type: String, enum: ['bad', 'warn'], default: 'bad' },
          skipSegment: { type: String, trim: true, maxlength: 20 },
          enabled: { type: Boolean, default: true },
        }],
        default: undefined,
      },
      teamWritingRules: {
        type: [{
          id: { type: String, required: true, trim: true, maxlength: 60 },
          text: { type: String, required: true, trim: true, maxlength: 500 },
          enabled: { type: Boolean, default: true },
          source: { type: String, trim: true, maxlength: 120 },
        }],
        default: undefined,
      },
      approvedActions: { type: [String], default: undefined },
      approvedOffers: {
        type: [{
          id: { type: String, required: true, trim: true, maxlength: 60 },
          label: { type: String, required: true, trim: true, maxlength: 120 },
          actionText: { type: String, required: true, trim: true, maxlength: 400 },
          category: { type: String, enum: ['spec_sheet', 'drawing', 'swatch', 'sample', 'quote_range', 'other'], default: 'other' },
          requiresEvidence: { type: Boolean, default: true },
          allowsFree: { type: Boolean, default: false },
          allowsSample: { type: Boolean, default: false },
          allowsShipping: { type: Boolean, default: false },
          conditions: { type: String, trim: true, maxlength: 500 },
          enabled: { type: Boolean, default: true },
        }],
        default: undefined,
      },
      industryRules: {
        type: [{
          code: { type: String, required: true, trim: true, maxlength: 40 },
          name: { type: String, required: true, trim: true, maxlength: 120 },
          requiredPattern: { type: String, trim: true, maxlength: 400 },
          excludedPattern: { type: String, trim: true, maxlength: 400 },
          keywords: { type: [String], default: [] },
          priority: { type: Number, default: 0 },
        }],
        default: undefined,
      },
      activeWritingVersion: { type: String, trim: true, maxlength: 60 },
      writingPausedReason: { type: String, trim: true, maxlength: 300 },
      logoPath: { type: String, trim: true, maxlength: 500 },
      defaultLetterSubject: { type: String, trim: true, maxlength: 300 },
      defaultLetterTemplate: { type: String, maxlength: 20000 },
      label: { type: String, trim: true, maxlength: 200 },
      identity: { type: String, trim: true, maxlength: 500 },
      offerSummary: { type: String, trim: true, maxlength: 2000 },
      outreachFocus: { type: String, trim: true, maxlength: 1000 },
      avoidTopics: { type: String, trim: true, maxlength: 1000 },
      insightLabel: { type: String, trim: true, maxlength: 200 },
      insightExamples: { type: String, trim: true, maxlength: 2000 },
      proofExamples: { type: String, trim: true, maxlength: 3000 },
      ctaExamples: { type: String, trim: true, maxlength: 1000 },
      subjectFocus: { type: String, trim: true, maxlength: 300 },
      signatureTitle: { type: String, trim: true, maxlength: 300 },
      signatureLines: { type: [String], default: undefined },
    },
    mailCompliance: {
      warmupEnabled: { type: Boolean, default: false },
      warmupStartedAt: Date,
      warmupStartLimit: { type: Number, default: 20, min: 1, max: 5000 },
      warmupDailyIncrement: { type: Number, default: 10, min: 1, max: 1000 },
      warmupMaxLimit: { type: Number, default: 200, min: 1, max: 10000 },
      dailySendLimit: { type: Number, default: 300, min: 1, max: 10000 },
      trackingEnabled: { type: Boolean, default: true },
    },
    onboardingCompletedAt: Date,
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, toJSON: { virtuals: true, versionKey: false } },
);

ProjectSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
ProjectSchema.index({ organizationId: 1, code: 1 }, { unique: true });
ProjectSchema.index({ status: 1, name: 1 });

export const Project = model<IProject, ProjectModel>('Project', ProjectSchema);
export default Project;
