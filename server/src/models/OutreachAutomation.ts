import './tenant-setup';
import { Schema, Types, model, type HydratedDocument } from 'mongoose';

/**
 * 自动开发（Outreach Autopilot）
 * ------------------------------------------------------------------
 * 配置按「项目 + 业务员」隔离；每个业务员只用自己的已验证邮箱发送。
 * 队列项保存客户当前进度，真正的草稿与邮件仍以 AgentTask /
 * DevelopmentLetter 为准，避免自动流程和人工流程产生两套内容。
 */
export type OutreachAutomationEnrollmentStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'failed';

export interface IOutreachAutomationConfig {
  rolloutMode?: 'shadow' | 'pilot' | 'active';
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  actorRole: 'admin' | 'project_admin' | 'user' | 'viewer';
  enabled: boolean;
  pausedReason?: string;
  dailyLimit: number;
  perDomainLimit: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  /** 按每位收件人所在时区、夏令时和当地工作日排程；未填时区时按客户国家/地址推断。 */
  useBuyerTimezone?: boolean;
  /** 随机错峰发送最小间隔（秒），默认 90 秒 */
  minPacingSeconds?: number;
  /** 随机错峰发送最大间隔（秒），默认 240 秒 */
  maxPacingSeconds?: number;
  /** 本活动下一次允许发送的错峰时间 */
  nextPacingAt?: Date;
  version: number;
  lastTickAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutreachEnrollmentErrorHistoryItem {
  at: Date;
  step?: number;
  message: string;
  resolvedAt?: Date;
  resolvedReason?: string;
}

export interface IOutreachAutomationEnrollment {
  projectId: Types.ObjectId;
  campaignId: Types.ObjectId;
  userId: Types.ObjectId;
  customerId: Types.ObjectId;
  status: OutreachAutomationEnrollmentStatus;
  /** 区分是业务员手动暂停还是系统因检查/发信拦截而自动暂停；旧记录未填时不做猜测恢复。 */
  pauseOrigin?: 'manual' | 'system';
  pausedAt?: Date;
  pausedReason?: string;
  /** 已发出的开发信封数；以 Customer.outreachStep 为准，这里只做队列展示。 */
  currentStep: number;
  nextRunAt: Date;
  queuedStep?: number;
  queuedAt?: Date;
  taskIds: Types.ObjectId[];
  lastError?: string;
  errorHistory?: OutreachEnrollmentErrorHistoryItem[];
  attempts: number;
  lastSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OutreachAutomationConfigDocument = HydratedDocument<IOutreachAutomationConfig>;
export type OutreachAutomationEnrollmentDocument = HydratedDocument<IOutreachAutomationEnrollment>;

const configSchema = new Schema<IOutreachAutomationConfig>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: { type: String, enum: ['admin', 'project_admin', 'user', 'viewer'], required: true },
    enabled: { type: Boolean, default: false },
    rolloutMode: { type: String, enum: ['shadow', 'pilot', 'active'] },
    pausedReason: { type: String, maxlength: 300 },
    dailyLimit: { type: Number, default: 20, min: 1, max: 20 },
    perDomainLimit: { type: Number, default: 3, min: 1, max: 10 },
    windowStart: { type: String, default: '09:30', match: /^\d{2}:\d{2}$/ },
    windowEnd: { type: String, default: '17:30', match: /^\d{2}:\d{2}$/ },
    timezone: { type: String, default: 'Asia/Shanghai', maxlength: 80 },
    useBuyerTimezone: { type: Boolean, default: false },
    minPacingSeconds: { type: Number, default: 90, min: 30, max: 3600 },
    maxPacingSeconds: { type: Number, default: 240, min: 60, max: 7200 },
    nextPacingAt: Date,
    version: { type: Number, default: 0, min: 0 },
    lastTickAt: Date,
  },
  { timestamps: true, versionKey: false },
);
configSchema.index({ projectId: 1, userId: 1 }, { unique: true });
export const OutreachAutomationConfig = model<IOutreachAutomationConfig>('OutreachAutomationConfig', configSchema);

const enrollmentSchema = new Schema<IOutreachAutomationEnrollment>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'OutreachAutomationConfig', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'paused', 'blocked', 'completed', 'failed'],
      default: 'active',
      index: true,
    },
    pauseOrigin: {
      type: String,
      enum: ['manual', 'system'],
    },
    pausedAt: Date,
    pausedReason: { type: String, maxlength: 300 },
    currentStep: { type: Number, default: 0, min: 0, max: 3 },
    nextRunAt: { type: Date, required: true, index: true },
    queuedStep: { type: Number, min: 1, max: 3 },
    queuedAt: Date,
    taskIds: [{ type: Schema.Types.ObjectId, ref: 'AgentTask' }],
    lastError: { type: String, maxlength: 500 },
    errorHistory: {
      type: [{
        at: { type: Date, required: true },
        step: { type: Number, min: 1, max: 3 },
        message: { type: String, required: true, maxlength: 500 },
        resolvedAt: Date,
        resolvedReason: { type: String, maxlength: 200 },
      }],
      default: [],
    },
    attempts: { type: Number, default: 0, min: 0 },
    lastSentAt: Date,
  },
  { timestamps: true, versionKey: false },
);
enrollmentSchema.index({ campaignId: 1, customerId: 1 }, { unique: true });
enrollmentSchema.index({ campaignId: 1, status: 1, nextRunAt: 1 });
export const OutreachAutomationEnrollment = model<IOutreachAutomationEnrollment>('OutreachAutomationEnrollment', enrollmentSchema);

const daySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'OutreachAutomationConfig', required: true, index: true },
    day: { type: String, required: true },
    sent: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);
daySchema.index({ campaignId: 1, day: 1 }, { unique: true });
export const OutreachAutomationDay = model('OutreachAutomationDay', daySchema);
