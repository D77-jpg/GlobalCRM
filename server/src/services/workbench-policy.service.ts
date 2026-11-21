import { Types } from 'mongoose';
import { Project, ProjectPolicy, type IProjectPolicy, type ProjectPolicyCategory, type ProjectPolicyDocument } from '../models';
import type { ProjectGuardrailRedline, ProjectWritingRule } from '../models/Project';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { requireProjectId } from '../utils/access';
import {
  GENESIS_POLICY_PRESET,
  GENESIS_REDLINE_PRESET,
  GENERAL_POLICY_PRESET,
  GENERAL_REDLINE_PRESET,
} from './agent/workbench-presets';

export interface PolicyDto {
  id: string;
  code: string;
  topic: string;
  category: ProjectPolicyCategory;
  scope: string;
  valueZh: string;
  valueEn: string;
  external: boolean;
  confirmed: boolean;
  conflictNote: string;
  source: string;
  ownerRole: string;
  version: number;
  confirmedAt?: Date;
  updatedAt: Date;
}

export interface WorkbenchConfigDto {
  pricingMode: 'catalog_tiered' | 'costing_approved';
  brandKey: string;
  guardrailRedlines: ProjectGuardrailRedline[];
  teamWritingRules: ProjectWritingRule[];
}

function toPolicyDto(doc: ProjectPolicyDocument | (IProjectPolicy & { _id: Types.ObjectId })): PolicyDto {
  return {
    id: String(doc._id),
    code: doc.code,
    topic: doc.topic,
    category: doc.category,
    scope: doc.scope ?? '',
    valueZh: doc.valueZh,
    valueEn: doc.valueEn ?? '',
    external: Boolean(doc.external),
    confirmed: Boolean(doc.confirmed),
    conflictNote: doc.conflictNote ?? '',
    source: doc.source ?? '',
    ownerRole: doc.ownerRole ?? '',
    version: doc.version ?? 1,
    confirmedAt: doc.confirmedAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listProjectPolicies(
  actor: AuthUser,
  filters?: { category?: string; confirmed?: string; external?: string; search?: string },
): Promise<PolicyDto[]> {
  const projectId = requireProjectId(actor);
  const query: Record<string, unknown> = { projectId };
  if (filters?.category && filters.category !== 'all') query.category = filters.category;
  if (filters?.confirmed === 'true') query.confirmed = true;
  if (filters?.confirmed === 'false') query.confirmed = false;
  if (filters?.external === 'true') query.external = true;
  if (filters?.external === 'false') query.external = false;
  const rows = await ProjectPolicy.find(query).sort({ confirmed: 1, category: 1, code: 1 }).lean();
  const q = filters?.search?.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => [r.code, r.topic, r.valueZh, r.valueEn, r.scope, r.conflictNote].filter(Boolean).join(' ').toLowerCase().includes(q))
    : rows;
  return filtered.map((r) => toPolicyDto(r as IProjectPolicy & { _id: Types.ObjectId }));
}

export async function createProjectPolicy(
  input: {
    code: string;
    topic: string;
    category?: ProjectPolicyCategory;
    scope?: string;
    valueZh: string;
    valueEn?: string;
    external?: boolean;
    confirmed?: boolean;
    conflictNote?: string;
    source?: string;
    ownerRole?: string;
  },
  actor: AuthUser,
): Promise<PolicyDto> {
  const projectId = requireProjectId(actor);
  const code = input.code.trim().toUpperCase();
  const existing = await ProjectPolicy.findOne({ projectId, code });
  if (existing) throw ApiError.conflict(`口径编号 ${code} 已存在`);
  const doc = await ProjectPolicy.create({
    projectId,
    code,
    topic: input.topic.trim(),
    category: input.category ?? 'other',
    scope: input.scope?.trim() || undefined,
    valueZh: input.valueZh.trim(),
    valueEn: input.valueEn?.trim() ?? '',
    external: input.external ?? true,
    confirmed: input.confirmed ?? false,
    conflictNote: input.conflictNote?.trim() || undefined,
    source: input.source?.trim() || undefined,
    ownerRole: input.ownerRole?.trim() || 'Management',
    version: 1,
    updatedBy: new Types.ObjectId(actor.id),
    ...(input.confirmed ? { confirmedBy: new Types.ObjectId(actor.id), confirmedAt: new Date() } : {}),
  });
  return toPolicyDto(doc);
}

export async function updateProjectPolicy(
  id: string,
  input: Partial<{
    topic: string;
    category: ProjectPolicyCategory;
    scope: string;
    valueZh: string;
    valueEn: string;
    external: boolean;
    confirmed: boolean;
    conflictNote: string;
    source: string;
    ownerRole: string;
  }>,
  actor: AuthUser,
): Promise<PolicyDto> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('口径 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await ProjectPolicy.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('口径条目不存在');
  if (input.topic !== undefined) doc.topic = input.topic.trim();
  if (input.category !== undefined) doc.category = input.category;
  if (input.scope !== undefined) doc.scope = input.scope.trim();
  if (input.valueZh !== undefined) doc.valueZh = input.valueZh.trim();
  if (input.valueEn !== undefined) doc.valueEn = input.valueEn.trim();
  if (input.external !== undefined) doc.external = input.external;
  if (input.conflictNote !== undefined) doc.conflictNote = input.conflictNote.trim();
  if (input.source !== undefined) doc.source = input.source.trim();
  if (input.ownerRole !== undefined) doc.ownerRole = input.ownerRole.trim();
  if (input.confirmed !== undefined) {
    doc.confirmed = input.confirmed;
    if (input.confirmed) {
      doc.confirmedBy = new Types.ObjectId(actor.id);
      doc.confirmedAt = new Date();
    }
  }
  doc.version = (doc.version ?? 1) + 1;
  doc.updatedBy = new Types.ObjectId(actor.id);
  await doc.save();
  return toPolicyDto(doc);
}

export async function confirmProjectPolicy(id: string, actor: AuthUser): Promise<PolicyDto> {
  return updateProjectPolicy(id, { confirmed: true }, actor);
}

export async function deleteProjectPolicy(id: string, actor: AuthUser): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('口径 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const deleted = await ProjectPolicy.findOneAndDelete({ _id: id, projectId });
  if (!deleted) throw ApiError.notFound('口径条目不存在');
}

export async function getProjectWorkbenchConfig(actor: AuthUser): Promise<WorkbenchConfigDto> {
  const projectId = requireProjectId(actor);
  const project = await Project.findById(projectId).lean();
  if (!project) throw ApiError.notFound('项目不存在');
  const brandKey = project.brandProfile?.brandKey || (project.code?.toLowerCase().includes('gb') || project.name.toLowerCase().includes('genesis') ? 'genesis' : 'general');
  const defaultMode: 'catalog_tiered' | 'costing_approved' = brandKey === 'genesis' ? 'costing_approved' : 'catalog_tiered';
  return {
    pricingMode: project.brandProfile?.pricingMode ?? defaultMode,
    brandKey,
    guardrailRedlines: project.brandProfile?.guardrailRedlines ?? [],
    teamWritingRules: project.brandProfile?.teamWritingRules ?? [],
  };
}

export async function updateProjectWorkbenchConfig(
  input: Partial<{
    pricingMode: 'catalog_tiered' | 'costing_approved';
    guardrailRedlines: ProjectGuardrailRedline[];
    teamWritingRules: ProjectWritingRule[];
  }>,
  actor: AuthUser,
): Promise<WorkbenchConfigDto> {
  const projectId = requireProjectId(actor);
  const project = await Project.findById(projectId);
  if (!project) throw ApiError.notFound('项目不存在');
  const profile = project.brandProfile ?? {};
  if (input.pricingMode !== undefined) profile.pricingMode = input.pricingMode;
  if (input.guardrailRedlines !== undefined) {
    // Validate regex patterns safely before saving
    for (const rule of input.guardrailRedlines) {
      try {
        new RegExp(rule.pattern, 'i');
      } catch {
        throw ApiError.badRequest(`红线规则“${rule.id}”的正则表达式无效`);
      }
    }
    profile.guardrailRedlines = input.guardrailRedlines;
  }
  if (input.teamWritingRules !== undefined) {
    profile.teamWritingRules = input.teamWritingRules;
  }
  project.brandProfile = profile;
  project.markModified('brandProfile');
  await project.save();
  return getProjectWorkbenchConfig(actor);
}

export async function seedWorkbenchPreset(
  preset: 'genesis' | 'general',
  actor: AuthUser,
): Promise<{ policiesInserted: number; policiesSkipped: number; redlinesAdded: number; pricingMode: 'catalog_tiered' | 'costing_approved' }> {
  const projectId = requireProjectId(actor);
  const policyList = preset === 'genesis' ? GENESIS_POLICY_PRESET : GENERAL_POLICY_PRESET;
  const redlineList = preset === 'genesis' ? GENESIS_REDLINE_PRESET : GENERAL_REDLINE_PRESET;

  const existingCodes = new Set(
    (await ProjectPolicy.find({ projectId }).select('code').lean()).map((p) => p.code.toUpperCase()),
  );
  let policiesInserted = 0;
  let policiesSkipped = 0;
  for (const item of policyList) {
    const code = item.code.toUpperCase();
    if (existingCodes.has(code)) {
      policiesSkipped += 1;
      continue;
    }
    await ProjectPolicy.create({
      projectId,
      code,
      topic: item.topic,
      category: item.category,
      scope: item.scope,
      valueZh: item.valueZh,
      valueEn: item.valueEn,
      external: item.external,
      confirmed: item.confirmed,
      conflictNote: item.conflictNote,
      source: item.source,
      ownerRole: item.ownerRole,
      version: 1,
      updatedBy: new Types.ObjectId(actor.id),
      ...(item.confirmed ? { confirmedBy: new Types.ObjectId(actor.id), confirmedAt: new Date() } : {}),
    });
    policiesInserted += 1;
  }

  const project = await Project.findById(projectId);
  let redlinesAdded = 0;
  const targetPricingMode: 'catalog_tiered' | 'costing_approved' = preset === 'genesis' ? 'costing_approved' : 'catalog_tiered';
  if (project) {
    const profile = project.brandProfile ?? {};
    const existingRedlines = profile.guardrailRedlines ?? [];
    const existingIds = new Set(existingRedlines.map((r) => r.id));
    const merged = [...existingRedlines];
    for (const r of redlineList) {
      if (!existingIds.has(r.id)) {
        merged.push(r);
        redlinesAdded += 1;
      }
    }
    profile.guardrailRedlines = merged;
    if (!profile.pricingMode) profile.pricingMode = targetPricingMode;
    project.brandProfile = profile;
    project.markModified('brandProfile');
    await project.save();
  }

  return {
    policiesInserted,
    policiesSkipped,
    redlinesAdded,
    pricingMode: project?.brandProfile?.pricingMode ?? targetPricingMode,
  };
}
