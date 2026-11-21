/**
 * 仪表盘「销售工作区」聚合
 * ------------------------------------------------------------------
 * 面向销售日常动作：今天要跟进谁、谁已逾期、今天发了几封信、加了几个客户、
 * 最近跟进 / 开发了哪些客户。全部为只读聚合，供 GET /api/stats/overview 使用。
 *
 * 跟进时间的「今天 / 已逾期 / 未来」口径与客户列表筛选完全一致：
 * 以本地时区「今天 0 点」为分界（见 customer.service.buildCustomerFilter），
 * 保证 Dashboard 的数字和点进列表看到的结果对得上。
 */
import { Customer, CustomerWorkbenchItem, DevelopmentLetter, FollowUp, Quotation, roundMoney, type CustomerDocument } from '../models';
import { CUSTOMER_STATUS_LABEL, type CustomerStatus, type FollowUpMethod, type FollowUpResult } from '../constants';
import { customerRefScope, customerScope } from '../utils/access';
import type { AuthUser } from '../types/express';

/** 工作区里可点击跳转的客户摘要（只取列表 / 卡片需要的字段） */
export interface CustomerBrief {
  id: string;
  name: string;
  company?: string;
  country?: string;
  industry?: string;
  status: CustomerStatus;
  grade?: string;
  nextFollowUpAt?: Date | null;
  createdAt: Date;
}

/** 最近跟进记录（带客户名，便于在 Dashboard 直接展示） */
export interface RecentFollowUpItem {
  id: string;
  customerId: string;
  customerName: string;
  customerCompany?: string;
  method: FollowUpMethod;
  result: FollowUpResult;
  content: string;
  followUpAt: Date;
}

export interface SalesWorkspace {
  /** 今日待跟进客户数 */
  followUpToday: number;
  /** 已逾期客户数 */
  followUpOverdue: number;
  /** 未来（即将跟进）客户数 */
  followUpUpcoming: number;
  /** 今日新增客户数 */
  newCustomersToday: number;
  /** 今日发送开发信数 */
  lettersSentToday: number;
  /** 已逾期客户（最久逾期在前，最多 8 位） */
  overdueCustomers: CustomerBrief[];
  /** 今日待跟进客户（最多 8 位） */
  todayFollowUpCustomers: CustomerBrief[];
  /** 最近跟进记录（最多 6 条） */
  recentFollowUps: RecentFollowUpItem[];
  /** 最近开发（新增）客户（最多 6 位） */
  recentCustomers: CustomerBrief[];
}

/** 工作区客户摘要只查这几列，减小投影 */
const BRIEF_FIELDS = 'name company country industry status grade nextFollowUpAt createdAt';

function toBrief(doc: CustomerDocument): CustomerBrief {
  return {
    id: doc.id,
    name: doc.name,
    company: doc.company,
    country: doc.country,
    industry: doc.industry,
    status: doc.status,
    grade: doc.grade,
    nextFollowUpAt: doc.nextFollowUpAt ?? null,
    createdAt: doc.createdAt,
  };
}

/** 汇总销售工作区所需的全部只读数据（尽量并行） */
export async function getSalesWorkspace(
  actor?: AuthUser,
  precomputedRefScope?: Record<string, unknown>,
): Promise<SalesWorkspace> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  // 严格分配制：业务员的工作区只覆盖自己名下客户（及其开发信 / 跟进）
  const scope = customerScope(actor);
  const refScope = precomputedRefScope ?? await customerRefScope(actor);

  const [
    followUpToday,
    followUpOverdue,
    followUpUpcoming,
    newCustomersToday,
    lettersSentToday,
    overdueDocs,
    todayDocs,
    recentCustomerDocs,
    recentFollowUpDocs,
  ] = await Promise.all([
    Customer.countDocuments({ ...scope, nextFollowUpAt: { $gte: startOfToday, $lt: startOfTomorrow } }),
    Customer.countDocuments({ ...scope, nextFollowUpAt: { $lt: startOfToday } }),
    Customer.countDocuments({ ...scope, nextFollowUpAt: { $gte: startOfTomorrow } }),
    Customer.countDocuments({ ...scope, createdAt: { $gte: startOfToday } }),
    DevelopmentLetter.countDocuments({ ...refScope, status: { $in: ['sent', 'opened'] }, sentAt: { $gte: startOfToday } }),
    // 逾期：越早的越紧急，升序排在最前
    Customer.find({ ...scope, nextFollowUpAt: { $lt: startOfToday } })
      .select(BRIEF_FIELDS)
      .sort({ nextFollowUpAt: 1 })
      .limit(8),
    Customer.find({ ...scope, nextFollowUpAt: { $gte: startOfToday, $lt: startOfTomorrow } })
      .select(BRIEF_FIELDS)
      .sort({ nextFollowUpAt: 1 })
      .limit(8),
    Customer.find({ ...scope }).select(BRIEF_FIELDS).sort({ createdAt: -1 }).limit(6),
    FollowUp.find({ ...refScope }).sort({ followUpAt: -1, createdAt: -1 }).limit(6),
  ]);

  // 跟进记录补客户名：一次性批量查，避免 N+1
  const followUpCustomerIds = Array.from(new Set(recentFollowUpDocs.map((doc) => String(doc.customerId))));
  const followUpCustomers = followUpCustomerIds.length
    ? await Customer.find({ _id: { $in: followUpCustomerIds } }).select('name company').lean()
    : [];
  const customerMap = new Map(followUpCustomers.map((doc) => [String(doc._id), doc]));

  const recentFollowUps: RecentFollowUpItem[] = recentFollowUpDocs.map((doc) => {
    const customer = customerMap.get(String(doc.customerId));
    return {
      id: doc.id,
      customerId: String(doc.customerId),
      customerName: customer?.name ?? '（客户已删除）',
      customerCompany: customer?.company,
      method: doc.method,
      result: doc.result,
      content: doc.content,
      followUpAt: doc.followUpAt,
    };
  });

  return {
    followUpToday,
    followUpOverdue,
    followUpUpcoming,
    newCustomersToday,
    lettersSentToday,
    overdueCustomers: overdueDocs.map(toBrief),
    todayFollowUpCustomers: todayDocs.map(toBrief),
    recentFollowUps,
    recentCustomers: recentCustomerDocs.map(toBrief),
  };
}

export type StatsRangePreset = 'today' | '7d' | '30d' | 'month' | 'all' | 'custom';

export interface DecisionAnalytics {
  range: { preset: StatsRangePreset; from?: string; to?: string };
  countryDistribution: { country: string; count: number; pct: number }[];
  conversionFunnel: { stage: string; label: string; count: number; rate: number }[];
  quotationMetrics: {
    draft: number;
    sent: number;
    negotiating: number;
    accepted: number;
    acceptedAmount: number;
    pipelineAmount: number;
    pendingApproval: number;
  };
  openQuestionsCount: number;
  highIntentCount: number;
  priorityFollowUps: {
    customerId: string;
    name: string;
    company?: string;
    country?: string;
    status: CustomerStatus;
    score: number;
    openQuestions: number;
    reason: string;
    nextFollowUpAt?: Date | null;
  }[];
}

function resolveRangeWindow(preset: StatsRangePreset, fromRaw?: string, toRaw?: string): { from?: Date; to?: Date } {
  const now = new Date();
  if (preset === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start, to: now };
  }
  if (preset === '7d') {
    return { from: new Date(now.getTime() - 7 * 86400_000), to: now };
  }
  if (preset === '30d') {
    return { from: new Date(now.getTime() - 30 * 86400_000), to: now };
  }
  if (preset === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: start, to: now };
  }
  if (preset === 'custom') {
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw ? new Date(toRaw) : undefined;
    return {
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    };
  }
  return {};
}

export async function getDecisionAnalytics(
  actor?: AuthUser,
  precomputedRefScope?: Record<string, unknown>,
  rangeOptions?: { preset?: StatsRangePreset; from?: string; to?: string },
): Promise<DecisionAnalytics> {
  const preset: StatsRangePreset = rangeOptions?.preset ?? '30d';
  const window = resolveRangeWindow(preset, rangeOptions?.from, rangeOptions?.to);
  const scope = customerScope(actor);
  const refScope = precomputedRefScope ?? await customerRefScope(actor);
  const createdFilter = window.from || window.to
    ? {
      createdAt: {
        ...(window.from ? { $gte: window.from } : {}),
        ...(window.to ? { $lte: window.to } : {}),
      },
    }
    : {};

  const [customers, quotations, openItems] = await Promise.all([
    Customer.find({ ...scope, ...createdFilter })
      .select('name company country status priority grade intentScore sampleStatus nextFollowUpAt lastContactAt updatedAt')
      .lean(),
    Quotation.find({ ...refScope, ...createdFilter })
      .select('customerId status approvalStatus totalAmount grandTotal')
      .lean(),
    CustomerWorkbenchItem.find({ ...refScope, status: { $in: ['open', 'result_ready'] } })
      .select('customerId kind status')
      .lean(),
  ]);

  // 1. Country distribution (Top 5 + 其他)
  const countryMap = new Map<string, number>();
  for (const c of customers) {
    const key = (c.country || '').trim() || '未填写';
    countryMap.set(key, (countryMap.get(key) ?? 0) + 1);
  }
  const sortedCountries = [...countryMap.entries()].sort((a, b) => b[1] - a[1]);
  const top5 = sortedCountries.slice(0, 5);
  const restCount = sortedCountries.slice(5).reduce((s, [, cnt]) => s + cnt, 0);
  const totalCustomers = customers.length;
  const countryDistribution = [
    ...top5.map(([country, count]) => ({
      country,
      count,
      pct: totalCustomers > 0 ? Math.round((count / totalCustomers) * 100) : 0,
    })),
    ...(restCount > 0 ? [{ country: '其他', count: restCount, pct: Math.round((restCount / totalCustomers) * 100) }] : []),
  ];

  // 2. Cumulative conversion funnel
  const stageOrder: CustomerStatus[] = ['pending', 'contacted', 'replied', 'interested', 'quoting', 'negotiating', 'won'];
  const stageCounts = new Map<CustomerStatus, number>();
  for (const c of customers) {
    stageCounts.set(c.status, (stageCounts.get(c.status) ?? 0) + 1);
  }
  const activeTotal = customers.filter((c) => c.status !== 'lost').length;
  const reachedCount = (minIdx: number) => stageOrder.slice(minIdx).reduce((s, st) => s + (stageCounts.get(st) ?? 0), 0);
  const funnelSteps: { stage: string; label: string; count: number }[] = [
    { stage: 'all', label: '活跃客户/询盘', count: activeTotal },
    { stage: 'contacted', label: CUSTOMER_STATUS_LABEL.contacted, count: reachedCount(1) },
    { stage: 'replied', label: CUSTOMER_STATUS_LABEL.replied, count: reachedCount(2) },
    { stage: 'quoting', label: CUSTOMER_STATUS_LABEL.quoting, count: reachedCount(4) },
    { stage: 'won', label: CUSTOMER_STATUS_LABEL.won, count: stageCounts.get('won') ?? 0 },
  ];
  const conversionFunnel = funnelSteps.map((step) => ({
    ...step,
    rate: activeTotal > 0 ? Math.round((step.count / activeTotal) * 100) : 0,
  }));

  // 3. Quotation revenue & status metrics
  let draft = 0;
  let sent = 0;
  let negotiating = 0;
  let accepted = 0;
  let acceptedAmount = 0;
  let pipelineAmount = 0;
  let pendingApproval = 0;
  const activeQuoteCustomerIds = new Set<string>();
  for (const q of quotations) {
    const amt = typeof q.grandTotal === 'number' ? q.grandTotal : Number(q.totalAmount ?? 0);
    if (q.status === 'draft') draft += 1;
    else if (q.status === 'sent') { sent += 1; pipelineAmount += amt; activeQuoteCustomerIds.add(String(q.customerId)); }
    else if (q.status === 'negotiating') { negotiating += 1; pipelineAmount += amt; activeQuoteCustomerIds.add(String(q.customerId)); }
    else if (q.status === 'accepted') { accepted += 1; acceptedAmount += amt; }
    if (q.approvalStatus === 'pending_approval') pendingApproval += 1;
  }

  // 4. Open questions & priority follow-up scoring
  const openQuestionsByCustomer = new Map<string, number>();
  let openQuestionsCount = 0;
  for (const item of openItems) {
    if (item.kind === 'open_question') {
      openQuestionsCount += 1;
      const cid = String(item.customerId);
      openQuestionsByCustomer.set(cid, (openQuestionsByCustomer.get(cid) ?? 0) + 1);
    }
  }

  const nowMs = Date.now();
  const highIntentCount = customers.filter((c) =>
    ['interested', 'quoting', 'negotiating'].includes(c.status) || (typeof c.intentScore === 'number' && c.intentScore >= 70),
  ).length;

  const allActiveCustomers = preset === 'all'
    ? customers
    : await Customer.find({ ...scope, status: { $nin: ['won', 'lost'] } })
      .select('name company country status priority grade intentScore sampleStatus nextFollowUpAt lastContactAt updatedAt')
      .limit(200)
      .lean();

  const priorityFollowUps = allActiveCustomers
    .filter((c) => c.status !== 'won' && c.status !== 'lost')
    .map((c) => {
      const cid = String(c._id);
      const oq = openQuestionsByCustomer.get(cid) ?? 0;
      let score = 20;
      const reasons: string[] = [];
      if (c.priority === 'high') { score += 25; reasons.push('高优先级'); }
      if (['quoting', 'negotiating'].includes(c.status)) { score += 24; reasons.push(CUSTOMER_STATUS_LABEL[c.status]); }
      else if (c.status === 'interested' || c.status === 'replied') { score += 18; reasons.push(CUSTOMER_STATUS_LABEL[c.status]); }
      if (c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() < nowMs) { score += 22; reasons.push('跟进已逾期'); }
      if (oq > 0) { score += Math.min(24, oq * 12); reasons.push(`${oq} 个未解决问题`); }
      if (activeQuoteCustomerIds.has(cid)) { score += 14; reasons.push('有待确认报价'); }
      if (typeof c.intentScore === 'number') { score += Math.round(c.intentScore * 0.25); }
      return {
        customerId: cid,
        name: c.name,
        company: c.company,
        country: c.country,
        status: c.status,
        score: Math.min(100, score),
        openQuestions: oq,
        reason: reasons.slice(0, 3).join(' · ') || '建议推进下一步沟通',
        nextFollowUpAt: c.nextFollowUpAt ?? null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    range: {
      preset,
      from: window.from?.toISOString(),
      to: window.to?.toISOString(),
    },
    countryDistribution,
    conversionFunnel,
    quotationMetrics: {
      draft,
      sent,
      negotiating,
      accepted,
      acceptedAmount: roundMoney(acceptedAmount),
      pipelineAmount: roundMoney(pipelineAmount),
      pendingApproval,
    },
    openQuestionsCount,
    highIntentCount,
    priorityFollowUps,
  };
}
