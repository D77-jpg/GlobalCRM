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
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  chip?: React.ReactNode;
  chipTone?: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="dashboard-metric group">
      <span className="flex w-full items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface text-foreground transition-colors group-hover:border-foreground/25"
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

function BarList({ data, emptyLabel, total }: { data: { _id: string; count: number }[]; emptyLabel: string; total: number }): React.JSX.Element {
  if (!data.length) return <p className="py-5 text-xs text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...data.map((item) => item.count), 1);
  return (
    <ul className="mt-3 space-y-2.5">
      {data.map((item) => (
        <li key={item._id || '未填写'}>
          <div className="mb-1 flex justify-between gap-3 text-xs">
            <span className="truncate font-medium text-foreground/90">{item._id || '未填写'}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {item.count} · {total ? Math.round((item.count / total) * 100) : 0}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-foreground/80 transition-all" style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
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
      title: string;
      subtitle: string;
      prompt: string;
    }>
  > = {
    suggest: [
      {
        icon: Target,
        title: dueCount > 0 ? `优先推进 ${dueCount} 位到期跟进客户` : `梳理 ${stats.customer.pending} 位待开发客户`,
        subtitle: dueCount > 0 ? `含逾期 ${stats.workspace.followUpOverdue} 位 · 按采购意向排优先级` : '结合行业与资料完整度推荐今日触达名单',
        prompt: '请梳理当前需要优先跟进的逾期与待开发客户，按优先级列出今日跟进建议。',
      },
      {
        icon: Mail,
        title: stats.letter.draft > 0 ? `审核 ${stats.letter.draft} 封待发开发信草稿` : '起草首轮个性化开发信',
        subtitle: stats.letter.draft > 0 ? '对照项目对外口径核验语气、MOQ 与交期表述' : '挑选有邮箱的高潜客户生成待审草稿',
        prompt: stats.letter.draft > 0
          ? '请帮我检查当前待发送的开发信草稿，核对语气与对外口径并给出优化建议。'
          : '请从当前待开发且有邮箱的客户中挑选重点对象，分析背景并准备开发信草稿（不要直接发送）。',
      },
      {
        icon: TrendingUp,
        title: '近期开发与回复效果诊断',
        subtitle: `近 7 天已发 ${stats.letter.sent7d} 封 · 整体开发率 ${stats.developmentRate}%`,
        prompt: `请分析 ${projectName} 当前的客户开发率、发信表现与漏斗转化情况，并给出 3 条可执行优化建议。`,
      },
    ],
    write: [
      {
        icon: Send,
        title: '为高潜客户撰写首封开发信',
        subtitle: '自动结合官网、行业痛点与项目产品卖点',
        prompt: '请帮我挑选一位待开发重点客户，结合项目资料起草首封英文开发信草稿，不要直接发送。',
      },
      {
        icon: ReceiptText,
        title: '生成报价说明与阶梯价跟进信',
        subtitle: '严守目录阶梯价与贸易条款，不越权承诺',
        prompt: '请根据当前项目的对外口径，起草一封标准报价跟进邮件模板，突出交期与定制配合度。',
      },
      {
        icon: CalendarCheck2,
        title: '准备温和二轮/三轮催复邮件',
        subtitle: '简短专业、不施压，提升买家回复意愿',
        prompt: '请为已发首封信但尚未回复的客户，准备一封简短得体的英文二次跟进草稿。',
      },
    ],
    knowledge: [
      {
        icon: BookOpen,
        title: '检索项目产品规格与 MOQ 口径',
        subtitle: '仅引用已审核发布的知识库与价格表',
        prompt: '请列出当前项目已发布的重点产品规格、起订量（MOQ）与标准打样交期口径。',
      },
      {
        icon: Globe2,
        title: '核对贸易条款与对外沟通红线',
        subtitle: '查看付款方式、认证资质与禁用承诺词',
        prompt: '请汇总当前项目的对外沟通红线、付款条款与不可随意承诺的事项。',
      },
      {
        icon: Users,
        title: '查找特定国家或行业目标客户',
        subtitle: '按市场、等级与联系状态快速定位档案',
        prompt: '请帮我查找当前项目下等级较高或近期活跃的重点海外客户，并简述各自状态。',
      },
    ],
    analyze: [
      {
        icon: Activity,
        title: '销售漏斗瓶颈与流失风险排查',
        subtitle: `当前在谈与待跟进共 ${stats.customer.total} 位客户档案`,
        prompt: '请诊断当前客户阶段分布，指出哪个环节积压最多，以及如何提升回复向报价转化。',
      },
      {
        icon: Globe2,
        title: '重点海外市场结构对比',
        subtitle: '结合国家与行业分布调整开发重心',
        prompt: '请根据当前客户国家分布与行业结构，分析我们最核心的目标市场并给出拓展建议。',
      },
      {
        icon: FilePenLine,
        title: '待补邮箱与资料完整度盘点',
        subtitle: `当前 ${stats.customer.withoutEmail} 位客户缺少联系邮箱`,
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
    <aside aria-label="AI 外贸助手工作舱" className="flex flex-col gap-4 xl:h-full">
      <div className="panel flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-2 border-b border-border p-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[0.9375rem] font-semibold leading-snug tracking-[-0.015em] text-foreground">
                AI 外贸副驾驶
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                联动客户、邮件、知识库与核价单
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setAgentOpen(true)}
            title="展开完整助手抽屉"
            aria-label="展开完整助手抽屉"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Category Switcher Pills */}
        <div className="grid grid-cols-4 gap-1 border-b border-border bg-surface/80 px-2.5 py-1.5">
          {([
            ['suggest', '建议执行'],
            ['write', '写邮件'],
            ['knowledge', '查资料'],
            ['analyze', '分析'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-all',
                tab === key
                  ? 'bg-card font-semibold text-foreground shadow-xs ring-1 ring-border/80'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Actionable Prompt Cards */}
        <div className="space-y-2 p-3.5">
          {cardsByTab[tab].map((card) => (
            <button
              key={card.title}
              type="button"
              onClick={() => openAgentWithPrompt(card.prompt)}
              className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface/45 p-2.5 text-left transition-all hover:border-foreground/25 hover:bg-card hover:shadow-sm"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card text-foreground">
                <card.icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-semibold text-foreground">
                  {card.title}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {card.subtitle}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
            </button>
          ))}
        </div>

        {/* Direct Inline Composer */}
        <form onSubmit={handleSubmit} className="border-t border-border p-3.5">
          <div className="rounded-lg border border-border bg-surface/50 p-2.5 transition-colors focus-within:border-foreground/35 focus-within:bg-card">
            <textarea
              rows={2}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="输入外贸任务指令，例如：梳理今日逾期客户…"
              aria-label="向 AI 外贸助手输入指令"
              className="w-full resize-none bg-transparent text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-muted-foreground">结合当前项目资料 · 人工审核发送</span>
              <Button type="submit" size="icon-xs" className="h-7 w-7 rounded-md" aria-label="发送到 AI 助手">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </form>
      </div>

      {/* Trade OS Live Dispatch & Execution Rail — Stretches cleanly to eliminate bottom void */}
      <div className="panel flex flex-1 flex-col justify-between p-4">
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-foreground">待办脉冲与风险队列</h3>
            <span className="text-[11px] text-muted-foreground">{projectName}</span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={() => onOpenCustomers({ followUp: 'overdue' })}
              className="flex flex-col rounded-lg border border-border/80 bg-surface/55 p-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-card"
            >
              <span className="text-[11px] text-muted-foreground">逾期跟进</span>
              <strong className={cn('mt-1 text-lg font-bold tabular-nums', stats.workspace.followUpOverdue > 0 ? 'text-rose' : 'text-foreground')}>
                {stats.workspace.followUpOverdue}
              </strong>
            </button>
            <button
              type="button"
              onClick={() => onOpenLetters('draft')}
              className="flex flex-col rounded-lg border border-border/80 bg-surface/55 p-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-card"
            >
              <span className="text-[11px] text-muted-foreground">待审草稿</span>
              <strong className="mt-1 text-lg font-bold tabular-nums text-foreground">{stats.letter.draft}</strong>
            </button>
            <button
              type="button"
              onClick={() => onOpenCustomers({ hasEmail: 'false' })}
              className="flex flex-col rounded-lg border border-border/80 bg-surface/55 p-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-card"
            >
              <span className="text-[11px] text-muted-foreground">待补邮箱</span>
              <strong className="mt-1 text-lg font-bold tabular-nums text-foreground">{stats.customer.withoutEmail}</strong>
            </button>
            <button
              type="button"
              onClick={() => onOpenLetters('failed')}
              className="flex flex-col rounded-lg border border-border/80 bg-surface/55 p-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-card"
            >
              <span className="text-[11px] text-muted-foreground">发送异常</span>
              <strong className={cn('mt-1 text-lg font-bold tabular-nums', stats.letter.failed > 0 ? 'text-rose' : 'text-foreground')}>
                {stats.letter.failed}
              </strong>
            </button>
          </div>

          <div className="mt-4 border-t border-border/75 pt-3.5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-foreground">Trade OS 业务中枢直达</h3>
            <div className="mt-2.5 space-y-1.5 text-xs">
              {[
                { label: '客户发现与公海线索', sub: 'AI 官网抓取 · 邮箱补全', to: ROUTES.prospecting, icon: Target },
                { label: '全渠道客户会话', sub: 'WhatsApp · 阿里 · 双语副驾驶', to: ROUTES.channels, icon: Globe2 },
                { label: '外贸报价与 RFQ 核价', sub: '阶梯价校验 · 一键导出 PDF', to: ROUTES.quotations, icon: ReceiptText },
                { label: '多轮自动开发节律', sub: '0 / 3 / 7 天买方时区触达', to: ROUTES.outreachAutomation, icon: Send },
                { label: '企业知识大脑与红线', sub: '已审事实依据 · 对外口径护栏', to: '/knowledge', icon: BookOpen },
              ].map((nav) => (
                <Link
                  key={nav.to}
                  to={nav.to}
                  className="group flex items-center justify-between gap-2.5 rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-border hover:bg-surface/75"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface text-foreground">
                      <nav.icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{nav.label}</p>
                      <p className="truncate text-[10.5px] text-muted-foreground">{nav.sub}</p>
                    </div>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-all group-hover:translate-x-0.5 group-hover:text-foreground group-hover:opacity-100" aria-hidden />
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border/75 bg-surface/55 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Trade OS 护栏已激活：</span>
          所有跨项目数据严格物理隔离，AI 生成草稿均经口径核验并需人工确认后发出。
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
          action: () => openCustomers({ followUp: data.workspace.followUpOverdue > 0 ? 'overdue' : 'today' }),
        },
        {
          label: language === 'zh' ? '待开发客户' : 'Pending Leads',
          value: data.customer.pending.toLocaleString('zh-CN'),
          detail: language === 'zh'
            ? `待审草稿 ${data.letter.draft} 封`
            : `${data.letter.draft} drafts ready`,
          icon: Target,
          action: () => openCustomers({ status: 'pending' }),
        },
        {
          label: language === 'zh' ? '近 7 天发送' : 'Sent (7d)',
          value: data.letter.sent7d.toLocaleString('zh-CN'),
          detail: language === 'zh' ? `近 30 天 ${data.letter.sent30d} 封` : `${data.letter.sent30d} in 30d`,
          icon: Send,
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
                    {data.analytics.conversionFunnel.slice(0, 3).map((stage) => (
                      <div key={stage.stage} className="rounded-lg border border-border/80 bg-surface/55 p-3">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-foreground">{stage.label}</span>
                          <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">{stage.rate}%</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">当前阶段客户 {stage.count} 位</p>
                        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-foreground transition-all"
                            style={{ width: `${Math.max(stage.count > 0 ? 6 : 0, stage.rate)}%` }}
                          />
                        </div>
                      </div>
                    ))}
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
