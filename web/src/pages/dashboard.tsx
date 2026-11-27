import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  Globe2,
  Mail,
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
import { Badge } from '@/components/ui/badge';
import { customerDetailPath, MAIL_CHANNEL_LABEL, ROUTES } from '@/constants';
import { formatMoney } from '@/lib/format';
import { ErrorState, InlineLoader } from '@/components/common/empty-state';
import { SalesFunnel } from '@/components/dashboard/sales-funnel';
import { SalesWorkspaceSection } from '@/components/dashboard/sales-workspace';
import { useDashboardNavigation } from '@/components/dashboard/dashboard-navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useOverviewStats } from '@/hooks/use-queries';
import { usePageTitle } from '@/hooks/use-ui';
import { useMetaStore } from '@/store/meta.store';
import { useProjectStore } from '@/store/project.store';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import { cn } from '@/lib/utils';
import { apiGet } from '@/lib/api';
import { useI18n } from '@/i18n';
import '@/components/dashboard/dashboard.css';

type MetricTone = 'mint' | 'violet' | 'amber' | 'rose';

function MetricCard({
  label,
  value,
  detail,
  chip,
  icon: Icon,
  tone = 'violet',
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  chip: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  tone?: MetricTone;
  onClick: () => void;
}): React.JSX.Element {
  const iconTone = {
    mint: 'bg-primary-soft text-primary',
    violet: 'bg-primary-soft text-primary',
    amber: 'bg-amberx-soft text-amberx',
    rose: 'bg-rose-soft text-rose',
  }[tone];

  const chipTone = {
    mint: 'chip-mint',
    violet: 'chip-violet',
    amber: 'chip-amber',
    rose: 'chip-rose',
  }[tone];

  return (
    <button type="button" onClick={onClick} className="dashboard-metric group">
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-transform duration-150 group-hover:scale-105', iconTone)} aria-hidden>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          <span className={cn('chip hidden shrink-0 sm:inline-flex', chipTone)}>{chip}</span>
        </span>
        <strong className="dashboard-metric-value">{value}</strong>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function BarList({ data, emptyLabel, total }: { data: { _id: string; count: number }[]; emptyLabel: string; total: number }): React.JSX.Element {
  if (!data.length) return <p className="py-5 text-xs text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...data.map((item) => item.count), 1);
  return (
    <ul className="mt-4 space-y-3">
      {data.map((item) => (
        <li key={item._id || '未填写'}>
          <div className="mb-1.5 flex justify-between gap-3 text-xs">
            <span className="truncate font-medium text-foreground/85">{item._id || '未填写'}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {item.count} · {total ? Math.round((item.count / total) * 100) : 0}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-primary/75 transition-all" style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { t, language } = useI18n();
  usePageTitle(t('dashboard.title'));
  const [range, setRange] = React.useState<'today' | '7d' | '30d' | 'month' | 'all'>('30d');
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
          label: '客户总数',
          value: data.customer.total.toLocaleString('zh-CN'),
          detail: `其中 ${data.customer.withEmail} 位有邮箱`,
          chip: `${data.customer.withEmail} 可发信`,
          icon: Users,
          tone: 'mint' as MetricTone,
          action: () => openCustomers(),
        },
        {
          label: '待开发客户',
          value: data.customer.pending.toLocaleString('zh-CN'),
          detail: `今日到期 ${data.workspace.followUpToday} · 逾期 ${data.workspace.followUpOverdue}`,
          chip: `占比 ${data.customer.total ? Math.round((data.customer.pending / data.customer.total) * 100) : 0}%`,
          icon: Target,
          tone: 'amber' as MetricTone,
          action: () => openCustomers({ status: 'pending' }),
        },
        {
          label: '近 7 天发送',
          value: data.letter.sent7d.toLocaleString('zh-CN'),
          detail: `近 30 天累计 ${data.letter.sent30d} 封`,
          chip: `草稿 ${data.letter.draft}`,
          icon: Send,
          tone: 'mint' as MetricTone,
          action: () => openLetters(),
        },
        {
          label: '客户开发率',
          value: `${data.developmentRate}%`,
          detail: `已开发 ${data.customer.developed} / ${data.customer.total} 位`,
          chip: `${data.customer.developed}/${data.customer.total}`,
          icon: TrendingUp,
          tone: 'violet' as MetricTone,
          action: () => openCustomers(),
        },
      ]
    : [];

  const trendPoints = React.useMemo(
    () => (data?.letter.byDay ?? []).slice(-14).map((item) => ({
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

  return (
    <div className="workspace-page dashboard-page">
      {/* Executive Welcome Hero Strip */}
      <section className="hero-wash panel relative overflow-hidden p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {dateLabel} · <span className="text-primary">{project?.name || (language === 'zh' ? '当前项目' : 'Current workspace')}</span>
            </p>
            <h1 className="mt-1.5 text-[1.625rem] font-semibold leading-tight tracking-[-0.03em] text-foreground sm:text-[1.875rem]">
              {language === 'zh' ? `你好，${userName}` : `Hello, ${userName}`}
            </h1>
            <p className="mt-1.5 max-w-2xl text-[0.8125rem] leading-relaxed text-muted-foreground">
              {data
                ? language === 'zh'
                  ? dueCount > 0
                    ? `这是 ${project?.name || '当前项目'} 的今日业务概览。当前有 ${dueCount} 位客户待跟进、${data.letter.draft} 封开发信草稿待处理。`
                    : `这是 ${project?.name || '当前项目'} 的今日业务概览。跟进计划井然有序，可优先推进高意向商机与客户发现。`
                  : dueCount > 0
                    ? `Today's overview for ${project?.name || 'your workspace'}. ${dueCount} customer follow-ups and ${data.letter.draft} draft letters need attention.`
                    : `Today's overview for ${project?.name || 'your workspace'}. Follow-ups are on track — focus on high-intent leads and prospecting.`
                : t('dashboard.subtitle')}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center rounded-lg border border-border bg-surface/90 p-0.5 text-xs">
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
                    className={cn(
                      'rounded-md px-2.5 py-1 font-medium transition-colors',
                      range === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
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

            <div className="flex flex-wrap items-center gap-2">
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
      </section>

      {canManage && onboarding && !onboarding.completedAt ? (
        <div className="callout-sage flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-[0.8125rem] font-semibold text-foreground">{t('dashboard.onboardingTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('dashboard.onboardingDesc')}</p>
            </div>
          </div>
          <Button size="sm" asChild>
            <Link to={ROUTES.onboarding}>
              {t('dashboard.onboardingCta')} · {onboarding.doneCount}/{onboarding.totalCount}
            </Link>
          </Button>
        </div>
      ) : null}

      {mailChannel === 'mock' ? (
        <Alert variant="warning">
          <AlertDescription>当前为「{MAIL_CHANNEL_LABEL.mock}」：开发信会完整记录并计入统计，不会真实投递。</AlertDescription>
        </Alert>
      ) : null}
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
          {/* KPI Metric Cards */}
          <section aria-label="业务概览" className="dashboard-metrics">
            {metrics.map((metric) => (
              <MetricCard
                key={metric.label}
                label={metric.label}
                value={metric.value}
                detail={metric.detail}
                chip={metric.chip}
                icon={metric.icon}
                tone={metric.tone}
                onClick={metric.action}
              />
            ))}
          </section>

          {/* Main Worklist + Right Actionable Reminders & AI Shortcuts */}
          <SalesWorkspaceSection stats={data} />

          {/* Executive Charts Row: 14-Day Trend Area Chart + Market Distribution Donut */}
          <section aria-label="关键指标趋势与市场分布" className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.015em]">
                    <Mail className="h-4 w-4 text-primary" aria-hidden />
                    近 14 天开发信发送趋势
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    累计开发信 {data.letter.total} 封 · 已发送 {data.letter.sent} 封 · 草稿 {data.letter.draft} 封
                  </p>
                </div>
                <Badge variant="developed" className="tabular-nums">近 7 天 {data.letter.sent7d} 封</Badge>
              </div>
              <div className="mt-4">
                <AreaTrendChart data={trendPoints} unit="封" height={184} emptyLabel="暂无开发信发送记录" />
              </div>
            </div>

            <div className="panel p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.015em]">
                    <Globe2 className="h-4 w-4 text-primary" aria-hidden />
                    客户分布（TOP 5）
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">所选时间区间内核心海外市场占比</p>
                </div>
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

          {/* Conversion Funnel & High-Priority Follow-ups */}
          {data.analytics ? (
            <section aria-label="转化与决策分析" className="grid gap-4 lg:grid-cols-2">
              <div className="panel p-5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
                      <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
                      询盘转化漏斗
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      区间成交额 {formatMoney(data.analytics.quotationMetrics.acceptedAmount, 'USD')} · 在谈报价 {formatMoney(data.analytics.quotationMetrics.pipelineAmount, 'USD')}
                    </p>
                  </div>
                  <Badge variant="gold" className="tabular-nums">高意向 {data.analytics.highIntentCount}</Badge>
                </div>
                <ul className="mt-4 space-y-3 text-xs">
                  {data.analytics.conversionFunnel.map((step) => (
                    <li key={step.stage}>
                      <div className="mb-1.5 flex justify-between gap-2">
                        <span className="font-medium text-foreground/85">{step.label}</span>
                        <span className="tabular-nums text-muted-foreground">{step.count} · {step.rate}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/80 transition-all" style={{ width: `${Math.max(step.count > 0 ? 4 : 0, step.rate)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="panel p-5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
                      <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                      高优跟进建议
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      综合未解决问题（{data.analytics.openQuestionsCount}）、逾期与报价进度实时排序
                    </p>
                  </div>
                </div>
                {data.analytics.priorityFollowUps.length === 0 ? (
                  <p className="py-10 text-center text-xs text-muted-foreground">当前没有待推进的活跃客户</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border/75 text-xs">
                    {data.analytics.priorityFollowUps.slice(0, 5).map((item, idx) => (
                      <li key={item.customerId} className="py-2.5 first:pt-0 last:pb-0">
                        <Link to={customerDetailPath(item.customerId)} className="group block rounded-lg px-1.5 py-1 -mx-1.5 transition-colors hover:bg-primary-soft/45">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2 font-medium group-hover:text-primary">
                              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary-soft text-[10px] font-bold text-primary">
                                {idx + 1}
                              </span>
                              <CountryFlag value={item.country} />
                              <span className="truncate">{item.company || item.name}</span>
                            </span>
                            <Badge variant="developed" className="shrink-0 tabular-nums">{item.score} 分</Badge>
                          </div>
                          <p className="mt-1 truncate pl-7 text-[11px] text-muted-foreground">{item.reason}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : null}

          {/* Collapsible Deep Breakdown */}
          <details open className="dashboard-analysis panel group">
            <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">
              <h2 className="section-title">客户结构与阶段分布</h2>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">销售阶段漏斗、行业分布与客户等级拆解</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="dashboard-analysis-grid">
              <div className="well p-4">
                <SalesFunnel byStatus={data.customer.byStatus} total={data.customer.total} />
              </div>
              <section aria-labelledby="industry-distribution-title" className="well p-4">
                <h3 id="industry-distribution-title" className="section-title">行业分布</h3>
                <p className="mt-1 text-xs text-muted-foreground">按数量排序，展示前 8 项</p>
                <BarList data={data.customer.byIndustry.slice(0, 8)} total={data.customer.total} emptyLabel="还没有填写行业" />
              </section>
              <section aria-labelledby="grade-distribution-title" className="well p-4">
                <h3 id="grade-distribution-title" className="section-title">客户等级</h3>
                <p className="mt-1 text-xs text-muted-foreground">按数量排序，展示前 6 项</p>
                <BarList data={data.customer.byGrade.slice(0, 6)} total={data.customer.total} emptyLabel="还没有设置等级" />
              </section>
            </div>
            <p className="mx-5 mb-4 border-t border-border/70 pt-3 text-xs leading-relaxed text-muted-foreground">
              近 7 天联系过 {data.customer.contacted7d} 位客户 · 当前 {data.customer.withoutEmail} 位客户缺少邮箱 · 草稿 {data.letter.draft} 封 · 发送失败 {data.letter.failed} 封
            </p>
          </details>
        </>
      )}
    </div>
  );
}
