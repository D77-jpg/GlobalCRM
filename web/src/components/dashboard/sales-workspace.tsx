import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck2,
  ChevronRight,
  Inbox,
  Mail,
  MessageSquare,
  Sparkles,
  Users,
} from 'lucide-react';
import { CustomerStatusBadge, LetterStatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { countryInfo } from '@/lib/country';
import { CountryFlag } from '@/components/common/country-flag';
import { cn } from '@/lib/utils';
import { formatDate, formatRelative, initials } from '@/lib/format';
import { customerDetailPath, FOLLOW_UP_METHOD_LABEL, FOLLOW_UP_RESULT_LABEL, ROUTES } from '@/constants';
import { useUiStore } from '@/store/ui.store';
import { useDashboardNavigation } from './dashboard-navigation';
import type { CustomerBrief, DevelopmentLetter, OverviewStats, RecentFollowUpItem } from '@/types';

function CustomerRow({ customer, overdue, recent = false }: {
  customer: CustomerBrief; overdue?: boolean; recent?: boolean;
}): React.JSX.Element {
  const companyLabel = customer.company && customer.company !== customer.name
    ? customer.company : customer.grade ? `${customer.grade} 级客户` : '客户档案';
  const marketLabel = [countryInfo(customer.country)?.name, customer.industry].filter(Boolean).join(' · ');
  const subtitle = marketLabel ? `${companyLabel} · ${marketLabel}` : companyLabel;
  const dateLabel = recent ? formatRelative(customer.createdAt) : overdue
    ? `已逾期 · ${formatDate(customer.nextFollowUpAt)}` : '今天跟进';
  return (
    <li>
      <Link to={customerDetailPath(customer.id)} className="dashboard-customer-row group">
        <span className="flex min-w-0 items-center gap-3">
          <span className="avatar-bubble flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold" aria-hidden>
            {initials(customer.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[0.875rem] font-medium text-foreground group-hover:text-primary">{customer.name}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <CountryFlag value={customer.country} />
              <span className="truncate">{subtitle}</span>
            </span>
            <span className={cn('mt-0.5 block text-xs text-muted-foreground sm:hidden', overdue && 'text-destructive')}>{dateLabel}</span>
          </span>
        </span>
        <span className="dashboard-customer-status"><CustomerStatusBadge status={customer.status} /></span>
        <span className={cn('dashboard-customer-date text-xs text-muted-foreground', overdue && 'font-semibold text-rose')}>
          {dateLabel}
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground/60 transition-colors group-hover:text-primary" aria-hidden />
      </Link>
    </li>
  );
}

function RecentFollowUpRow({ item }: { item: RecentFollowUpItem }): React.JSX.Element {
  return (
    <li>
      <Link to={customerDetailPath(item.customerId)} className="group -mx-2 block rounded-lg border-b border-border/65 px-2.5 py-3 transition-colors last:border-0 hover:bg-primary-soft/40">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium group-hover:text-primary">{item.customerName}</span>
          <time dateTime={new Date(item.followUpAt).toISOString()} className="text-xs text-muted-foreground">{formatRelative(item.followUpAt)}</time>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {FOLLOW_UP_METHOD_LABEL[item.method] ?? item.method} · {FOLLOW_UP_RESULT_LABEL[item.result] ?? item.result}
          {item.customerCompany && item.customerCompany !== item.customerName ? ` · ${item.customerCompany}` : ''}
        </p>
        <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-muted-foreground">{item.content}</p>
      </Link>
    </li>
  );
}

function RecentLetterRow({ letter }: { letter: DevelopmentLetter }): React.JSX.Element {
  return (
    <li className="border-b border-border/65 last:border-0">
      <Link to={letter.customer ? customerDetailPath(letter.customer.id) : ROUTES.letters}
        className="group -mx-2 flex items-start gap-3 rounded-lg px-2.5 py-3 transition-colors hover:bg-primary-soft/40">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
          <Mail className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium group-hover:text-primary">{letter.subject || '（无主题）'}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{letter.recipientName} · {letter.recipientEmail}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <LetterStatusBadge status={letter.status} />
          <span className="text-xs text-muted-foreground">{letter.sentAt ? formatRelative(letter.sentAt) : '未发送'}</span>
        </span>
      </Link>
    </li>
  );
}

function ListEmpty({ icon: Icon, title, description, children }: React.PropsWithChildren<{
  icon: typeof Users; title: string; description: string;
}>): React.JSX.Element {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-4 py-10 text-center">
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary-soft/70 text-primary" aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

const REMINDER_ICONS = {
  overdue: CalendarCheck2,
  upcoming: ArrowRight,
  draft: MessageSquare,
  failed: Inbox,
  email: Users,
} as const;

export function SalesWorkspaceSection({ stats }: { stats: OverviewStats }): React.JSX.Element {
  const { workspace, customer, letter } = stats;
  const { openCustomers, openLetters } = useDashboardNavigation();
  const setAgentOpen = useUiStore((state) => state.setAgentOpen);
  const dueCount = workspace.followUpToday + workspace.followUpOverdue;

  return (
    <section aria-labelledby="customer-worklist-title" className="dashboard-workbench">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="customer-worklist-title" className="section-title">今日重点任务与客户动态</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {dueCount > 0
                ? `今天待跟进 ${workspace.followUpToday} 位，另有 ${workspace.followUpOverdue} 位已逾期。`
                : customer.pending > 0
                  ? '今天没有到期跟进，可从最近加入的客户开始推进开发。'
                  : '今天没有到期跟进，可查看最近客户和沟通动态。'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => openCustomers()} className="hidden text-primary hover:bg-primary-soft sm:inline-flex">
            全部客户 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>

        <Tabs defaultValue={dueCount > 0 ? 'followups' : 'customers'} className="mt-4">
          <TabsList aria-label="客户工作清单" className="w-fit max-w-full justify-start">
            <TabsTrigger value="followups" className="text-xs">
              待跟进
              {dueCount > 0 ? <span className="chip chip-violet ml-1 px-1.5 py-0.5 text-[10px] leading-none">{dueCount}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="customers" className="text-xs">最近客户</TabsTrigger>
            <TabsTrigger value="activity" className="text-xs">跟进动态</TabsTrigger>
            <TabsTrigger value="letters" className="text-xs">邮件记录</TabsTrigger>
          </TabsList>
          <TabsContent value="customers" className="mt-0">
            {workspace.recentCustomers.length ? (
              <>
                <div aria-hidden className="dashboard-customer-row dashboard-list-heading">
                  <span>客户 / 公司</span><span className="dashboard-customer-status">当前阶段</span>
                  <span className="dashboard-customer-date">加入时间</span><span />
                </div>
                <ul aria-label="最近加入的客户">{workspace.recentCustomers.map((item) => <CustomerRow key={item.id} customer={item} recent />)}</ul>
                <div className="dashboard-list-footer">
                  <span>最近加入的 {workspace.recentCustomers.length} 位客户</span>
                  <button type="button" className="dashboard-text-action" onClick={() => openCustomers({}, 'createdAt')}>
                    按加入时间查看全部 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </>
            ) : (
              <ListEmpty icon={Users} title="从第一位客户开始" description="在客户管理导入或新建客户，再安排跟进和发送开发信。">
                <Button size="sm" onClick={() => openCustomers()}>去客户管理</Button>
              </ListEmpty>
            )}
          </TabsContent>
          <TabsContent value="followups" className="mt-0">
            {workspace.overdueCustomers.length || workspace.todayFollowUpCustomers.length ? (
              <>
                {workspace.overdueCustomers.length ? (
                  <div>
                    <h3 className="pt-4 text-xs font-semibold text-rose">优先处理 · 已逾期 {workspace.followUpOverdue} 位</h3>
                    <ul aria-label="逾期客户">{workspace.overdueCustomers.map((item) => <CustomerRow key={item.id} customer={item} overdue />)}</ul>
                  </div>
                ) : null}
                {workspace.todayFollowUpCustomers.length ? (
                  <div>
                    <h3 className="pt-4 text-xs font-semibold text-muted-foreground">今天跟进 · {workspace.followUpToday} 位</h3>
                    <ul aria-label="今日待跟进客户">{workspace.todayFollowUpCustomers.map((item) => <CustomerRow key={item.id} customer={item} />)}</ul>
                  </div>
                ) : null}
              </>
            ) : (
              <ListEmpty icon={CalendarCheck2} title="今天没有到期跟进" description="可以查看未来的跟进安排，或从最近客户中选择下一位开发对象。" />
            )}
            <div className="dashboard-list-footer flex-wrap">
              <button type="button" className="dashboard-text-action" onClick={() => openCustomers({ followUp: 'today' })}>
                查看今日跟进 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button type="button" className="dashboard-text-action" onClick={() => openCustomers({ followUp: 'overdue' })}>
                查看全部逾期 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </TabsContent>
          <TabsContent value="activity" className="mt-0">
            {workspace.recentFollowUps.length
              ? <ul aria-label="最近跟进动态">{workspace.recentFollowUps.map((item) => <RecentFollowUpRow key={item.id} item={item} />)}</ul>
              : <ListEmpty icon={MessageSquare} title="还没有跟进记录" description="进入客户详情记录沟通结果，最近的跟进会汇总在这里。" />}
          </TabsContent>
          <TabsContent value="letters" className="mt-0">
            {stats.recentLetters.length
              ? <ul aria-label="最近开发信">{stats.recentLetters.map((item) => <RecentLetterRow key={item.id} letter={item} />)}</ul>
              : <ListEmpty icon={Inbox} title="还没有开发信记录" description="从客户详情撰写开发信，审核后手动发送。" />}
            <div className="dashboard-list-footer">
              <span>最新 {stats.recentLetters.length} 条记录</span>
              <button type="button" className="dashboard-text-action" onClick={() => openLetters()}>
                全部开发信 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Right Rail: Actionable Reminders + Today's Progress + AI Copilot Quick Entry */}
      <aside aria-labelledby="dashboard-reminders-title" className="dashboard-reminders flex flex-col gap-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="dashboard-reminders-title" className="section-title">工作提醒</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">继续处理待办与待审事项</p>
            </div>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
              <CalendarCheck2 className="h-4 w-4" />
            </span>
          </div>
          <ul className="mt-3 space-y-1">
            {[
              { key: 'overdue' as const, label: '逾期跟进', value: workspace.followUpOverdue, urgent: true, action: () => openCustomers({ followUp: 'overdue' }) },
              { key: 'upcoming' as const, label: '未来跟进', value: workspace.followUpUpcoming, action: () => openCustomers({ followUp: 'upcoming' }) },
              { key: 'draft' as const, label: '待发送草稿', value: letter.draft, action: () => openLetters('draft') },
              { key: 'failed' as const, label: '发送失败', value: letter.failed, urgent: true, action: () => openLetters('failed') },
              { key: 'email' as const, label: '客户缺少邮箱', value: customer.withoutEmail, action: () => openCustomers({ hasEmail: 'no' }) },
            ].map((item) => {
              const Icon = REMINDER_ICONS[item.key];
              return (
                <li key={item.label}>
                  <button
                    type="button"
                    onClick={item.action}
                    className="group flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-primary-soft/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-muted-foreground group-hover:bg-card group-hover:text-primary" aria-hidden>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground/85 group-hover:text-foreground">{item.label}</span>
                    <span className={cn('font-semibold tabular-nums', item.urgent && item.value > 0 ? 'chip chip-rose' : 'text-foreground')}>
                      {item.value}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-xl border border-border/80 bg-surface p-3.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">今日执行进度</h3>
          <dl className="mt-2.5 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-2xs text-muted-foreground">已发送开发信</dt>
              <dd className="mt-1 text-xl font-bold tabular-nums tracking-tight text-foreground">
                {workspace.lettersSentToday}
                <span className="ml-1 text-xs font-normal text-muted-foreground">封</span>
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-muted-foreground">新增客户</dt>
              <dd className="mt-1 text-xl font-bold tabular-nums tracking-tight text-foreground">
                {workspace.newCustomersToday}
                <span className="ml-1 text-xs font-normal text-muted-foreground">位</span>
              </dd>
            </div>
          </dl>
        </div>

        {/* Authentic AI Assistant Launcher */}
        <div className="rounded-xl border border-primary/15 bg-primary-soft/55 p-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-3.5 w-3.5 text-[#E8D7A8]" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-xs font-semibold text-foreground">AI 外贸助手</h3>
              <p className="text-[11px] text-muted-foreground">总结工作区、起草邮件与审核草稿</p>
            </div>
          </div>
          <Button type="button" size="sm" className="mt-3 w-full" onClick={() => setAgentOpen(true)}>
            <Sparkles className="h-3.5 w-3.5 text-[#E8D7A8]" aria-hidden />
            打开 AI 外贸助手
          </Button>
        </div>
      </aside>
    </section>
  );
}
