import { Types } from 'mongoose';
import zlib from 'node:zlib';
import {
  Customer,
  CustomerWorkbenchItem,
  Project,
  ProjectPolicy,
  Quotation,
  type CommitmentGrade,
  type CustomerWorkbenchItemDocument,
  type ICustomerWorkbenchItem,
  type WorkbenchItemKind,
  type WorkbenchItemStatus,
  type WorkbenchOwnerRole,
} from '../models';
import { AgentKnowledge } from '../models/AgentKnowledge';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { customerRefScope, requireProjectId } from '../utils/access';
import { getCustomerByIdOrThrow } from './customer.service';
import { activeProducts, type ProductDto } from './product.service';
import { resolveAgentProvider } from './agent/ai-settings.service';
import { AgentProviderError } from './agent/provider';
import { translateLetter } from './agent/translation.service';
import { appendKnowledge, revisionActive } from './agent/knowledge.service';
import { getProjectWorkbenchConfig, updateProjectWorkbenchConfig } from './workbench-policy.service';
import {
  composeDeterministicKbReply,
  detectScamSignals,
  runDeterministicGuard,
  scoreWorkbenchReply,
  stripQuotedReplyHistory,
  type ApprovedQuoteRecord,
  type DeterministicGuardContext,
  type GuardCheckItem,
  type ReplyScoreResult,
  type WorkbenchReplyScenario,
} from './agent/deterministic-guard.service';
import type { KnowledgeCategory } from './agent/knowledge-types';

export interface WorkbenchItemDto {
  id: string;
  customerId: string;
  kind: WorkbenchItemKind;
  status: WorkbenchItemStatus;
  title: string;
  quote?: string;
  handling?: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED';
  grade?: CommitmentGrade;
  ownerRole: WorkbenchOwnerRole;
  dueAt?: Date;
  resultNote?: string;
  sourceMailId?: string;
  sourceAnalysisId?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

function toItemDto(doc: CustomerWorkbenchItemDocument | (ICustomerWorkbenchItem & { _id: Types.ObjectId })): WorkbenchItemDto {
  return {
    id: String(doc._id),
    customerId: String(doc.customerId),
    kind: doc.kind,
    status: doc.status,
    title: doc.title,
    quote: doc.quote,
    handling: doc.handling,
    grade: doc.grade,
    ownerRole: doc.ownerRole,
    dueAt: doc.dueAt,
    resultNote: doc.resultNote,
    sourceMailId: doc.sourceMailId,
    sourceAnalysisId: doc.sourceAnalysisId,
    resolvedAt: doc.resolvedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listCustomerWorkbenchItems(
  actor: AuthUser,
  filters?: { customerId?: string; kind?: WorkbenchItemKind; status?: WorkbenchItemStatus },
): Promise<WorkbenchItemDto[]> {
  const projectId = requireProjectId(actor);
  const query: Record<string, unknown> = { projectId };
  if (filters?.customerId) {
    if (!Types.ObjectId.isValid(filters.customerId)) throw ApiError.badRequest('客户 ID 格式不正确');
    await getCustomerByIdOrThrow(filters.customerId, actor);
    query.customerId = new Types.ObjectId(filters.customerId);
  } else {
    Object.assign(query, await customerRefScope(actor));
  }
  if (filters?.kind) query.kind = filters.kind;
  if (filters?.status) query.status = filters.status;
  const rows = await CustomerWorkbenchItem.find(query).sort({ status: 1, dueAt: 1, createdAt: -1 }).limit(200).lean();
  return rows.map((r) => toItemDto(r as ICustomerWorkbenchItem & { _id: Types.ObjectId }));
}

export async function createCustomerWorkbenchItem(
  input: {
    customerId: string;
    kind: WorkbenchItemKind;
    title: string;
    quote?: string;
    handling?: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED';
    grade?: CommitmentGrade;
    ownerRole?: WorkbenchOwnerRole;
    dueAt?: Date;
    resultNote?: string;
    sourceMailId?: string;
    sourceAnalysisId?: string;
  },
  actor: AuthUser,
): Promise<WorkbenchItemDto> {
  if (!Types.ObjectId.isValid(input.customerId)) throw ApiError.badRequest('客户 ID 格式不正确');
  await getCustomerByIdOrThrow(input.customerId, actor);
  const projectId = requireProjectId(actor);
  const doc = await CustomerWorkbenchItem.create({
    projectId,
    customerId: new Types.ObjectId(input.customerId),
    kind: input.kind,
    status: input.resultNote?.trim() ? 'result_ready' : 'open',
    title: input.title.trim(),
    quote: input.quote?.trim() || undefined,
    handling: input.handling,
    grade: input.grade,
    ownerRole: input.ownerRole ?? 'Sales',
    dueAt: input.dueAt,
    resultNote: input.resultNote?.trim() || undefined,
    sourceMailId: input.sourceMailId?.trim() || undefined,
    sourceAnalysisId: input.sourceAnalysisId?.trim() || undefined,
    createdBy: new Types.ObjectId(actor.id),
  });
  return toItemDto(doc);
}

export async function updateCustomerWorkbenchItem(
  id: string,
  input: Partial<{
    status: WorkbenchItemStatus;
    title: string;
    ownerRole: WorkbenchOwnerRole;
    dueAt: Date | null;
    resultNote: string;
    grade: CommitmentGrade;
  }>,
  actor: AuthUser,
): Promise<WorkbenchItemDto> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('条目 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerWorkbenchItem.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('工作台条目不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  if (input.title !== undefined) doc.title = input.title.trim();
  if (input.ownerRole !== undefined) doc.ownerRole = input.ownerRole;
  if (input.grade !== undefined) doc.grade = input.grade;
  if (input.dueAt !== undefined) doc.dueAt = input.dueAt ?? undefined;
  if (input.resultNote !== undefined) {
    doc.resultNote = input.resultNote.trim();
    if (doc.resultNote && doc.status === 'open' && !input.status) {
      doc.status = 'result_ready';
    }
  }
  if (input.status !== undefined) {
    doc.status = input.status;
    if (input.status === 'resolved') {
      doc.resolvedBy = new Types.ObjectId(actor.id);
      doc.resolvedAt = new Date();
    } else if (input.status === 'open') {
      doc.resolvedBy = undefined;
      doc.resolvedAt = undefined;
    }
  }
  await doc.save();
  return toItemDto(doc);
}

export async function deleteCustomerWorkbenchItem(id: string, actor: AuthUser): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('条目 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerWorkbenchItem.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('工作台条目不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  await doc.deleteOne();
}

async function buildGuardContextForProject(
  actor: AuthUser,
  params: {
    customerId?: string;
    inboundText?: string;
    threadText?: string;
    contactName?: string;
    attachedOutFiles?: string[];
    channel?: DeterministicGuardContext['channel'];
    complaintLevel?: DeterministicGuardContext['complaintLevel'];
    threadSubject?: string;
    destination?: string;
    scenario?: WorkbenchReplyScenario;
    isOngoingThread?: boolean;
  },
): Promise<{
  ctx: DeterministicGuardContext;
  policiesText: string;
  approvedQuotesText: string;
  writingRulesText: string;
  signatureText: string;
}> {
  const projectId = requireProjectId(actor);
  const [project, policies, wbConfig] = await Promise.all([
    Project.findById(projectId).lean(),
    ProjectPolicy.find({ projectId }).sort({ code: 1 }).lean(),
    getProjectWorkbenchConfig(actor),
  ]);

  let contactName = params.contactName;
  const approvedQuotes: ApprovedQuoteRecord[] = [];
  if (params.customerId && Types.ObjectId.isValid(params.customerId)) {
    await getCustomerByIdOrThrow(params.customerId, actor);
    const [customer, quotations] = await Promise.all([
      Customer.findById(params.customerId).select('name company country').lean(),
      Quotation.find({ projectId, customerId: new Types.ObjectId(params.customerId) }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    if (customer && !contactName) contactName = customer.name;
    const now = Date.now();
    for (const q of quotations) {
      const expired = Boolean(q.validityDate && new Date(q.validityDate).getTime() < now);
      const external = q.status !== 'rejected' && q.approvalStatus !== 'rejected';
      approvedQuotes.push({
        quotationNo: q.quotationNo,
        external,
        expired,
        content: q.notes || '',
        lines: q.items.map((item) => ({
          item: item.productName,
          qty: item.quantity,
          price: item.unitPrice,
          currency: q.currency,
          status: item.pricingStatus === 'pending' ? 'pending' : 'approved',
        })),
      });
    }
  }

  const sigLines = project?.brandProfile?.signatureLines?.length
    ? project.brandProfile.signatureLines
    : [project?.companyName || 'Sales Team', project?.website || ''].filter(Boolean);
  const signatureText = `Best regards,\n${sigLines.join('\n')}`;

  const ctx: DeterministicGuardContext = {
    brandKey: wbConfig.brandKey,
    policies,
    redlines: wbConfig.guardrailRedlines,
    approvedQuotes,
    inboundText: params.inboundText,
    threadText: params.threadText,
    contactName,
    attachedOutFiles: params.attachedOutFiles,
    channel: params.channel ?? 'email',
    complaintLevel: params.complaintLevel ?? '',
    threadSubject: params.threadSubject,
    signatureText,
    lang: 'en',
    destination: params.destination,
    scenario: params.scenario,
    isOngoingThread: params.isOngoingThread,
  };

  const policiesText = policies.map((p) =>
    `- [${p.code}] ${p.topic}｜可对外：${p.external ? '是' : '否'}｜适用：${p.scope || '通用'}\n  中文：${p.valueZh}${p.external && p.valueEn ? `\n  英文标准口径：${p.valueEn}` : ''}`,
  ).join('\n');

  const approvedQuotesText = approvedQuotes.length > 0
    ? approvedQuotes.map((q) => {
      const tag = q.expired ? '已过期(仅参考不可沿用)' : q.external ? '已批准可对外' : '仅内部';
      const lines = (q.lines ?? []).map((l) => `  · ${l.item} | qty ${l.qty} | ${l.status === 'pending' ? '待报' : `${l.currency || 'USD'} ${l.price}`}`).join('\n');
      return `- ${q.quotationNo || 'QUOTE'} (${tag})\n${lines}`;
    }).join('\n')
    : '（无已批准报价单，严禁在正文中编造任何金额）';

  const writingRulesText = wbConfig.teamWritingRules
    .filter((r) => r.enabled)
    .map((r) => `- ${r.text}`)
    .join('\n');

  return { ctx, policiesText, approvedQuotesText, writingRulesText, signatureText };
}

function cleanInboundText(raw: string): string {
  return String(raw || '')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJsonObjectFromText<T>(raw: string): T | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? '';
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const sliced = first >= 0 && last > first ? text.slice(first, last + 1) : '';
  for (const candidate of [text, fenced, sliced]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

const WORKBENCH_ITEM_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'zh'],
  properties: {
    body: { type: 'string' },
    zh: { type: 'string' },
  },
} as const;

const WORKBENCH_MULTICHANNEL_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'reply', 'reply_short', 'intent_zh', 'summary_zh', 'missing', 'requests', 'commitments'],
  properties: {
    subject: { type: 'string' },
    reply: { type: 'string' },
    reply_short: { type: 'string' },
    intent_zh: { type: 'string' },
    summary_zh: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'zh', 'handling', 'ownerRole'],
        properties: {
          text: { type: 'string' },
          zh: { type: 'string' },
          handling: { type: 'string', enum: ['ANSWERED', 'ASKED', 'CHECKING', 'NOTED', 'DECLINED'] },
          ownerRole: { type: 'string', enum: ['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management'] },
        },
      },
    },
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'grade', 'ownerRole', 'zh'],
        properties: {
          quote: { type: 'string' },
          grade: { type: 'string', enum: ['A', 'B', 'C'] },
          ownerRole: { type: 'string', enum: ['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management'] },
          zh: { type: 'string' },
        },
      },
    },
  },
} as const;

const WORKBENCH_AUTO_REVISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'reply', 'reply_short', 'changes_zh'],
  properties: {
    subject: { type: 'string' },
    reply: { type: 'string' },
    reply_short: { type: 'string' },
    changes_zh: { type: 'array', items: { type: 'string' } },
  },
} as const;

const WORKBENCH_TONE_REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'zh'],
  properties: {
    body: { type: 'string' },
    zh: { type: 'string' },
  },
} as const;

const WORKBENCH_LEARN_EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary_zh', 'items'],
  properties: {
    summary_zh: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text', 'why'],
        properties: {
          type: { type: 'string', enum: ['writing_rule', 'policy_change', 'exemplar'] },
          text: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function draftUpdateForWorkbenchItem(id: string, actor: AuthUser): Promise<{
  itemId: string;
  body: string;
  zh: string;
  guards: GuardCheckItem[];
}> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('条目 ID 格式不正确');
  const projectId = requireProjectId(actor);
  const item = await CustomerWorkbenchItem.findOne({ _id: id, projectId });
  if (!item) throw ApiError.notFound('工作台条目不存在');
  await getCustomerByIdOrThrow(String(item.customerId), actor);
  if (!item.resultNote?.trim()) {
    throw ApiError.badRequest('请先填写内部核实结果，再起草给买家的更新');
  }

  const { ctx, policiesText, approvedQuotesText, signatureText } = await buildGuardContextForProject(actor, {
    customerId: String(item.customerId),
    inboundText: `${item.title}\n${item.quote || ''}\n${item.resultNote}`,
  });

  const provider = await resolveAgentProvider();
  let body = '';
  let zh = '';

  if (provider.isAvailable() && provider.name !== 'mock') {
    try {
      const turn = await provider.createTurn({
        instructions: [
          '你是资深外贸业务员。内部团队已核实完买家的待确认事项，请起草一条简明、专业的英文更新邮件给买家。',
          '严禁泄露内部成本、其他客户信息、口径编号或部门名称；数字与条款只能来自已批准报价或对外口径。',
          '只输出 JSON：{"body":"英文更新正文（含称呼和给定签名）","zh":"中文意思给业务员核对"}',
        ].join('\n'),
        input: [{
          role: 'user',
          content: [
            `待核实事项：${item.title}`,
            item.quote ? `原话：${item.quote}` : '',
            `内部核实结果：${item.resultNote}`,
            `【对外口径】\n${policiesText || '（无）'}`,
            `【已批准报价】\n${approvedQuotesText}`,
            `【结尾签名（原样保留）】\n${signatureText}`,
          ].filter(Boolean).join('\n\n'),
        }],
        tools: [],
        outputFormat: { type: 'json_schema', name: 'workbench_item_update', strict: true, schema: WORKBENCH_ITEM_UPDATE_SCHEMA as unknown as Record<string, unknown> },
        context: { type: 'customer', resourceId: String(item.customerId) },
        userPrompt: '生成英文更新草稿及中文对照 JSON',
        safetyIdentifier: 'workbench-item-update',
      });
      const parsed = parseJsonObjectFromText<{ body?: string; zh?: string }>(turn.text);
      if (parsed) {
        body = String(parsed.body ?? '').trim();
        zh = String(parsed.zh ?? '').trim();
      }
    } catch {
      // fallback below
    }
  }

  if (!body) {
    const first = ctx.contactName?.trim().split(/\s+/)[0];
    body = [
      first ? `Hi ${first},` : 'Hello,',
      '',
      `Following up on "${item.title}", our team has confirmed the details below:`,
      item.resultNote,
      '',
      'Please let us know if you would like us to proceed with the next step based on this.',
      '',
      signatureText,
    ].join('\n');
    zh = `关于「${item.title}」，我方已完成核实：${item.resultNote}。请确认是否据此推进下一步。`;
  }

  const guards = runDeterministicGuard('Update on your inquiry', body, ctx);
  return { itemId: String(item._id), body, zh, guards };
}

export interface MultiChannelDraftResult {
  scamSignals: string[];
  drafts: {
    K: { subject: string; body: string; score: ReplyScoreResult };
    B: { subject: string; body: string; score: ReplyScoreResult };
    A: { subject: string; body: string; score: ReplyScoreResult };
  };
  duelWinner: 'K' | 'B' | 'A';
  revisedDiff?: { before: string; problems: string[]; changesZh: string[] };
  analysis: {
    intentZh: string;
    summaryZh: string;
    openQuestions: { text: string; zh: string; handling: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED'; ownerRole: WorkbenchOwnerRole }[];
    commitments: { quote: string; grade: CommitmentGrade; ownerRole: WorkbenchOwnerRole; zh: string }[];
    missingInfo: string[];
    preSendChecklist: { label: string; value: string; severity: 'ok' | 'warn' | 'bad' }[];
    knowledgeRefs?: { kind: 'policy' | 'knowledge' | 'product'; title: string; snippet: string }[];
    policyCount?: number;
  };
  usedAi: boolean;
  aiFallbackReason?: string;
}

const SCENARIO_DIRECTIVES: Record<WorkbenchReplyScenario, string> = {
  auto: '根据【历史往来】和【当前来信】自动判断邮件所处阶段（首次询盘、报价跟进、打样与图稿确认、大货与物流同步、议价、售后客诉、日常确认等）。若是多轮往来（含 Re: 或历史记录），自然承接上下文，绝不把老会话写成首次询盘客套，也不硬要无关的尺寸/报价参数。',
  inquiry: '场景：首次询盘与报价响应。逐项回应客户规格/MOQ/交期/工艺疑问，缺失报价关键参数时礼貌一次性问清。',
  followup: '场景：常规跟进与推进。自然承接历史往来，推进下一步决策或礼貌了解反馈，不重复自我介绍。',
  sample_artwork: '场景：样品、打样与图稿工艺确认。聚焦打样细节、色号/材质/版面修改与确认节点。',
  order_logistics: '场景：大货生产、出货与物流跟进。聚焦排产进度、质检、单证、船期/快递追踪与收货确认。',
  complaint: '场景：售后与客诉处理。先冷静共情、核实事实与证据（照片/批次/受损数量），不仓促认责或承诺未经批准的退款/补发。',
  acknowledgement: '场景：简短确认与礼貌致谢。干练确认已收到信息并告知我方下一步动作，不做多余展开。',
};

const SCENARIO_DEFAULT_INTENT: Record<WorkbenchReplyScenario, string> = {
  auto: '常规业务邮件回复与上下文跟进',
  inquiry: '客户新询盘与报价条件咨询',
  followup: '多轮业务跟进与下一步推进',
  sample_artwork: '样品打样与图稿工艺确认',
  order_logistics: '大货排产与出货物流同步',
  complaint: '售后反馈与客诉核实处理',
  acknowledgement: '已收到信息确认与简短致谢',
};

export async function draftMultiChannelInquiry(
  input: {
    customerId?: string;
    channel?: DeterministicGuardContext['channel'];
    scenario?: WorkbenchReplyScenario;
    subject?: string;
    inboundText: string;
    threadText?: string;
    contactName?: string;
    attachedOutFiles?: string[];
    inboundAttachments?: { name: string; status: 'read' | 'partial' | 'binary' | 'unread'; text?: string; note?: string }[];
    instruction?: string;
    complaintLevel?: DeterministicGuardContext['complaintLevel'];
    destination?: string;
  },
  actor: AuthUser,
): Promise<MultiChannelDraftResult> {
  const scenario: WorkbenchReplyScenario = input.scenario ?? 'auto';
  const cleanedInbound = cleanInboundText(input.inboundText);
  const latestInbound = stripQuotedReplyHistory(cleanedInbound);
  const cleanedThread = input.threadText ? cleanInboundText(input.threadText) : undefined;
  const isOngoingThread = /^(?:re|fw|fwd|回复|答复)\s*[:：]/i.test((input.subject || '').trim())
    || Boolean(cleanedThread && cleanedThread.includes('Us:') && cleanedThread.includes('Buyer:'))
    || cleanedInbound.length - latestInbound.length > 160;
  const attReadText = (input.inboundAttachments ?? [])
    .filter((a) => a.status === 'read' && a.text)
    .map((a) => `[附件 ${a.name}（已读）]\n${a.text!.slice(0, 6000)}`)
    .join('\n\n');
  const combinedInbound = [latestInbound, attReadText].filter(Boolean).join('\n\n');
  const fullContextThread = cleanedThread || (cleanedInbound.length > latestInbound.length ? cleanedInbound : undefined);

  const { ctx, policiesText, approvedQuotesText, writingRulesText, signatureText } = await buildGuardContextForProject(actor, {
    customerId: input.customerId,
    inboundText: combinedInbound,
    threadText: fullContextThread,
    contactName: input.contactName,
    attachedOutFiles: input.attachedOutFiles,
    channel: input.channel ?? 'email',
    complaintLevel: input.complaintLevel,
    threadSubject: input.subject,
    destination: input.destination,
    scenario,
    isOngoingThread,
  });

  // Retrieve top-matched published Knowledge docs + active Product catalog SKUs for grounded replies
  const projectId = requireProjectId(actor);
  const queryTerms = [...new Set(
    `${input.subject || ''} ${latestInbound}`.toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((t) => t.length >= 3 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'our', 'please', 'thanks', 'thank', 'hello', 'dear', 'regards', 'best'].includes(t)),
  )].slice(0, 30);

  const [publishedDocs, catalogProducts] = await Promise.all([
    AgentKnowledge.find({ projectId, archived: false, approvedVersion: { $gt: 0 } }).sort({ updatedAt: -1 }).limit(120).lean(),
    activeProducts(actor),
  ]);

  const termHits = (haystack: string): number => {
    if (queryTerms.length === 0) return 0;
    const lower = haystack.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) if (lower.includes(term)) hits += 1;
    return hits;
  };

  const matchedKnowledge = publishedDocs
    .map((doc) => {
      const rev = doc.revisions.find((r) => r.version === doc.approvedVersion);
      if (!rev || !revisionActive(rev) || (actor.role !== 'admin' && rev.accessScope === 'admins')) return null;
      const hits = termHits(`${rev.title} ${rev.category} ${(rev.tags ?? []).join(' ')} ${(rev.products ?? []).join(' ')} ${rev.content}`);
      if (hits <= 0) return null;
      return { title: rev.title, category: rev.category || 'reference', hits, snippet: rev.content.slice(0, 420) };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4);

  const matchedProducts = catalogProducts
    .map((prod) => ({
      prod,
      hits: termHits(`${prod.sku} ${prod.name} ${prod.category || ''} ${prod.description || ''} ${prod.specs.map((s) => `${s.name} ${s.value}`).join(' ')}`),
    }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.prod);

  const matchedPolicies = (ctx.policies ?? [])
    .filter((p) => p.external)
    .map((p) => ({ p, hits: termHits(`${p.code} ${p.topic} ${p.valueZh} ${p.valueEn}`) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4)
    .map((x) => x.p);

  const knowledgeRefs: NonNullable<MultiChannelDraftResult['analysis']['knowledgeRefs']> = [
    ...matchedPolicies.map((p) => ({ kind: 'policy' as const, title: `[${p.code}] ${p.topic}`, snippet: p.valueEn || p.valueZh })),
    ...matchedProducts.map((p) => ({
      kind: 'product' as const,
      title: `${p.sku} · ${p.name}`,
      snippet: `MOQ: ${p.moq || '按需核价'}｜打样/交期: ${p.leadTime || '按工艺确认'}${p.description ? `｜${p.description.slice(0, 140)}` : ''}`,
    })),
    ...matchedKnowledge.map((k) => ({ kind: 'knowledge' as const, title: k.title, snippet: k.snippet.slice(0, 220) })),
  ];

  const knowledgeContextText = matchedKnowledge.length > 0
    ? matchedKnowledge.map((k) => `- ${k.title}: ${k.snippet}`).join('\n')
    : '';
  const productContextText = matchedProducts.length > 0
    ? matchedProducts.map((p) => `- [${p.sku}] ${p.name}（类目：${p.category || '未分类'}）｜MOQ：${p.moq || '待核'}｜交期：${p.leadTime || '待核'}｜参数：${p.specs.filter((s) => s.code !== 'PRICE_RANGE').slice(0, 5).map((s) => `${s.name}=${s.value}`).join('；')}`).join('\n')
    : '';

  const scamSignals = detectScamSignals(latestInbound);
  const kbDraft = composeDeterministicKbReply(ctx);

  let fullSubject = kbDraft.subject;
  let fullBody = kbDraft.body;
  let shortBody = kbDraft.body;
  let intentZh = scenario === 'auto'
    ? (isOngoingThread ? '多轮业务往来跟进与细节推进' : '客户新询盘或业务咨询')
    : SCENARIO_DEFAULT_INTENT[scenario];
  let summaryZh = '已根据当前邮件上下文、项目对外口径与确定性护栏生成草稿，请核对提示后发送。';
  let openQuestions: MultiChannelDraftResult['analysis']['openQuestions'] = kbDraft.requests.map((r) => ({
    text: r.text,
    zh: r.text,
    handling: kbDraft.covered.some((c) => c.req === r.text && !c.isCheckFallback) ? 'ANSWERED' : 'CHECKING',
    ownerRole: 'Sales',
  }));
  let commitments: MultiChannelDraftResult['analysis']['commitments'] = [];
  let missingInfo: string[] = [];
  let revisedDiff: MultiChannelDraftResult['revisedDiff'];
  let usedAi = false;
  let aiFallbackReason: string | undefined;

  const provider = await resolveAgentProvider();
  if (!provider.isAvailable() || provider.name === 'mock') {
    aiFallbackReason = 'AI_NOT_CONFIGURED';
  } else {
    try {
      const attSummary = (input.inboundAttachments ?? []).length > 0
        ? (input.inboundAttachments ?? []).map((a) => `- ${a.name}｜状态：${a.status}｜${a.note || ''}`).join('\n')
        : '（无附件）';
      const turn = await provider.createTurn({
        instructions: [
          '你是资深外贸业务总监，负责起草各类外贸客户往来邮件（包括但不限于首次询盘、报价跟进、打样/图稿确认、大货生产与物流、议价、售后客诉与日常简短确认）。请结合【历史往来】【对外口径表】和【已批准报价】撰写英文回复，严格遵守：',
          `0. ${SCENARIO_DIRECTIVES[scenario]}`,
          '1. 只能引用“可对外=是”的口径数字；无批准报价时绝不写金额；无登记待发附件绝不写 attached/enclosed；不猜人名。',
          '2. 同时输出完整版 reply 和简洁版 reply_short（邮件 45-110 词，IM 60 词内），两版事实承诺一致，自然段不写电报体。',
          '3. 如果来信明显是营销推广/系统通知/订阅邮件而非真实业务往来，请在 intent_zh 和 summary_zh 中明确提醒业务员无需回复。',
          '4. 严格输出符合 JSON Schema 的单个 JSON 对象，不要包含额外文字。',
        ].join('\n'),
        input: [{
          role: 'user',
          content: [
            `渠道：${input.channel || 'email'}｜场景：${scenario}｜是否多轮往来：${isOngoingThread ? '是' : '否'}｜原主题：${input.subject || '（无）'}｜目的地：${input.destination || '未提供'}`,
            `【对外口径表】\n${policiesText || '（无）'}`,
            knowledgeContextText ? `【已审核知识库依据】\n${knowledgeContextText}` : '',
            productContextText ? `【匹配产品目录（不含未批准报价金额）】\n${productContextText}` : '',
            writingRulesText ? `【团队写作规则】\n${writingRulesText}` : '',
            `【已批准报价】\n${approvedQuotesText}`,
            `【附件状态】\n${attSummary}`,
            `【待发送附件】\n${input.attachedOutFiles?.length ? input.attachedOutFiles.join('、') : '（无，正文不得写 attached）'}`,
            fullContextThread ? `【历史往来（最近记录）】\n${fullContextThread.slice(-6000)}` : '',
            `【当前买家最新来信】\n${combinedInbound.slice(0, 8000)}`,
            input.instruction ? `【业务员额外指示】\n${input.instruction}` : '',
            `【签名（结尾原样保留）】\n${signatureText}`,
          ].filter(Boolean).join('\n\n'),
        }],
        tools: [],
        outputFormat: {
          type: 'json_schema',
          name: 'workbench_multichannel_draft',
          strict: true,
          schema: WORKBENCH_MULTICHANNEL_DRAFT_SCHEMA as unknown as Record<string, unknown>,
        },
        context: input.customerId ? { type: 'customer', resourceId: input.customerId } : { type: 'global' },
        userPrompt: '生成双版本回复与内审分析 JSON',
        safetyIdentifier: 'workbench-multichannel-draft',
      });
      const parsed = parseJsonObjectFromText<{
        subject?: string;
        reply?: string;
        reply_short?: string;
        intent_zh?: string;
        summary_zh?: string;
        missing?: string[];
        requests?: { text?: string; zh?: string; handling?: string; ownerRole?: string }[];
        commitments?: { quote?: string; grade?: string; ownerRole?: string; zh?: string }[];
      }>(turn.text);
      if (parsed?.reply?.trim()) {
        usedAi = true;
        fullSubject = String(parsed.subject ?? '').trim() || kbDraft.subject;
        fullBody = parsed.reply.trim();
        shortBody = String(parsed.reply_short ?? '').trim() || fullBody;
        if (parsed.intent_zh) intentZh = parsed.intent_zh;
        if (parsed.summary_zh) summaryZh = parsed.summary_zh;
        if (Array.isArray(parsed.missing)) missingInfo = parsed.missing.map(String).filter(Boolean).slice(0, 10);
        if (Array.isArray(parsed.requests) && parsed.requests.length > 0) {
          openQuestions = parsed.requests
            .filter((r) => r.text)
            .slice(0, 12)
            .map((r) => ({
              text: String(r.text),
              zh: String(r.zh || r.text),
              handling: (['ANSWERED', 'ASKED', 'CHECKING', 'NOTED', 'DECLINED'].includes(String(r.handling))
                ? r.handling : 'CHECKING') as MultiChannelDraftResult['analysis']['openQuestions'][number]['handling'],
              ownerRole: (['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management'].includes(String(r.ownerRole))
                ? r.ownerRole : 'Sales') as WorkbenchOwnerRole,
            }));
        }
        if (Array.isArray(parsed.commitments)) {
          commitments = parsed.commitments
            .filter((c) => c.quote)
            .slice(0, 10)
            .map((c) => ({
              quote: String(c.quote),
              grade: (['A', 'B', 'C'].includes(String(c.grade)) ? c.grade : 'C') as CommitmentGrade,
              ownerRole: (['Sales', 'Costing', 'Engineering', 'QC', 'Logistics', 'Customs', 'Management'].includes(String(c.ownerRole))
                ? c.ownerRole : 'Sales') as WorkbenchOwnerRole,
              zh: String(c.zh || c.quote),
            }));
        }
      } else {
        aiFallbackReason = 'AI_INVALID_JSON';
      }

      // Auto-revise once if deterministic guardrail catches any `bad` violations
      if (usedAi) {
        const gFull = runDeterministicGuard(fullSubject, fullBody, ctx).filter((c) => c.severity === 'bad').map((c) => c.message);
        const gShort = runDeterministicGuard(fullSubject, shortBody, ctx).filter((c) => c.severity === 'bad').map((c) => c.message);
        if (gFull.length > 0 || gShort.length > 0) {
          const reviseTurn = await provider.createTurn({
            instructions: '你是外贸合规校对员。下面草稿触发了确定性红线，请只修正违禁部分，保持原语气和已正确内容。输出 JSON：{"subject":"","reply":"","reply_short":"","changes_zh":[]}',
            input: [{
              role: 'user',
              content: [
                `完整版必须修改的问题：\n${gFull.map((x) => `- ${x}`).join('\n') || '（无）'}`,
                `简洁版必须修改的问题：\n${gShort.map((x) => `- ${x}`).join('\n') || '（无）'}`,
                `原主题：${fullSubject}\n原完整版：\n${fullBody}\n原简洁版：\n${shortBody}`,
                `【对外口径】\n${policiesText || '（无）'}`,
                `【已批准报价】\n${approvedQuotesText}`,
                `【签名】\n${signatureText}`,
              ].join('\n\n'),
            }],
            tools: [],
            outputFormat: {
              type: 'json_schema',
              name: 'workbench_auto_revise',
              strict: true,
              schema: WORKBENCH_AUTO_REVISE_SCHEMA as unknown as Record<string, unknown>,
            },
            context: { type: 'global' },
            userPrompt: '修正护栏红线问题',
            safetyIdentifier: 'workbench-auto-revise',
          });
          const rp = parseJsonObjectFromText<{ subject?: string; reply?: string; reply_short?: string; changes_zh?: string[] }>(reviseTurn.text);
          if (rp?.reply?.trim()) {
            revisedDiff = {
              before: fullBody,
              problems: [...gFull, ...gShort],
              changesZh: Array.isArray(rp.changes_zh) ? rp.changes_zh.map(String) : ['已自动修复护栏拦截项'],
            };
            fullBody = rp.reply.trim();
            if (rp.subject?.trim()) fullSubject = rp.subject.trim();
            if (rp.reply_short?.trim()) shortBody = rp.reply_short.trim();
          }
        }
      }
    } catch (error) {
      aiFallbackReason = error instanceof AgentProviderError ? error.code : 'AI_CALL_FAILED';
    }
  }

  if (!usedAi) {
    // Produce a genuinely concise version deterministically so A differs from K/B
    const paras = kbDraft.body.split('\n\n').filter(Boolean);
    if (paras.length >= 4) {
      shortBody = [paras[0], paras[paras.length - 2], paras[paras.length - 1]].join('\n\n');
    } else {
      shortBody = kbDraft.body;
    }
  }

  const scoreB = scoreWorkbenchReply(fullSubject, fullBody, ctx);
  const scoreA = scoreWorkbenchReply(fullSubject, shortBody, ctx);
  const scoreK = kbDraft.score;

  const versions: { key: 'K' | 'B' | 'A'; score: ReplyScoreResult }[] = [
    { key: 'B', score: scoreB },
    { key: 'A', score: scoreA },
    { key: 'K', score: scoreK },
  ];
  versions.sort((x, y) => {
    if (x.score.badCount !== y.score.badCount) return x.score.badCount - y.score.badCount;
    // When AI succeeded and has zero guardrail redlines, give AI a modest context-understanding
    // edge over the static rule template K so nuanced multi-turn replies win cleanly.
    const effX = x.score.score + (usedAi && x.key !== 'K' && x.score.badCount === 0 ? 12 : 0);
    const effY = y.score.score + (usedAi && y.key !== 'K' && y.score.badCount === 0 ? 12 : 0);
    if (effX !== effY) return effY - effX;
    return y.score.score - x.score.score;
  });
  const duelWinner = versions[0].key;

  const bestScore = versions[0].score;
  const preSendChecklist: MultiChannelDraftResult['analysis']['preSendChecklist'] = [
    {
      label: '红线与口径校验',
      value: bestScore.badCount > 0 ? `存在 ${bestScore.badCount} 条必须修改项` : bestScore.warnCount > 0 ? `无红线，有 ${bestScore.warnCount} 条提醒` : '全部通过',
      severity: bestScore.badCount > 0 ? 'bad' : bestScore.warnCount > 0 ? 'warn' : 'ok',
    },
    {
      label: '待发送附件',
      value: input.attachedOutFiles?.length ? `已登记：${input.attachedOutFiles.join('、')}` : '无待发附件（正文不得提 attached）',
      severity: 'ok',
    },
    {
      label: '未解决问题覆盖',
      value: `识别 ${openQuestions.length} 项诉求，其中 ${openQuestions.filter((q) => q.handling === 'CHECKING').length} 项待内部核实`,
      severity: openQuestions.some((q) => q.handling === 'CHECKING') ? 'warn' : 'ok',
    },
    {
      label: '对外承诺等级',
      value: commitments.length > 0 ? `共 ${commitments.length} 条承诺（含 ${commitments.filter((c) => c.grade === 'C').length} 条 C 级待核承诺）` : '未发现新增硬承诺',
      severity: commitments.some((c) => c.grade === 'C') ? 'warn' : 'ok',
    },
  ];

  return {
    scamSignals,
    drafts: {
      K: { subject: kbDraft.subject, body: kbDraft.body, score: scoreK },
      B: { subject: fullSubject, body: fullBody, score: scoreB },
      A: { subject: fullSubject, body: shortBody, score: scoreA },
    },
    duelWinner,
    revisedDiff,
    analysis: {
      intentZh,
      summaryZh,
      openQuestions,
      commitments,
      missingInfo,
      preSendChecklist,
      knowledgeRefs,
      policyCount: (ctx.policies ?? []).length,
    },
    usedAi,
    aiFallbackReason,
  };
}

export async function rewriteWorkbenchDraft(
  input: {
    subject?: string;
    body: string;
    tone: 'concise' | 'professional' | 'friendly' | 'formal';
    instruction?: string;
    customerId?: string;
    inboundText?: string;
  },
  actor: AuthUser,
): Promise<{ body: string; zh: string; score: ReplyScoreResult }> {
  const toneGuide: Record<typeof input.tone, string> = {
    concise: '极简干练（控制在 60-110 英文词，删去冗余寒暄，保留全部关键事实与下一步）',
    professional: '专业商务（沉稳、清晰、像资深外贸工厂负责人，不卑不亢）',
    friendly: '友好亲切（自然热情、合作感强，但不使用过度感叹号或廉价套话）',
    formal: '正式严谨（适合大品牌采购、合规审核或正式报价场景）',
  };

  const { ctx, policiesText, signatureText } = await buildGuardContextForProject(actor, {
    customerId: input.customerId,
    inboundText: input.inboundText,
    threadSubject: input.subject,
  });

  let rewritten = input.body;
  let zh = '';
  const provider = await resolveAgentProvider();

  if (provider.isAvailable() && provider.name !== 'mock') {
    try {
      const turn = await provider.createTurn({
        instructions: [
          `请将外贸英文邮件改写为指定语气：${toneGuide[input.tone]}。`,
          '事实、数字、承诺范围必须与原文一致，不得新增口径表以外的数字或承诺，保留原结尾签名。',
          '只返回 JSON：{"body":"改写后英文正文","zh":"改写后正文的中文参考翻译"}',
        ].join('\n'),
        input: [{
          role: 'user',
          content: [
            input.instruction ? `补充要求：${input.instruction}` : '',
            `【对外口径】\n${policiesText || '（无）'}`,
            `【原文】\n${input.body}`,
            `【签名】\n${signatureText}`,
          ].filter(Boolean).join('\n\n'),
        }],
        tools: [],
        outputFormat: {
          type: 'json_schema',
          name: 'workbench_tone_rewrite',
          strict: true,
          schema: WORKBENCH_TONE_REWRITE_SCHEMA as unknown as Record<string, unknown>,
        },
        context: { type: 'global' },
        userPrompt: '改写语气并返回英文与中文对照 JSON',
        safetyIdentifier: 'workbench-tone-rewrite',
      });
      const parsed = parseJsonObjectFromText<{ body?: string; zh?: string }>(turn.text);
      if (parsed?.body?.trim()) {
        rewritten = parsed.body.trim();
        zh = String(parsed.zh ?? '').trim();
      }
    } catch {
      // fallback below
    }
  }

  if (!zh) {
    try {
      const tr = await translateLetter({ body: rewritten });
      zh = tr.body;
    } catch {
      zh = '（AI 翻译暂未配置，可人工核对英文正文）';
    }
  }

  const score = scoreWorkbenchReply(input.subject || '', rewritten, ctx);
  return { body: rewritten, zh, score };
}

export interface LearnedCandidate {
  type: 'writing_rule' | 'policy_change' | 'exemplar';
  text: string;
  why: string;
}

export async function learnFromFinalEdit(
  input: {
    inboundText: string;
    aiDraft: string;
    finalSent: string;
    note?: string;
    autoAdoptWritingRules?: boolean;
  },
  actor: AuthUser,
): Promise<{ summaryZh: string; candidates: LearnedCandidate[]; adoptedCount: number }> {
  const wbConfig = await getProjectWorkbenchConfig(actor);
  const existingRules = wbConfig.teamWritingRules.filter((r) => r.enabled).map((r) => r.text);
  let summaryZh = '已对比 AI 草稿与最终实发版本。';
  let candidates: LearnedCandidate[] = [];

  const provider = await resolveAgentProvider();
  if (provider.isAvailable() && provider.name !== 'mock') {
    try {
      const turn = await provider.createTurn({
        instructions: [
          '你是外贸销售教练。业务员修改了 AI 草稿后实际发给买家，请对比两版提炼值得长期记住的变化：',
          '三类：writing_rule（团队写作/策略规则，一句中文，不与现有规则重复）、policy_change（改动了某个事实或数字，注明需老板拍板改口径表）、exemplar（值得作为范例的理由）。',
          '没有长期价值的变化则返回空数组。只返回 JSON：{"summary_zh":"","items":[{"type":"writing_rule|policy_change|exemplar","text":"","why":""}]}',
        ].join('\n'),
        input: [{
          role: 'user',
          content: [
            `【现有团队写作规则】\n${existingRules.map((x) => `- ${x}`).join('\n') || '（无）'}`,
            `【买家来信】\n${input.inboundText.slice(0, 2000)}`,
            `【AI 草稿】\n${input.aiDraft.slice(0, 3000)}`,
            `【最终发出版本】\n${input.finalSent.slice(0, 3000)}`,
            input.note ? `【业务员备注】${input.note}` : '',
          ].filter(Boolean).join('\n\n'),
        }],
        tools: [],
        outputFormat: {
          type: 'json_schema',
          name: 'workbench_learn_edit',
          strict: true,
          schema: WORKBENCH_LEARN_EDIT_SCHEMA as unknown as Record<string, unknown>,
        },
        context: { type: 'global' },
        userPrompt: '提取长期可复用经验 JSON',
        safetyIdentifier: 'workbench-learn-edit',
      });
      const parsed = parseJsonObjectFromText<{ summary_zh?: string; items?: { type?: string; text?: string; why?: string }[] }>(turn.text);
      if (parsed) {
        if (parsed.summary_zh) summaryZh = parsed.summary_zh;
        if (Array.isArray(parsed.items)) {
          candidates = parsed.items
            .filter((it) => it.text && ['writing_rule', 'policy_change', 'exemplar'].includes(String(it.type)))
            .slice(0, 6)
            .map((it) => ({
              type: it.type as LearnedCandidate['type'],
              text: String(it.text).trim(),
              why: String(it.why ?? '').trim(),
            }));
        }
      }
    } catch {
      // fallback deterministic diff summary
    }
  }

  if (candidates.length === 0 && input.aiDraft.trim() !== input.finalSent.trim()) {
    const aiLen = input.aiDraft.trim().split(/\s+/).length;
    const finalLen = input.finalSent.trim().split(/\s+/).length;
    if (finalLen < aiLen * 0.72) {
      candidates.push({
        type: 'writing_rule',
        text: '回复保持更简洁克制，优先直答买家核心问题，删减冗余铺垫',
        why: `终稿词数（${finalLen}）明显短于 AI 草稿（${aiLen}）`,
      });
    }
  }

  let adoptedCount = 0;
  if (input.autoAdoptWritingRules && actor.role === 'admin') {
    const newRules = candidates.filter((c) => c.type === 'writing_rule');
    if (newRules.length > 0) {
      const merged = [...wbConfig.teamWritingRules];
      for (const nr of newRules) {
        if (!merged.some((r) => r.text === nr.text)) {
          merged.push({ id: `rule-${Date.now()}-${adoptedCount}`, text: nr.text, enabled: true, source: '终稿学习反哺' });
          adoptedCount += 1;
        }
      }
      await updateProjectWorkbenchConfig({ teamWritingRules: merged }, actor);
    }
  }

  return { summaryZh, candidates, adoptedCount };
}

export interface KnowledgeQaResult {
  answer: string;
  matchedDocs: { id: string; title: string; category: string; relevance: 'high' | 'medium'; score: number; excerpt: string }[];
  matchedPolicies: { code: string; topic: string; external: boolean; confirmed: boolean; valueZh: string; valueEn: string }[];
  matchedProducts: ProductDto[];
  confidenceChecks: { label: string; passed: boolean }[];
  suggestedQuestions: string[];
  usedAi: boolean;
}

export async function answerKnowledgeQuestion(question: string, actor: AuthUser): Promise<KnowledgeQaResult> {
  const projectId = requireProjectId(actor);
  const q = question.trim();
  const terms = [...new Set(q.toLowerCase().split(/[\s,，。？?、/]+/).filter((t) => t.length >= 2))];

  const [knowledgeDocs, policies, products] = await Promise.all([
    AgentKnowledge.find({ projectId, archived: false, approvedVersion: { $gt: 0 } }).sort({ updatedAt: -1 }).limit(300).lean(),
    ProjectPolicy.find({ projectId }).sort({ code: 1 }).lean(),
    activeProducts(actor),
  ]);

  const scoreText = (haystack: string): number => {
    const lower = haystack.toLowerCase();
    if (!terms.length) return 0;
    let hits = 0;
    for (const term of terms) {
      if (lower.includes(term)) hits += 1;
    }
    return hits / terms.length;
  };

  const matchedDocs = knowledgeDocs
    .map((doc) => {
      const rev = doc.revisions.find((r) => r.version === doc.approvedVersion);
      if (!rev || !revisionActive(rev) || (actor.role !== 'admin' && rev.accessScope === 'admins')) return null;
      const s = scoreText(`${rev.title} ${rev.category} ${(rev.tags ?? []).join(' ')} ${(rev.products ?? []).join(' ')} ${rev.content}`);
      if (s <= 0) return null;
      return {
        id: String(doc._id),
        title: rev.title,
        category: rev.category || 'reference',
        relevance: (s >= 0.45 ? 'high' : 'medium') as 'high' | 'medium',
        score: Math.round(s * 100),
        excerpt: rev.content.slice(0, 260),
        fullContent: rev.content.slice(0, 1800),
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const matchedPolicies = policies
    .map((p) => ({
      policy: p,
      score: scoreText(`${p.code} ${p.topic} ${p.scope || ''} ${p.valueZh} ${p.valueEn}`),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ policy }) => ({
      code: policy.code,
      topic: policy.topic,
      external: policy.external,
      confirmed: policy.confirmed,
      valueZh: policy.valueZh,
      valueEn: policy.valueEn,
    }));

  const matchedProducts = products
    .map((prod) => ({
      prod,
      score: scoreText(`${prod.sku} ${prod.name} ${prod.category || ''} ${prod.description || ''} ${prod.specs.map((s) => `${s.name} ${s.value}`).join(' ')}`),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.prod);

  let answer = '';
  let usedAi = false;
  const provider = await resolveAgentProvider();
  if (provider.isAvailable() && provider.name !== 'mock' && (matchedDocs.length > 0 || matchedPolicies.length > 0 || matchedProducts.length > 0)) {
    try {
      const turn = await provider.createTurn({
        instructions: [
          '你是外贸企业内部知识库助手。仅依据提供的【对外口径】【已审核知识库】【产品目录】用清晰的结构化中文回答业务员提问（可使用小标题/要点/表格）。',
          '严禁编造资料中没有的价格、交期或认证；未覆盖部分明确注明“知识库暂无记录，请找对应部门核实”。',
        ].join('\n'),
        input: [{
          role: 'user',
          content: [
            `业务员提问：${q}`,
            matchedPolicies.length ? `【对外口径】\n${matchedPolicies.map((p) => `- [${p.code}] ${p.topic}（可对外=${p.external ? '是' : '否'}）：${p.valueZh}`).join('\n')}` : '',
            matchedProducts.length ? `【产品目录】\n${matchedProducts.map((p) => `- ${p.sku} ${p.name}｜MOQ:${p.moq || '未填'}｜交期:${p.leadTime || '未填'}｜阶梯价:${p.priceTiers.map((t) => `${t.minQuantity}+=${t.currency} ${t.unitPrice}`).join(', ') || '无'}`).join('\n')}` : '',
            matchedDocs.length ? `【已审核资料】\n${matchedDocs.map((d) => `### ${d.title}\n${d.fullContent}`).join('\n\n')}` : '',
          ].filter(Boolean).join('\n\n'),
        }],
        tools: [],
        outputFormat: { type: 'text' },
        context: { type: 'global' },
        userPrompt: '基于已审核资料结构化作答',
        safetyIdentifier: 'workbench-knowledge-qa',
      });
      if (turn.text?.trim()) {
        answer = turn.text.trim();
        usedAi = true;
      }
    } catch {
      // fallback grounded synthesis
    }
  }

  if (!answer) {
    const sections: string[] = [];
    if (matchedPolicies.length > 0) {
      sections.push('### 1. 权威对外口径\n' + matchedPolicies.map((p) => `- **${p.topic}（${p.code}）**：${p.valueZh}${p.external ? '' : '（仅内部，不可对外报价/披露）'}`).join('\n'));
    }
    if (matchedProducts.length > 0) {
      sections.push('### 2. 匹配产品参数\n' + matchedProducts.map((p) => {
        const tierSummary = p.priceTiers.map((t) => `${t.minQuantity}+ 件：${t.currency} ${t.unitPrice}`).join('；');
        return `- **${p.name}（${p.sku}）**：MOQ ${p.moq || '待核'}｜交期 ${p.leadTime || '待核'}${tierSummary ? `｜目录阶梯价：${tierSummary}` : ''}`;
      }).join('\n'));
    }
    if (matchedDocs.length > 0) {
      sections.push('### 3. 已发布知识库摘录\n' + matchedDocs.slice(0, 3).map((d) => `- **${d.title}**：${d.excerpt}`).join('\n'));
    }
    answer = sections.length > 0
      ? sections.join('\n\n')
      : '当前已审核知识库、对外口径表和产品目录中暂未检索到直接匹配的记录。建议核对关键词，或联系管理员补充并审核发布相关资料。';
  }

  const suggestedQuestions = [
    matchedProducts[0] ? `${matchedProducts[0].name} 的 MOQ、打样和大货交期分别是多少？` : '本项目所有产品的标准 MOQ 和打样周期是什么？',
    '出口美国/欧洲市场有哪些合规标签、认证或反倾销注意事项？',
    '标准付款条款和贸易条款（FOB/DDP）口径怎么对客户表述？',
    '客户要求免费寄定制样品时，标准回复口径是什么？',
  ];

  return {
    answer,
    matchedDocs: matchedDocs.map(({ fullContent: _unused, ...rest }) => rest),
    matchedPolicies,
    matchedProducts,
    confidenceChecks: [
      { label: '答案限定于本项目已发布知识库与口径表', passed: matchedDocs.length > 0 || matchedPolicies.length > 0 },
      { label: '已联动产品目录 SKU / 阶梯价 / MOQ', passed: matchedProducts.length > 0 },
      { label: '所有引用口径均已老板拍板确认', passed: matchedPolicies.length > 0 && matchedPolicies.every((p) => p.confirmed) },
    ],
    suggestedQuestions,
    usedAi,
  };
}

/**
 * Safe minimal ZIP parser (stored + deflate) with strict anti-zip-slip & size/count limits
 * so admins can upload Obsidian vaults / Markdown bundles without adding untrusted native deps.
 */
function parseSafeZipMarkdownEntries(zipBytes: Buffer): { path: string; content: string }[] {
  const MAX_FILES = 60;
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
  const MAX_SINGLE_BYTES = 120 * 1024;

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65557); i -= 1) {
    if (zipBytes.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw ApiError.badRequest('无效的 ZIP 压缩包格式');

  const cdEntries = zipBytes.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBytes.readUInt32LE(eocdOffset + 16);
  if (cdEntries > 500) throw ApiError.badRequest('压缩包内文件过多（上限 500 个）');

  const out: { path: string; content: string }[] = [];
  let cursor = cdOffset;
  let totalRead = 0;

  for (let idx = 0; idx < cdEntries; idx += 1) {
    if (cursor + 46 > zipBytes.length || zipBytes.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = zipBytes.readUInt16LE(cursor + 10);
    const compSize = zipBytes.readUInt32LE(cursor + 20);
    const uncompSize = zipBytes.readUInt32LE(cursor + 24);
    const nameLen = zipBytes.readUInt16LE(cursor + 28);
    const extraLen = zipBytes.readUInt16LE(cursor + 30);
    const commentLen = zipBytes.readUInt16LE(cursor + 32);
    const localOffset = zipBytes.readUInt32LE(cursor + 42);
    const rawPath = zipBytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    // Strict zip-slip guard
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('..') || normalized.startsWith('__MACOSX/') || normalized.includes('/.obsidian/')) {
      continue;
    }
    if (!/\.md$/i.test(normalized)) continue;
    if (out.length >= MAX_FILES) break;
    if (uncompSize > MAX_SINGLE_BYTES || totalRead + uncompSize > MAX_TOTAL_BYTES) {
      throw ApiError.badRequest(`Markdown 压缩包超出安全体积限制（单文件 <= 120KB，总计 <= 2MB）`);
    }

    if (localOffset + 30 > zipBytes.length || zipBytes.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = zipBytes.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = zipBytes.subarray(dataStart, dataStart + compSize);
    let plain: Buffer;
    if (method === 0) {
      plain = compressed;
    } else if (method === 8) {
      plain = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_SINGLE_BYTES });
    } else {
      continue;
    }
    totalRead += plain.length;
    out.push({ path: normalized, content: plain.toString('utf8') });
  }
  return out;
}

function inferCategoryFromPath(filePath: string): KnowledgeCategory {
  const lower = filePath.toLowerCase();
  if (/policy|price|quote|moq|payment|shipping|报价|政策|条款|交易/.test(lower)) return 'trade';
  if (/compliance|cert|fsc|bsci|customs|duty|合规|认证|质检/.test(lower)) return 'compliance';
  if (/company|factory|brand|工厂|公司|品牌/.test(lower)) return 'company';
  if (/faq|qa|case|history|经验|案例|常见/.test(lower)) return 'faq';
  if (/rule|redline|script|销售|红线|话术/.test(lower)) return 'sales_rules';
  if (/product|sku|material|产品|工艺|材质/.test(lower)) return 'product';
  return 'reference';
}

function cleanObsidianMarkdown(raw: string): { title?: string; tags: string[]; content: string } {
  let text = String(raw || '').replace(/\r\n/g, '\n');
  const tags: string[] = [];
  let title: string | undefined;

  // Strip YAML frontmatter safely and harvest tags/title if present
  const fm = /^---\n([\s\S]*?)\n---\n*/.exec(text);
  if (fm) {
    const block = fm[1];
    const tMatch = /^title:\s*(.+)$/m.exec(block);
    if (tMatch) title = tMatch[1].trim().replace(/^["']|["']$/g, '');
    const tagMatches = block.matchAll(/^\s*-\s*([a-zA-Z0-9_\u4e00-\u9fff-]{1,40})\s*$/gm);
    for (const tm of tagMatches) tags.push(tm[1]);
    text = text.slice(fm[0].length);
  }
  // Convert Obsidian [[Note|Alias]] -> Alias, [[Note]] -> Note
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  return { title, tags: [...new Set(tags)].slice(0, 12), content: text.trim() };
}

export async function importMarkdownBundle(
  input: {
    files?: { path: string; content: string }[];
    zipBase64?: string;
    sourceLabel?: string;
  },
  actor: AuthUser,
): Promise<{ imported: number; skipped: number; createdIds: string[] }> {
  if (actor.role !== 'admin' && actor.role !== 'project_admin') throw ApiError.forbidden('仅管理员可导入知识库草稿');
  let entries: { path: string; content: string }[] = [];
  if (input.zipBase64) {
    const raw = Buffer.from(input.zipBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (raw.length > 5 * 1024 * 1024) throw ApiError.badRequest('ZIP 文件不能超过 5MB');
    entries = parseSafeZipMarkdownEntries(raw);
  } else if (input.files) {
    for (const f of input.files.slice(0, 60)) {
      if (f.path.includes('..')) throw ApiError.badRequest('文件路径包含非法字符');
      entries.push(f);
    }
  }
  if (entries.length === 0) throw ApiError.badRequest('未找到可导入的 Markdown (.md) 文件');

  const createdIds: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const cleaned = cleanObsidianMarkdown(entry.content);
    if (cleaned.content.length < 10) {
      skipped += 1;
      continue;
    }
    const baseName = entry.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') || 'Untitled Note';
    const folderParts = entry.path.replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean);
    const title = (cleaned.title || baseName).slice(0, 160);
    const category = inferCategoryFromPath(entry.path);
    const tags = [...new Set([...folderParts.slice(-2), ...cleaned.tags, 'obsidian-import'])].slice(0, 20);
    const id = await appendKnowledge(undefined, {
      expectedVersion: 0,
      accessScope: 'project',
      title,
      category,
      tags,
      content: cleaned.content.slice(0, 12000),
      source: `${input.sourceLabel || 'Obsidian/Markdown 导入'}: ${entry.path}`.slice(0, 500),
      approved: false,
      applicability: 'Markdown 批量导入草稿；请核对产品、数字及生效范围后审核发布',
      products: [],
      terms: [],
    }, actor);
    createdIds.push(id);
  }
  return { imported: createdIds.length, skipped, createdIds };
}
