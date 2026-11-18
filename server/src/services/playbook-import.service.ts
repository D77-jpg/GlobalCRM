import mongoose,{Types} from 'mongoose';
import { createHash } from 'node:crypto';
import {z} from 'zod';
import {Project,ProjectPlaybook} from '../models';
import {ApiError} from '../utils/ApiError';
import {requireProjectId} from '../utils/access';
import {resolveProjectSalesProfile,type ProjectLike} from './project-profile';
import {getBuiltinPlaybook} from './agent/outreach-playbook';
import type {AuthUser} from '../types/express';
import type {PlaybookCardData} from './agent/genesis-playbook.data';
import type { BrandPackageRevision } from '../models/ProjectPlaybook';
import { brandProfileSchema } from '../validators/project.validator';

const cardSchema=z.object({
  id:z.string().trim().min(1).max(40),
  kind:z.enum(['segment','preference']),
  name:z.string().trim().min(1).max(200),
  signals:z.string().trim().max(2000).default(''),
  products:z.string().trim().max(2000).default(''),
  logic:z.string().trim().max(3000).default(''),
  avoid:z.string().trim().max(3000).default(''),
  cta:z.string().trim().max(1000).default(''),
  prepare:z.string().trim().max(2000).default(''),
  check:z.string().trim().max(3000).default(''),
  subjects:z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  keywords:z.array(z.string().trim().min(2).max(80)).max(50).default([]),
}).strict();

export const playbookImportInput=z.object({
  cards:z.array(cardSchema).min(1,'至少导入一张卡').max(200,'单次最多导入 200 张卡'),
}).strict().superRefine((value,ctx)=>{
  const ids=new Set<string>();
  value.cards.forEach((card,index)=>{
    if(ids.has(card.id))ctx.addIssue({code:'custom',path:['cards',index,'id'],message:'卡片 ID 不能重复'});
    ids.add(card.id);
  });
});

export type PlaybookImportInput=z.input<typeof playbookImportInput>;

const brandKey = z.enum(['genesis', 'ironhue', 'velaturo', 'general']);
export const brandPackageInput = z.object({
  schemaVersion: z.literal(1),
  release: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/),
  profile: brandProfileSchema.extend({ brandKey,
    approvedActions: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
    signatureLines: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  }).required({ label: true, identity: true, offerSummary: true, outreachFocus: true, avoidTopics: true,
    insightLabel: true, insightExamples: true, proofExamples: true, ctaExamples: true, subjectFocus: true, signatureTitle: true }),
  playbook: playbookImportInput,
}).strict();
export const applyBrandPackageInput = z.object({ bundle: brandPackageInput, expectedVersion: z.number().int().nonnegative() }).strict();

function requireAdmin(actor:AuthUser){if(actor.role!=='admin')throw ApiError.forbidden('行业卡由项目管理员导入和维护');}

function toCard(input:z.infer<typeof cardSchema>):PlaybookCardData{
  return {
    id:input.id,name:input.name,signals:input.signals,products:input.products,logic:input.logic,avoid:input.avoid,
    cta:input.cta,prepare:input.prepare,check:input.check,subjects:input.subjects,keywords:input.keywords,
  };
}

function packRevision(data: Omit<BrandPackageRevision, 'digest'>): BrandPackageRevision {
  return { ...data, digest: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

export function builtinBrandPackage(key: 'genesis' | 'ironhue' | 'velaturo') {
  const { signature, key: profileKey, ...profile } = resolveProjectSalesProfile({ brandProfile: { brandKey: key } });
  const cards = getBuiltinPlaybook(key)!;
  return brandPackageInput.parse({ schemaVersion: 1, release: 'legacy-1.0.0',
    profile: { ...profile, brandKey: profileKey, signatureTitle: signature.title, signatureLines: signature.lines },
    playbook: { cards: [...cards.segments.map(card => ({ ...card, kind: 'segment' })),
      ...cards.preferences.map(card => ({ ...card, kind: 'preference' }))] },
  });
}

async function brandPackageScope(actor: AuthUser) {
  requireAdmin(actor);
  const projectId = requireProjectId(actor);
  const project = await Project.findOne({ _id: projectId, status: 'active' }).select('organizationId brandProfile slug code name companyName industry').lean();
  if (!project?.organizationId || (actor.organizationId && actor.organizationId !== String(project.organizationId))) {
    throw ApiError.notFound('项目不存在或无权访问');
  }
  return { project, filter: { projectId, organizationId: project.organizationId } };
}

export async function previewBrandPackage(input: unknown, actor: AuthUser) {
  const { project, filter } = await brandPackageScope(actor);
  const bundle = brandPackageInput.parse(input);
  const current = await ProjectPlaybook.findOne(filter).select('+activePackage').lean();
  return { projectName: project.name, expectedVersion: current?.version ?? 0, release: bundle.release,
    currentRelease: current?.activePackage?.release ?? null, brandKey: bundle.profile.brandKey,
    signatureTitle: bundle.profile.signatureTitle ?? null, cardCount: bundle.playbook.cards.length };
}

export async function applyBrandPackage(input: unknown, actor: AuthUser) {
  const { project, filter } = await brandPackageScope(actor);
  const { bundle, expectedVersion } = applyBrandPackageInput.parse(input);
  const revision = packRevision({ release: bundle.release, profile: bundle.profile,
    segments: bundle.playbook.cards.filter(card => card.kind === 'segment').map(toCard),
    preferences: bundle.playbook.cards.filter(card => card.kind === 'preference').map(toCard) });
  return mongoose.connection.transaction(async session => {
    const current = await ProjectPlaybook.findOne(filter).select('+activePackage +previousPackage').session(session);
    if (current?.activePackage?.digest === revision.digest) return { version: current.version, release: revision.release, unchanged: true };
    if (current?.activePackage?.release === revision.release) throw ApiError.conflict('同一个品牌版本对应不同内容，请使用新的版本号');
    if ((current?.version ?? 0) !== expectedVersion) throw ApiError.conflict('项目资料已变化，请重新预览品牌包');
    const legacyProfile = resolveProjectSalesProfile(project);
    const legacyCards = getBuiltinPlaybook(legacyProfile.key);
    const previous = current?.activePackage ?? packRevision({ release: 'legacy', profile: project.brandProfile ?? {},
      segments: current?.segments ?? legacyCards?.segments ?? [], preferences: current?.preferences ?? legacyCards?.preferences ?? [] });
    const result = await Project.updateOne({ _id: project._id, organizationId: filter.organizationId, status: 'active' }, { $set: { brandProfile: revision.profile } }, { session, runValidators: true });
    if (!result.matchedCount) throw ApiError.conflict('项目在导入期间发生变化');
    const updated = await ProjectPlaybook.findOneAndUpdate(filter, {
      $set: { activePackage: revision, previousPackage: previous, segments: revision.segments, preferences: revision.preferences, updatedBy: actor.id },
      $setOnInsert: filter, $inc: { version: 1 },
    }, { upsert: true, new: true, session, setDefaultsOnInsert: false });
    return { version: updated.version, release: revision.release, unchanged: false };
  });
}

export async function rollbackBrandPackage(expectedVersion: number, actor: AuthUser) {
  const { project, filter } = await brandPackageScope(actor);
  return mongoose.connection.transaction(async session => {
    const current = await ProjectPlaybook.findOne({ ...filter, version: expectedVersion }).select('+activePackage +previousPackage').session(session);
    const previous = current?.previousPackage;
    if (!current || !previous) throw ApiError.conflict('项目资料已变化或没有可回退版本');
    const result = await Project.updateOne({ _id: project._id, organizationId: filter.organizationId, status: 'active' }, { $set: { brandProfile: previous.profile } }, { session, runValidators: true });
    if (!result.matchedCount) throw ApiError.conflict('项目在回退期间发生变化');
    const updated = await ProjectPlaybook.findOneAndUpdate({ ...filter, version: expectedVersion }, {
      $set: { activePackage: previous, segments: previous.segments, preferences: previous.preferences, updatedBy: actor.id },
      $unset: { previousPackage: 1 }, $inc: { version: 1 },
    }, { new: true, session });
    if (!updated) throw ApiError.conflict('项目资料已变化，请刷新后重试');
    return { version: updated.version, release: previous.release };
  });
}

export async function getProjectPlaybook(actor:AuthUser){
  requireAdmin(actor);const projectId=requireProjectId(actor);
  const project=await Project.findById(projectId).select('code slug name companyName industry brandProfile').lean();
  const profile=resolveProjectSalesProfile(project as unknown as ProjectLike);
  const doc=await ProjectPlaybook.findOne({projectId:new Types.ObjectId(projectId)}).select('+activePackage +previousPackage').lean();
  if(doc)return {
    id:String(doc._id),version:doc.version,segments:doc.segments??[],preferences:doc.preferences??[],
    updatedAt:doc.updatedAt,source:'imported' as const,projectKey:profile.key,projectLabel:profile.label,
    ...(doc.activePackage ? { brandRelease: doc.activePackage.release, canRollback: Boolean(doc.previousPackage) } : {}),
  };
  const builtin=getBuiltinPlaybook(profile.key);
  return {
    version:0,segments:builtin?.segments??[],preferences:builtin?.preferences??[],
    updatedAt:null,source:'builtin' as const,projectKey:profile.key,projectLabel:profile.label,
  };
}

export async function importProjectPlaybook(input:PlaybookImportInput,actor:AuthUser){
  requireAdmin(actor);const projectId=requireProjectId(actor);
  const parsed=playbookImportInput.parse(input);
  const segments=parsed.cards.filter(card=>card.kind==='segment').map(toCard);
  const preferences=parsed.cards.filter(card=>card.kind==='preference').map(toCard);
  const existing=await ProjectPlaybook.findOne({projectId:new Types.ObjectId(projectId)}).select('+activePackage');
  if(existing?.activePackage)throw ApiError.conflict('本项目使用版本化品牌包，请通过品牌包更新卡片');
  const doc=existing??new ProjectPlaybook({projectId:new Types.ObjectId(projectId),version:0});
  doc.version+=1;doc.segments=segments;doc.preferences=preferences;doc.updatedBy=new Types.ObjectId(actor.id);
  await doc.save();
  return {version:doc.version,segments:doc.segments.length,preferences:doc.preferences.length,updatedAt:doc.updatedAt};
}

export async function loadImportedPlaybook(projectId:string|undefined){
  if(!projectId)return undefined;
  const doc=await ProjectPlaybook.findOne({projectId:new Types.ObjectId(projectId)}).lean();
  if(!doc||(!doc.segments?.length&&!doc.preferences?.length))return undefined;
  return {segments:(doc.segments??[]) as PlaybookCardData[],preferences:(doc.preferences??[]) as PlaybookCardData[],revision:doc.version};
}

export async function clearProjectPlaybook(actor:AuthUser){
  requireAdmin(actor);const projectId=requireProjectId(actor);
  if(await ProjectPlaybook.exists({projectId,activePackage:{$exists:true}}))throw ApiError.conflict('请通过品牌包回退恢复上一版本');
  await ProjectPlaybook.deleteOne({projectId:new Types.ObjectId(projectId)});
  return {cleared:true};
}
