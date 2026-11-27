/**
 * 今日工作台（Dashboard）— 双主轴 AI 原生外贸工作台
 * ------------------------------------------------------------------
 * 对齐 01_今日工作 设计架构，采用微暖画廊白与炭黑（Notion / Claude 质感）：
 * - 左侧主工作轴：精炼问候与时间区间切换 -> 5 枚紧凑核心指标卡 ->
 *   「今日重点任务」与「业务动态时间线」并排双卡 -> 阶段推进进度卡 ->
 *   支持多指标切换的「关键指标趋势」面积图 + 「客户分布 Top 5」环形图 -> 可折叠深度结构分析。
 * - 右侧常驻嵌入式「AI 外贸助手」协同舱：四类场景切换（建议执行 / 写邮件 / 查资料 / 分析）+
 *   结合当前真实业务数据的智能行动卡 + 待办计数速览 + 底部内联自然语言指令框。
 */
import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BookOpen,
  CalendarCheck2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePenLine,
  Globe2,
  Mail,
  Maximize2,
  ReceiptText,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';
import { CountryFlag } from '@/components/common/country-flag';
import { AreaTrendChart, DonutChart } from '@/components/common/charts';
import { CustomerStatusBadge, LetterStatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  customerDetailPath,
  FOLLOW_UP_METHOD_LABEL,
  FOLLOW_UP_RESULT_LABEL,
  ROUTES,
} from '@/constants';
import { formatDate, formatMoney, formatRelative, initials } from '@/lib/format';
import { countryInfo } from '@/lib/country';
import { ErrorState, InlineLoader } from '@/components/common/empty-state';
import { SalesFunnel } from '@/components/dashboard/sales-funnel';
import { useDashboardNavigation } from '@/components/dashboard/dashboard-navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useOverviewStats } from '@/hooks/use-queries';
import { usePageTitle } from '@/hooks/use-ui';
import { useMetaStore } from '@/store/meta.store';
import { useProjectStore } from '@/store/project.store';
import { useUiStore } from '@/store/ui.store';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import { cn } from '@/lib/utils';
import { apiGet } from '@/lib/api';
import { useI18n } from '@/i18n';
import type { LetterStatus, OverviewStats } from '@/types';
import '@/components/dashboard/dashboard.css';

function MetricCard({
  label,
  value,
  detail,
  chip,
  chipTone = 'chip-muted',
  icon: Icon,
  iconClass = 'border-border/80 bg-surface text-foreground',
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  chip?: React.ReactNode;
  chipTone?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="dashboard-metric group">
      <span className="flex w-full items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors', iconClass)}
            aria-hidden
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">{label}</span>
        </span>
        {chip ? <span className={cn('chip hidden shrink-0 2xl:inline-flex', chipTone)}>{chip}</span> : null}
      </span>
      <strong className="dashboard-metric-value">{value}</strong>
      <span className="block truncate text-[11.5px] text-muted-foreground">{detail}</span>
    </button>
  );
}

const BAR_COLORS = [
  '#4F6BED', // Cobalt Indigo
  '#0D9488', // Ocean Teal
  '#F59E0B', // Warm Amber
  '#8B5CF6', // Royal Violet
  '#0284C7', // Cerulean Sky
  '#EC4899', // Coral Rose
  '#10B981', // Emerald
  '#94A3B8', // Slate
];

function BarList({ data, emptyLabel, total }: { data: { _id: string; count: number }[]; emptyLabel: string; total: number }): React.JSX.Element {
  if (!data.length) return <p className="py-5 text-xs text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...data.map((item) => item.count), 1);
  return (
    <ul className="mt-3 space-y-2.5">
      {data.map((item, idx) => {
        const color = BAR_COLORS[idx % BAR_COLORS.length];
        return (
          <li key={item._id || '未填写'}>
            <div className="mb-1 flex justify-between gap-3 text-xs">
              <span className="inline-flex min-w-0 items-center gap-2 font-medium text-foreground/90">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                <span className="truncate">{item._id || '未填写'}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{item.count}</strong> · {total ? Math.round((item.count / total) * 100) : 0}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/85" aria-hidden>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(3, (item.count / max) * 100)}%`, backgroundColor: color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type DockTab = 'suggest' | 'write' | 'knowledge' | 'analyze';

function EmbeddedAiDock({
  stats,
  projectName,
  onOpenCustomers,
  onOpenLetters,
}: {
  stats: OverviewStats;
  projectName: string;
  onOpenCustomers: (filter?: Record<string, string>) => void;
  onOpenLetters: (status?: LetterStatus | 'all') => void;
}): React.JSX.Element {
  const [tab, setTab] = React.useState<DockTab>('suggest');
  const [promptInput, setPromptInput] = React.useState('');
  const setAgentOpen = useUiStore((s) => s.setAgentOpen);
  const openAgentWithPrompt = useUiStore((s) => s.openAgentWithPrompt);

  const dueCount = stats.workspace.followUpToday + stats.workspace.followUpOverdue;

  const cardsByTab: Record<
    DockTab,
    Array<{
      icon: React.ComponentType<{ className?: string }>;
      accent: string;
      title: string;
      subtitle: string;
      prompt: string;
    }>
  > = {
    suggest: [
      {
        icon: Target,
        accent: 'text-rose-600 dark:text-rose-400',
        title: dueCount > 0 ? `优先跟进 ${dueCount} 位到期客户` : `梳理 ${stats.customer.pending} 位待开发客户`,
        subtitle: dueCount > 0 ? `含逾期 ${stats.workspace.followUpOverdue} 位 · 按意向排序` : '筛选今日可触达的高潜客户',
        prompt: '请梳理当前需要优先跟进的逾期与待开发客户，按优先级列出今日跟进建议。',
      },
      {
        icon: Mail,
        accent: 'text-indigo-600 dark:text-indigo-400',
        title: stats.letter.draft > 0 ? `审核 ${stats.letter.draft} 封待发草稿` : '起草首轮个性化开发信',
        subtitle: stats.letter.draft > 0 ? '核对语气、MOQ 与交期表述' : '挑选有邮箱的客户准备草稿',
        prompt: stats.letter.draft > 0
          ? '请帮我检查当前待发送的开发信草稿，核对语气与对外口径并给出优化建议。'
          : '请从当前待开发且有邮箱的客户中挑选重点对象，分析背景并准备开发信草稿（不要直接发送）。',
      },
      {
        icon: TrendingUp,
        accent: 'text-emerald-600 dark:text-emerald-400',
        title: '近期开发与回复诊断',
        subtitle: `近 7 天已发 ${stats.letter.sent7d} 封 · 开发率 ${stats.developmentRate}%`,
        prompt: `请分析 ${projectName} 当前的客户开发率、发信表现与漏斗转化情况，并给出 3 条可执行优化建议。`,
      },
    ],
    write: [
      {
        icon: Send,
        accent: 'text-indigo-600 dark:text-indigo-400',
        title: '撰写首封个性化开发信',
        subtitle: '结合客户官网与项目卖点',
        prompt: '请帮我挑选一位待开发重点客户，结合项目资料起草首封英文开发信草稿，不要直接发送。',
      },
      {
        icon: ReceiptText,
        accent: 'text-amber-600 dark:text-amber-400',
        title: '起草报价说明与跟进信',
        subtitle: '按目录阶梯价与贸易条款撰写',
        prompt: '请根据当前项目的对外口径，起草一封标准报价跟进邮件模板，突出交期与定制配合度。',
      },
      {
        icon: CalendarCheck2,
        accent: 'text-sky-600 dark:text-sky-400',
        title: '准备温和二轮/三轮跟进信',
        subtitle: '简短专业，提高买家回复意愿',
        prompt: '请为已发首封信但尚未回复的客户，准备一封简短得体的英文二次跟进草稿。',
      },
    ],
    knowledge: [
      {
        icon: BookOpen,
        accent: 'text-teal-600 dark:text-teal-400',
        title: '查产品规格与 MOQ 口径',
        subtitle: '基于已审核知识库与价格目录',
        prompt: '请列出当前项目已发布的重点产品规格、起订量（MOQ）与标准打样交期口径。',
      },
      {
        icon: Globe2,
        accent: 'text-violet-600 dark:text-violet-400',
        title: '查贸易条款与对外红线',
        subtitle: '核对付款方式、认证与禁用词',
        prompt: '请汇总当前项目的对外沟通红线、付款条款与不可随意承诺的事项。',
      },
      {
        icon: Users,
        accent: 'text-sky-600 dark:text-sky-400',
        title: '按市场/行业筛选重点客户',
        subtitle: '快速定位高潜与活跃档案',
        prompt: '请帮我查找当前项目下等级较高或近期活跃的重点海外客户，并简述各自状态。',
      },
    ],
    analyze: [
      {
        icon: Activity,
        accent: 'text-indigo-600 dark:text-indigo-400',
        title: '漏斗瓶颈与流失风险排查',
        subtitle: `当前共 ${stats.customer.total} 位客户档案`,
        prompt: '请诊断当前客户阶段分布，指出哪个环节积压最多，以及如何提升回复向报价转化。',
      },
      {
        icon: Globe2,
        accent: 'text-teal-600 dark:text-teal-400',
        title: '海外市场结构对比',
        subtitle: '结合国家与行业分布调整重心',
        prompt: '请根据当前客户国家分布与行业结构，分析我们最核心的目标市场并给出拓展建议。',
      },
      {
        icon: FilePenLine,
        accent: 'text-amber-600 dark:text-amber-400',
        title: '待补邮箱与资料完整度',
        subtitle: `${stats.customer.withoutEmail} 位客户缺少邮箱`,
        prompt: '请盘点当前缺少邮箱或关键资料不完整的客户情况，给出补全与清洗建议。',
      },
    ],
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const q = promptInput.trim();
    if (!q) {
      setAgentOpen(true);
      return;
    }
    openAgentWithPrompt(q);
    setPromptInput('');
  };

  return (
    <aside aria-label="AI 助手与待处理事项" className="flex flex-col xl:h-full">
      <div className="panel flex flex-1 flex-col divide-y divide-border/75 overflow-hidden">
        {/* Section 1: Minimal, Card-Free AI Assistant */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
              <h2 className="text-[0.9375rem] font-semibold tracking-[-0.015em] text-foreground">AI 助手</h2>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setAgentOpen(true)}
              title="展开完整对话"
              aria-label="展开完整对话"
            >
              <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>

          {/* Flat Underline Tabs */}
          <div className="flex items-center gap-4 border-b border-border/75 px-4 text-xs">
            {([
              ['suggest', '建议'],
              ['write', '写信'],
              ['knowledge', '查资料'],
              ['analyze', '分析'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  '-mb-px border-b-2 pb-2 pt-1 font-medium transition-colors',
                  tab === key
                    ? 'border-indigo-600 font-semibold text-foreground dark:border-indigo-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Flat Hairline Action Rows (Zero Nested Cards) */}
          <div className="divide-y divide-border/55 px-4">
            {cardsByTab[tab].map((item) => (
              <button
                key={item.title}
                type="button"
                onClick={() => openAgentWithPrompt(item.prompt)}
                className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface/80"
              >
                <item.icon className={cn('h-4 w-4 shrink-0', item.accent)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-medium text-foreground">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {item.subtitle}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
              </button>
            ))}
          </div>

          {/* Clean Inline Input */}
          <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2">
            <div className="flex items-end gap-2 rounded-xl border border-border/85 bg-surface/55 px-3 py-2 transition-colors focus-within:border-indigo-500/45 focus-within:bg-card">
              <textarea
                rows={1}
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder="问 AI 助手，例如：梳理逾期客户…"
                aria-label="向 AI 助手输入问题"
                className="max-h-20 min-h-[1.5rem] w-full resize-none bg-transparent text-xs leading-6 text-foreground outline-none placeholder:text-muted-foreground"
              />
              <Button type="submit" size="icon-xs" className="h-7 w-7 shrink-0 rounded-lg" aria-label="发送到 AI 助手">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </form>
        </div>

        {/* Section 2: Clean Natural Pending Checklist (Replaces Jargon & Nested Cards) */}
        <div className="p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">待处理事项</h3>
            <span className="text-[11px] text-muted-foreground">{projectName}</span>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {[
              {
                label: '逾期跟进',
                value: stats.workspace.followUpOverdue,
                dot: 'bg-rose-500',
                valClass: stats.workspace.followUpOverdue > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
                onClick: () => onOpenCustomers({ followUp: 'overdue' }),
              },
              {
                label: '待审草稿',
                value: stats.letter.draft,
                dot: 'bg-amber-500',
                valClass: stats.letter.draft > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-foreground',
                onClick: () => onOpenLetters('draft'),
              },
              {
                label: '待补邮箱',
                value: stats.customer.withoutEmail,
                dot: 'bg-sky-500',
                valClass: 'text-foreground',
                onClick: () => onOpenCustomers({ hasEmail: 'false' }),
              },
              {
                label: '发送异常',
                value: stats.letter.failed,
                dot: 'bg-red-500',
                valClass: stats.letter.failed > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground',
                onClick: () => onOpenLetters('failed'),
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className="group -mx-1.5 flex items-center justify-between rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface"
              >
                <span className="inline-flex items-center gap-2 text-muted-foreground group-hover:text-foreground">
                  <span className={cn('h-1.5 w-1.5 rounded-full', item.dot)} aria-hidden />
                  {item.label}
                </span>
                <strong className={cn('font-mono text-sm font-bold tabular-nums', item.valClass)}>
                  {item.value}
                </strong>
              </button>
            ))}
          </div>
        </div>

        {/* Section 3: Clean Flat Quick Links */}
        <div className="flex flex-1 flex-col p-4">
          <h3 className="text-xs font-semibold text-foreground">快捷入口</h3>
          <div className="mt-2 divide-y divide-border/50 text-xs">
            {[
              { label: '客户线索池', sub: '官网抓取与邮箱补全', to: ROUTES.prospecting, icon: Target, accent: 'text-indigo-600 dark:text-indigo-400' },
              { label: '全渠道会话', sub: 'WhatsApp · 阿里 · 微信', to: ROUTES.channels, icon: Globe2, accent: 'text-emerald-600 dark:text-emerald-400' },
              { label: '报价与 RFQ', sub: '阶梯价核对与 PDF 导出', to: ROUTES.quotations, icon: ReceiptText, accent: 'text-amber-600 dark:text-amber-400' },
              { label: '自动开发', sub: '多轮邮件跟进排程', to: ROUTES.outreachAutomation, icon: Send, accent: 'text-violet-600 dark:text-violet-400' },
              { label: '知识库', sub: '产品资料与对外口径', to: '/knowledge', icon: BookOpen, accent: 'text-teal-600 dark:text-teal-400' },
            ].map((nav) => (
              <Link
                key={nav.to}
                to={nav.to}
                className="group -mx-2 flex items-center justify-between gap-2.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface/80"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <nav.icon className={cn('h-4 w-4 shrink-0', nav.accent)} aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{nav.label}</p>
                    <p className="truncate text-[10.5px] text-muted-foreground">{nav.sub}</p>
                  </div>
                </div>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { t, language } = useI18n();
  usePageTitle(t('dashboard.title'));
  const [range, setRange] = React.useState<'today' | '7d' | '30d' | 'month' | 'all'>('30d');
  const [taskView, setTaskView] = React.useState<'priority' | 'recent'>('priority');
  const [chartTab, setChartTab] = React.useState<'letters' | 'funnel' | 'industry'>('letters');

  const { data, loading, error, run } = useOverviewStats(range);
  const mailChannel = useMetaStore((state) => state.mailChannel);
  const project = useProjectStore((state) => state.activeProject);
  const user = useAuthStore((state) => state.user);
  const canManage = useAuthStore(selectCanManageProjects);
  const [onboarding, setOnboarding] = React.useState<{ completedAt?: string; doneCount: number; totalCount: number } | null>(null);

  React.useEffect(() => {
    if (!canManage) {
      setOnboarding(null);
      return;
    }
    void apiGet<{ completedAt?: string; doneCount: number; totalCount: number }>('/projects/onboarding')
      .then(setOnboarding)
      .catch(() => undefined);
  }, [canManage, project?.id]);

  const { openCustomers, openLetters } = useDashboardNavigation();
  const dateLabel = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());

  const userName = user?.displayName || user?.username || (language === 'zh' ? '伙伴' : 'Team');
  const dueCount = data ? data.workspace.followUpToday + data.workspace.followUpOverdue : 0;

  const metrics = data
    ? [
        {
          label: language === 'zh' ? '客户总数' : 'Total Customers',
          value: data.customer.total.toLocaleString('zh-CN'),
          detail: language === 'zh' ? `${data.customer.withEmail} 位有邮箱` : `${data.customer.withEmail} with email`,
          chip: data.customer.contacted7d > 0 ? `近7日 ${data.customer.contacted7d}` : `${data.customer.withEmail}`,
          chipTone: 'chip-muted',
          icon: Users,
          iconClass: 'border-indigo-200/75 bg-indigo-50/75 text-indigo-600 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-300',
          action: () => openCustomers(),
        },
        {
          label: language === 'zh' ? '跟进到期' : 'Follow-ups Due',
          value: dueCount.toLocaleString('zh-CN'),
          detail: language === 'zh'
            ? `今日 ${data.workspace.followUpToday} · 逾期 ${data.workspace.followUpOverdue}`
            : `${data.workspace.followUpToday} today · ${data.workspace.followUpOverdue} overdue`,
          chip: data.workspace.followUpOverdue > 0 ? `逾期 ${data.workspace.followUpOverdue}` : undefined,
          chipTone: 'chip-rose',
          icon: CalendarCheck2,
          iconClass: data.workspace.followUpOverdue > 0
            ? 'border-rose-200/75 bg-rose-50/75 text-rose-600 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300'
            : 'border-amber-200/75 bg-amber-50/75 text-amber-600 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300',
          action: () => openCustomers({ followUp: data.workspace.followUpOverdue > 0 ? 'overdue' : 'today' }),
        },
        {
          label: language === 'zh' ? '待开发客户' : 'Pending Leads',
          value: data.customer.pending.toLocaleString('zh-CN'),
          detail: language === 'zh'
            ? `待审草稿 ${data.letter.draft} 封`
            : `${data.letter.draft} drafts ready`,
          icon: Target,
          iconClass: 'border-sky-200/75 bg-sky-50/75 text-sky-600 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300',
          action: () => openCustomers({ status: 'pending' }),
        },
        {
          label: language === 'zh' ? '近 7 天发送' : 'Sent (7d)',
          value: data.letter.sent7d.toLocaleString('zh-CN'),
          detail: language === 'zh' ? `近 30 天 ${data.letter.sent30d} 封` : `${data.letter.sent30d} in 30d`,
          icon: Send,
          iconClass: 'border-violet-200/75 bg-violet-50/75 text-violet-600 dark:border-violet-500/25 dark:bg-violet-500/10 dark:text-violet-300',
          action: () => openLetters(),
        },
        {
          label: language === 'zh' ? '客户开发率' : 'Coverage Rate',
          value: `${data.developmentRate}%`,
          detail: language === 'zh'
            ? `已开发 ${data.customer.developed}/${data.customer.total}`
            : `${data.customer.developed}/${data.customer.total} contacted`,
          chip: `${data.developmentRate}%`,
          chipTone: 'chip-mint',
          icon: TrendingUp,
          iconClass: 'border-emerald-200/75 bg-emerald-50/75 text-emerald-600 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300',
          action: () => openCustomers(),
        },
      ]
    : [];

  const trendPoints = React.useMemo(
    () =>
      (data?.letter.byDay ?? []).slice(-14).map((item) => ({
        label: item._id.slice(5),
        value: item.count,
      })),
    [data?.letter.byDay],
  );

  const countrySlices = React.useMemo(() => {
    const list = data?.analytics?.countryDistribution ?? [];
    return list.map((c) => ({
      label: c.country,
      value: c.count,
      pct: c.pct,
    }));
  }, [data?.analytics?.countryDistribution]);

  const unifiedActivity = React.useMemo(() => {
    if (!data) return [];
    const followItems = data.workspace.recentFollowUps.map((f) => ({
      id: `f-${f.id}`,
      at: new Date(f.followUpAt).getTime(),
      timeLabel: formatRelative(f.followUpAt),
      title: `${f.customerName} · ${FOLLOW_UP_METHOD_LABEL[f.method] ?? f.method}`,
      subtitle: `${FOLLOW_UP_RESULT_LABEL[f.result] ?? f.result} — ${f.content}`,
      to: customerDetailPath(f.customerId),
      kind: 'followup' as const,
    }));
    const letterItems = data.recentLetters.map((l) => ({
      id: `l-${l.id}`,
      at: new Date(l.sentAt || l.updatedAt || l.createdAt).getTime(),
      timeLabel: l.sentAt ? formatRelative(l.sentAt) : '草稿待发',
      title: l.subject || '（无主题开发信）',
      subtitle: `${l.recipientName || l.recipientEmail} · ${l.status === 'sent' ? '开发信已发出' : l.status === 'draft' ? '已保存草稿' : l.status}`,
      to: l.customer ? customerDetailPath(l.customer.id) : ROUTES.letters,
      kind: 'letter' as const,
      letterStatus: l.status,
    }));
    return [...followItems, ...letterItems].sort((a, b) => b.at - a.at).slice(0, 6);
  }, [data]);

  const priorityCustomers = React.useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const merged: Array<{
      id: string;
      name: string;
      subtitle: string;
      country?: string;
      status: OverviewStats['workspace']['recentCustomers'][number]['status'];
      tag: string;
      urgent: boolean;
    }> = [];

    for (const c of data.workspace.overdueCustomers) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push({
        id: c.id,
        name: c.name,
        subtitle: [c.company && c.company !== c.name ? c.company : '', countryInfo(c.country)?.name, c.industry].filter(Boolean).join(' · ') || '逾期跟进客户',
        country: c.country,
        status: c.status,
        tag: `逾期 · ${formatDate(c.nextFollowUpAt)}`,
        urgent: true,
      });
    }
    for (const c of data.workspace.todayFollowUpCustomers) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push({
        id: c.id,
        name: c.name,
        subtitle: [c.company && c.company !== c.name ? c.company : '', countryInfo(c.country)?.name, c.industry].filter(Boolean).join(' · ') || '今日待跟进客户',
        country: c.country,
        status: c.status,
        tag: '今日到期',
        urgent: false,
      });
    }
    if (merged.length < 5) {
      for (const c of data.workspace.recentCustomers) {
        if (seen.has(c.id) || merged.length >= 5) continue;
        seen.add(c.id);
        merged.push({
          id: c.id,
          name: c.name,
          subtitle: [c.company && c.company !== c.name ? c.company : '', countryInfo(c.country)?.name, c.industry].filter(Boolean).join(' · ') || '新加入客户',
          country: c.country,
          status: c.status,
          tag: formatRelative(c.createdAt),
          urgent: false,
        });
      }
    }
    return merged.slice(0, 6);
  }, [data]);

  return (
    <div className="workspace-page dashboard-page">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_316px] xl:items-stretch 2xl:grid-cols-[minmax(0,1fr)_344px]">
        {/* Left Main Workspace Column */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Unified Trade OS Command Header + Integrated Telemetry Ribbon */}
          <section className="panel overflow-hidden">
            <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span>{dateLabel} · <strong className="font-semibold text-foreground">{project?.name || (language === 'zh' ? '当前项目' : 'Workspace')}</strong></span>
                  {mailChannel === 'mock' ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50/80 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">
                      模拟发送模式
                    </span>
                  ) : null}
                  {canManage && onboarding && !onboarding.completedAt ? (
                    <Link
                      to={ROUTES.onboarding}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[10.5px] font-medium text-foreground transition-colors hover:border-foreground/30"
                    >
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      初始化进度 {onboarding.doneCount}/{onboarding.totalCount} →
                    </Link>
                  ) : null}
                </div>
                <h1 className="mt-1.5 text-[1.45rem] font-semibold leading-tight tracking-[-0.03em] text-foreground sm:text-[1.65rem]">
                  {language === 'zh' ? `你好，${userName}` : `Hello, ${userName}`}
                </h1>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  {data
                    ? language === 'zh'
                      ? dueCount > 0
                        ? `智能外贸工作台已就绪：当前有 ${dueCount} 位客户待跟进、${data.letter.draft} 封草稿待审核。`
                        : `智能外贸工作台已就绪：跟进计划井然有序，可推进客户发现与阶梯报价。`
                      : dueCount > 0
                        ? `Trade OS ready: ${dueCount} follow-ups and ${data.letter.draft} drafts await review.`
                        : `Trade OS ready: follow-ups are on track.`
                    : t('dashboard.subtitle')}
                </p>
              </div>

              <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="os-segmented">
                    {([
                      ['today', language === 'zh' ? '今日' : 'Today'],
                      ['7d', language === 'zh' ? '近7天' : '7d'],
                      ['30d', language === 'zh' ? '近30天' : '30d'],
                      ['month', language === 'zh' ? '本月' : 'Month'],
                      ['all', language === 'zh' ? '全部' : 'All'],
                    ] as const).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setRange(key)}
                        className={cn('os-segmented-item', range === key && 'os-segmented-item-active')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void run()} loading={loading}>
                    {!loading ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : null}
                    {language === 'zh' ? '刷新' : 'Refresh'}
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={ROUTES.quotations}><ReceiptText className="h-3.5 w-3.5" aria-hidden />{language === 'zh' ? '报价与 RFQ' : 'Quotes & RFQ'}</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={ROUTES.prospecting}><Target className="h-3.5 w-3.5" aria-hidden />{language === 'zh' ? '客户发现' : 'Prospecting'}</Link>
                  </Button>
                  <Button size="sm" onClick={() => openCustomers()}>
                    <Users className="h-3.5 w-3.5" aria-hidden />{language === 'zh' ? '客户管理' : 'Customers'}
                  </Button>
                </div>
              </div>
            </div>

            {data ? (
              <div aria-label="业务概览" className="dashboard-telemetry">
                {metrics.map((metric) => (
                  <MetricCard
                    key={metric.label}
                    label={metric.label}
                    value={metric.value}
                    detail={metric.detail}
                    chip={metric.chip}
                    chipTone={metric.chipTone}
                    icon={metric.icon}
                    iconClass={metric.iconClass}
                    onClick={metric.action}
                  />
                ))}
              </div>
            ) : null}
          </section>

          {error ? (
            <Alert variant="warning">
              <AlertDescription>{data ? '刷新失败，以下保留上次加载的数据。' : '统计数据暂时无法加载。'}</AlertDescription>
            </Alert>
          ) : null}

          {error && !data ? (
            <ErrorState title="工作台加载失败" description={error} onRetry={() => void run()} retrying={loading} />
          ) : !data ? (
            <div className="panel py-12"><InlineLoader label="正在加载销售工作台…" /></div>
          ) : (
            <>

              {/* Side-by-Side Dual Cards: 今日重点任务 + 业务动态 */}
              <section aria-label="今日重点任务与业务动态" className="grid gap-4 lg:grid-cols-2">
                {/* Left Card: 今日重点任务 */}
                <div className="panel flex flex-col p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex shrink-0 items-center gap-2">
                      <h2 className="section-title whitespace-nowrap">今日重点任务</h2>
                      <span className="chip chip-muted tabular-nums">{dueCount || priorityCustomers.length}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setTaskView('priority')}
                        className={cn(
                          'whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
                          taskView === 'priority' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        优先跟进
                      </button>
                      <button
                        type="button"
                        onClick={() => setTaskView('recent')}
                        className={cn(
                          'whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
                          taskView === 'recent' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        最近加入
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex-1">
                    {taskView === 'priority' ? (
                      priorityCustomers.length === 0 ? (
                        <div className="flex min-h-[13rem] flex-col items-center justify-center text-center">
                          <p className="text-xs font-medium text-foreground">暂无待处理客户</p>
                          <p className="mt-1 text-xs text-muted-foreground">前往客户发现或客户管理添加首批外贸客户</p>
                          <Button size="sm" variant="outline" className="mt-3" onClick={() => openCustomers()}>
                            进入客户管理
                          </Button>
                        </div>
                      ) : (
                        <ul className="divide-y divide-border/75">
                          {priorityCustomers.map((item) => (
                            <li key={item.id}>
                              <Link
                                to={customerDetailPath(item.id)}
                                className="group -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface"
                              >
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <span className="avatar-bubble flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-[11px] font-semibold">
                                    {initials(item.name)}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="truncate text-[0.8125rem] font-medium text-foreground group-hover:underline">
                                      {item.name}
                                    </p>
                                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                                      <CountryFlag value={item.country} />
                                      <span className="truncate">{item.subtitle}</span>
                                    </p>
                                  </div>
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-0.5">
                                  <CustomerStatusBadge status={item.status} />
                                  <span className={cn('text-[10.5px] tabular-nums', item.urgent ? 'font-semibold text-rose' : 'text-muted-foreground')}>
                                    {item.tag}
                                  </span>
                                </div>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )
                    ) : data.workspace.recentCustomers.length === 0 ? (
                      <p className="py-12 text-center text-xs text-muted-foreground">暂无最近加入客户</p>
                    ) : (
                      <ul className="divide-y divide-border/75">
                        {data.workspace.recentCustomers.slice(0, 6).map((c) => (
                          <li key={c.id}>
                            <Link
                              to={customerDetailPath(c.id)}
                              className="group -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface"
                            >
                              <div className="flex min-w-0 items-center gap-2.5">
                                <span className="avatar-bubble flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-[11px] font-semibold">
                                  {initials(c.name)}
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate text-[0.8125rem] font-medium text-foreground group-hover:underline">{c.name}</p>
                                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                                    {[c.company, countryInfo(c.country)?.name, c.industry].filter(Boolean).join(' · ') || '客户档案'}
                                  </p>
                                </div>
                              </div>
                              <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(c.createdAt)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-border/75 pt-3 text-xs">
                    <span className="text-muted-foreground">
                      逾期 {data.workspace.followUpOverdue} · 今日 {data.workspace.followUpToday}
                    </span>
                    <button
                      type="button"
                      onClick={() => openCustomers()}
                      className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                    >
                      全部客户 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </div>

                {/* Right Card: 业务动态时间线 */}
                <div className="panel flex flex-col p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h2 className="section-title">业务动态</h2>
                      <span className="chip chip-muted tabular-nums">{unifiedActivity.length}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openLetters()}
                      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      开发信记录 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>

                  <div className="mt-3 flex-1">
                    {unifiedActivity.length === 0 ? (
                      <div className="flex min-h-[13rem] flex-col items-center justify-center text-center">
                        <p className="text-xs font-medium text-foreground">暂无近期沟通与发信动态</p>
                        <p className="mt-1 text-xs text-muted-foreground">发送开发信或记录客户跟进后，实时时间线会呈现在这里</p>
                      </div>
                    ) : (
                      <ul className="relative space-y-3 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
                        {unifiedActivity.map((act) => (
                          <li key={act.id} className="relative">
                            <span
                              className={cn(
                                'absolute -left-4 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-card',
                                act.kind === 'followup' ? 'bg-foreground' : 'bg-muted-foreground/65',
                              )}
                              aria-hidden
                            />
                            <Link to={act.to} className="group block rounded-lg px-2 py-1 -mx-2 transition-colors hover:bg-surface">
                              <div className="flex items-baseline justify-between gap-2">
                                <p className="truncate text-[0.8125rem] font-medium text-foreground group-hover:underline">
                                  {act.title}
                                </p>
                                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{act.timeLabel}</span>
                              </div>
                              <div className="mt-0.5 flex items-center justify-between gap-2">
                                <p className="truncate text-[11.5px] text-muted-foreground">{act.subtitle}</p>
                                {act.kind === 'letter' ? <LetterStatusBadge status={act.letterStatus} /> : null}
                              </div>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-border/75 pt-3 text-xs text-muted-foreground">
                    <span>近 7 天已联系 {data.customer.contacted7d} 位客户</span>
                    <span>累计发送 {data.letter.sent} 封</span>
                  </div>
                </div>
              </section>

              {/* Active Pipeline Progress Strip (Real Data, Zero Fake Assets) */}
              {data.analytics ? (
                <section aria-label="阶段推进概览" className="panel p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="section-title">正在推进的业务漏斗</h2>
                    <span className="text-xs text-muted-foreground">
                      在谈报价 {formatMoney(data.analytics.quotationMetrics.pipelineAmount, 'USD')} · 已成交 {formatMoney(data.analytics.quotationMetrics.acceptedAmount, 'USD')}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {data.analytics.conversionFunnel.slice(0, 3).map((stage, idx) => {
                      const stageVisual = [
                        { bar: 'bg-indigo-500', badge: 'text-indigo-600 dark:text-indigo-400', dot: 'bg-indigo-500' },
                        { bar: 'bg-sky-500', badge: 'text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
                        { bar: 'bg-emerald-500', badge: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
                      ][idx] ?? { bar: 'bg-indigo-500', badge: 'text-foreground', dot: 'bg-indigo-500' };
                      return (
                        <div key={stage.stage} className="rounded-lg border border-border/80 bg-surface/55 p-3">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                              <span className={cn('h-2 w-2 rounded-full', stageVisual.dot)} aria-hidden />
                              {stage.label}
                            </span>
                            <span className={cn('font-mono text-[11px] font-bold tabular-nums', stageVisual.badge)}>{stage.rate}%</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">当前阶段客户 {stage.count} 位</p>
                          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn('h-full rounded-full transition-all', stageVisual.bar)}
                              style={{ width: `${Math.max(stage.count > 0 ? 6 : 0, stage.rate)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {/* Bottom Charts Row: 关键指标趋势 (Multi-tab) + 客户分布 Top 5 */}
              <section aria-label="关键指标趋势与市场分布" className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                <div className="panel p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="section-title">关键指标趋势</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        累计开发信 {data.letter.total} 封 · 已发送 {data.letter.sent} 封 · 草稿 {data.letter.draft} 封
                      </p>
                    </div>
                    <div className="os-segmented">
                      {([
                        ['letters', '开发信发送'],
                        ['funnel', '阶段漏斗'],
                        ['industry', '行业分布'],
                      ] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setChartTab(key)}
                          className={cn('os-segmented-item', chartTab === key && 'os-segmented-item-active')}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4">
                    {chartTab === 'letters' ? (
                      <AreaTrendChart data={trendPoints} unit="封" height={184} emptyLabel="暂无开发信发送记录" />
                    ) : chartTab === 'funnel' ? (
                      <SalesFunnel byStatus={data.customer.byStatus} total={data.customer.total} />
                    ) : (
                      <BarList data={data.customer.byIndustry.slice(0, 6)} total={data.customer.total} emptyLabel="还没有填写客户行业" />
                    )}
                  </div>
                </div>

                <div className="panel p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="section-title">客户分布（Top 5）</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">当前工作空间核心海外市场结构</p>
                    </div>
                    <Badge variant="outline" className="tabular-nums">{data.customer.total} 位</Badge>
                  </div>
                  <div className="mt-4">
                    {countrySlices.length === 0 ? (
                      <p className="py-12 text-center text-xs text-muted-foreground">当前区间暂无客户国家分布数据</p>
                    ) : (
                      <DonutChart
                        slices={countrySlices}
                        centerValue={data.customer.total.toLocaleString('zh-CN')}
                        centerLabel="客户总数"
                      />
                    )}
                  </div>
                </div>
              </section>

              {/* Collapsible Deep Structure Breakdown */}
              <details className="dashboard-analysis panel group">
                <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <h2 className="section-title">更多客户等级与高优建议拆解</h2>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">按等级、行业与未决事项查看完整结构</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="dashboard-analysis-grid">
                  <div className="well p-4">
                    <SalesFunnel byStatus={data.customer.byStatus} total={data.customer.total} />
                  </div>
                  <section aria-labelledby="industry-distribution-title" className="well p-4">
                    <h3 id="industry-distribution-title" className="section-title">行业分布</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">按客户数量排序前 8 项</p>
                    <BarList data={data.customer.byIndustry.slice(0, 8)} total={data.customer.total} emptyLabel="还没有填写行业" />
                  </section>
                  <section aria-labelledby="grade-distribution-title" className="well p-4">
                    <h3 id="grade-distribution-title" className="section-title">客户等级</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">按等级统计</p>
                    <BarList data={data.customer.byGrade.slice(0, 6)} total={data.customer.total} emptyLabel="还没有设置等级" />
                  </section>
                </div>
              </details>
            </>
          )}
        </div>

        {/* Right Sticky Embedded AI Foreign-Trade Assistant Dock */}
        {data ? (
          <EmbeddedAiDock
            stats={data}
            projectName={project?.name || '当前项目'}
            onOpenCustomers={openCustomers}
            onOpenLetters={openLetters}
          />
        ) : null}
      </div>
    </div>
  );
}
