import { z } from 'zod';

export const approvedOfferSchema = z.object({
  id: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  actionText: z.string().trim().min(1).max(400),
  category: z.enum(['spec_sheet', 'drawing', 'swatch', 'sample', 'quote_range', 'other']).default('other'),
  requiresEvidence: z.boolean().default(true),
  allowsFree: z.boolean().default(false),
  allowsSample: z.boolean().default(false),
  allowsShipping: z.boolean().default(false),
  conditions: z.string().trim().max(500).optional(),
  enabled: z.boolean().default(true),
}).strict();

export const industryRuleSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  requiredPattern: z.string().trim().max(400).optional(),
  excludedPattern: z.string().trim().max(400).optional(),
  keywords: z.array(z.string().trim().min(2).max(80)).max(50).default([]),
  priority: z.number().int().min(-100).max(100).optional(),
}).strict();

export const guardrailRedlineSchema = z.object({
  id: z.string().trim().min(1).max(60),
  pattern: z.string().trim().min(1).max(350),
  message: z.string().trim().min(1).max(400),
  severity: z.enum(['bad', 'warn']).default('bad'),
  skipSegment: z.string().trim().max(20).optional(),
  enabled: z.boolean().default(true),
}).strict();

export const writingRuleSchema = z.object({
  id: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(500),
  enabled: z.boolean().default(true),
  source: z.string().trim().max(120).optional(),
}).strict();

export const brandProfileSchema = z.object({
  brandKey: z.enum(['genesis', 'ironhue', 'velaturo', 'general']).optional(),
  pricingMode: z.enum(['catalog_tiered', 'costing_approved']).optional(),
  guardrailRedlines: z.array(guardrailRedlineSchema).max(100).optional(),
  teamWritingRules: z.array(writingRuleSchema).max(100).optional(),
  approvedActions: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  approvedOffers: z.array(approvedOfferSchema).max(30).optional(),
  industryRules: z.array(industryRuleSchema).max(100).optional(),
  activeWritingVersion: z.string().trim().max(60).optional(),
  writingPausedReason: z.string().trim().max(300).optional(),
  logoPath: z.string().trim().max(500).nullable().optional(),
  defaultLetterSubject: z.string().trim().max(300).optional(),
  defaultLetterTemplate: z.string().max(20000).optional(),
  label: z.string().trim().max(200).optional(),
  identity: z.string().trim().max(500).optional(),
  offerSummary: z.string().trim().max(2000).optional(),
  outreachFocus: z.string().trim().max(1000).optional(),
  avoidTopics: z.string().trim().max(1000).optional(),
  insightLabel: z.string().trim().max(200).optional(),
  insightExamples: z.string().trim().max(2000).optional(),
  proofExamples: z.string().trim().max(3000).optional(),
  ctaExamples: z.string().trim().max(1000).optional(),
  subjectFocus: z.string().trim().max(300).optional(),
  signatureTitle: z.string().trim().max(300).optional(),
  signatureLines: z.array(z.string().trim().max(500)).max(12).optional(),
}).strict();

export const mailComplianceSchema = z.object({
  warmupEnabled: z.boolean(),
  warmupStartedAt: z.coerce.date().optional(),
  warmupStartLimit: z.number().int().min(1).max(5000),
  warmupDailyIncrement: z.number().int().min(1).max(1000),
  warmupMaxLimit: z.number().int().min(1).max(10000),
  dailySendLimit: z.number().int().min(1).max(10000),
  trackingEnabled: z.boolean().optional(),
}).strict();

const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]+$/).max(30),
  industry: z.string().trim().max(120).optional().default(''),
  companyName: z.string().trim().min(1).max(200),
  website: z.string().trim().max(300).optional().default(''),
  moq: z.string().trim().max(120).optional().default(''),
  senderName: z.string().trim().max(120).optional().default(''),
  mailFrom: z.string().trim().max(300).optional().default(''),
  mailProfileKey: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  /** 项目级真实发送开关；不传时沿用服务端配置 */
  mailTransport: z.enum(['mock', 'smtp']).optional(),
  // Browser-compressed data URL (<=600k chars) or an https URL; '' clears it.
  logoImage: z.string().max(600000).optional(),
  coverImage: z.string().max(600000).optional(),
  brandProfile: brandProfileSchema.optional(),
  mailCompliance: mailComplianceSchema.optional(),
};

export const createProjectSchema = z.object(projectFields);
export const updateProjectSchema = z.object({
  name: projectFields.name.optional(),
  industry: projectFields.industry,
  companyName: projectFields.companyName.optional(),
  website: projectFields.website,
  moq: projectFields.moq,
  senderName: projectFields.senderName,
  mailFrom: projectFields.mailFrom,
  mailProfileKey: projectFields.mailProfileKey.optional(),
  mailTransport: projectFields.mailTransport,
  logoImage: projectFields.logoImage,
  coverImage: projectFields.coverImage,
  brandProfile: projectFields.brandProfile,
  mailCompliance: projectFields.mailCompliance,
  status: z.enum(['active', 'archived']).optional(),
}).refine((value) => Object.keys(value).length > 0, '至少提供一个更新字段');

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
