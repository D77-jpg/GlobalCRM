import * as React from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Loader2,
  MailCheck,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { usePageTitle } from '@/hooks/use-ui';
import { selectIsAdmin, useAuthStore } from '@/store/auth.store';
import { useProjectStore } from '@/store/project.store';
import type {
  OutreachAutomationConfig,
  OutreachAutomationOverview,
  OutreachAutomationQueueRow,
  OutreachAutomationStartResult,
  UserDto,
} from '@/types';

const TIMEZONES = [
  ['Asia/Shanghai', '中国标准时间（UTC+8）'],
  ['Asia/Hong_Kong', '香港时间（UTC+8）'],
  ['Asia/Tokyo', '日本时间（UTC+9）'],
  ['Europe/London', '伦敦时间'],
  ['America/New_York', '纽约时间'],
  ['America/Los_Angeles', '洛杉矶时间'],
] as const;

const PHASE_META: Record<
  OutreachAutomationQueueRow['phase'],
  { label: (step: number) => string; variant: 'outline' | 'warning' | 'failed' | 'muted' | 'developed' }
> = {
  waiting: { label: (step) => `等待第 ${step} 封`, variant: 'outline' },
  generating: { label: (step) => `正在准备第 ${step} 封`, variant: 'warning' },
  ready: { label: (step) => `待发送第 ${step} 封`, variant: 'warning' },
  sending: { label: (step) => `正在发送第 ${step} 封`, variant: 'outline' },
  due: { label: (step) => `等待发送第 ${step} 封`, variant: 'warning' },
  paused: { label: () => '已暂停', variant: 'warning' },
  blocked: { label: () => '已停止', variant: 'failed' },
  completed: { label: () => '三封已完成', variant: 'developed' },
  failed: { label: () => '需要处理', variant: 'failed' },
};

function formatWindow(config: OutreachAutomationConfig): string {
  return `${config.windowStart}–${config.windowEnd}`;
}

function blockedStatus(reason: string): { label: string; detail: string; variant: 'warning' | 'muted' | 'developed' } {
  if (reason.includes('已回复')) {
    return { label: '客户已回复', detail: '已停止自动发送，转人工跟进', variant: 'developed' };
  }
  if (reason.includes('退订') || reason.includes('退信') || reason.includes('拒绝')) {
    return { label: '已退订/拒收', detail: '已停止发送，避免继续打扰', variant: 'warning' };
  }
  if (reason.includes('已删除') || reason.includes('归属已变化')) {
    return { label: '归属待确认', detail: '客户已删除或负责人已变更', variant: 'warning' };
  }
  if (reason.includes('不在可开发状态')) {
    return { label: '已转人工', detail: '客户状态已变化，自动开发停止', variant: 'muted' };
  }
  return { label: '已停止', detail: reason || '不再继续发送', variant: 'muted' };
}

function phaseBadge(
  row: OutreachAutomationQueueRow,
  windowOpen: boolean,
): { label: string; variant: 'outline' | 'warning' | 'failed' | 'muted' | 'developed'; detail?: string } {
  if (!windowOpen && ['due', 'ready', 'generating', 'sending'].includes(row.phase)) {
    return { label: '等待发送时段', variant: 'outline' };
  }
  if (row.phase === 'blocked') return blockedStatus(row.lastError ?? '');
  const meta = PHASE_META[row.phase];
  return { label: meta.label(row.nextStep), variant: meta.variant };
}

function nextActionLabel(row: OutreachAutomationQueueRow, windowOpen: boolean, windowText: string): string {
  if (!windowOpen && ['due', 'ready', 'generating', 'sending'].includes(row.phase)) {
    return `当前不在发送时段，等工作日 ${windowText} 后自动继续`;
  }
  switch (row.phase) {
    case 'waiting':
      return `${formatRelative(row.nextRunAt)}（${formatDateTime(row.nextRunAt)}）${row.draftReady ? ' · 草稿已准备' : ''}`;
    case 'generating':
      return '正在生成草稿，完成后自动发送';
    case 'ready':
      return '草稿已就绪，等待发送队列';
    case 'sending':
      return '正在通过 SMTP 发送';
    case 'due':
      return '已到发送时间，正在排队等待自动处理';
    case 'paused':
      return '恢复后继续下一封';
    case 'failed':
      return '请查看原因后恢复';
    case 'blocked': {
      const status = blockedStatus(row.lastError ?? '');
      if (status.label === '客户已回复') return '查看客户并继续跟进';
      if (status.label === '归属待确认') return '请确认负责人后重新加入';
      if (status.label === '已退订/拒收') return '停止发送，保留客户记录';
      if (status.label === '已转人工') return '请人工确认客户状态';
      return '已停止发送';
    }
    case 'completed':
    default:
      return '—';
  }
}

function StepProgress({ row }: { row: OutreachAutomationQueueRow }): React.JSX.Element {
  const active = ['waiting', 'generating', 'ready', 'sending', 'due'].includes(row.phase);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex gap-1" role="img" aria-label={`已发送 ${row.actualStep} 封，共 3 封`}>
          {[1, 2, 3].map((step) => (
            <span
              key={step}
              className={`h-1.5 w-6 rounded-full ${
                step <= row.actualStep
                  ? 'bg-emerald-500'
                  : active && step === row.nextStep
                    ? 'bg-amber-400'
                    : 'bg-muted'
              }`}
            />
          ))}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">已发 {row.actualStep}/3 封</span>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {row.phase === 'blocked'
          ? '自动开发已结束'
          : row.phase === 'failed'
            ? `第 ${row.nextStep} 封待处理`
            : row.actualStep >= 3
              ? '三封已完成'
              : `下一封：第 ${row.nextStep} 封`}
      </p>
    </div>
  );
}


export function OutreachAutomationPage(): React.JSX.Element {
  usePageTitle('自动开发');
  const isAdmin = useAuthStore(selectIsAdmin);
  const currentUserId = useAuthStore((state) => state.user?.id ?? '');
  const activeProjectId = useProjectStore((state) => state.activeProject?.id ?? '');
  const [owners, setOwners] = React.useState<UserDto[]>([]);
  const [ownerId, setOwnerId] = React.useState('');
  const [overview, setOverview] = React.useState<OutreachAutomationOverview | null>(null);
  const [form, setForm] = React.useState<OutreachAutomationConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [startConfirmOpen, setStartConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState('');
  const dirtyRef = React.useRef(false);
  const ownerTouchedRef = React.useRef(false);

  const query = ownerId ? `?userId=${encodeURIComponent(ownerId)}` : '';
  const scoped = React.useCallback((path: string) => `${path}${query}`, [query]);

  React.useEffect(() => {
    if (!isAdmin) return;
    ownerTouchedRef.current = false;
    let active = true;
    void apiGet<UserDto[]>('/users').then((users) => {
      if (!active) return;
      const activeUsers = users.filter((user) => user.status === 'active'
        && (user.role === 'admin' || !activeProjectId || user.projectIds.includes(activeProjectId)));
      setOwners(activeUsers);
      setOwnerId((current) => {
        if (ownerTouchedRef.current && activeUsers.some((user) => user.id === current)) return current;
        return activeUsers.find((user) => user.id === currentUserId)?.id
          || activeUsers.find((user) => user.role !== 'admin')?.id
          || '';
      });
    }).catch((caught) => {
      if (active) setError(toErrorMessage(caught, '业务员列表加载失败'));
    });
    return () => { active = false; };
  }, [activeProjectId, currentUserId, isAdmin]);

  const load = React.useCallback(async (quiet = false) => {
    try {
      const next = await apiGet<OutreachAutomationOverview>(`/outreach-automation${query}`);
      setOverview(next);
      if (!dirtyRef.current) setForm(next.config);
      setError('');
    } catch (caught) {
      if (!quiet) setError(toErrorMessage(caught, '自动开发状态加载失败'));
    } finally {
      setLoading(false);
    }
  }, [query]);

  React.useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  React.useEffect(() => {
    dirtyRef.current = false;
    setDirty(false);
    setForm(null);
    setOverview(null);
  }, [ownerId]);

  const patch = (value: Partial<OutreachAutomationConfig>): void => {
    setForm((current) => current ? { ...current, ...value } : current);
    dirtyRef.current = true;
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const next = await apiPut<OutreachAutomationOverview>(scoped('/outreach-automation'), {
        expectedVersion: form.version,
        rolloutMode: form.rolloutMode,
        dailyLimit: form.dailyLimit,
        perDomainLimit: form.perDomainLimit,
        windowStart: form.windowStart,
        windowEnd: form.windowEnd,
        timezone: form.timezone,
        useBuyerTimezone: Boolean(form.useBuyerTimezone),
        minPacingSeconds: form.minPacingSeconds ?? 90,
        maxPacingSeconds: form.maxPacingSeconds ?? 240,
      });
      setOverview(next);
      setForm(next.config);
      dirtyRef.current = false;
      setDirty(false);
      toast.success('自动开发设置已保存');
    } catch (caught) {
      setError(toErrorMessage(caught, '自动开发设置保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<OutreachAutomationStartResult>(scoped('/outreach-automation/start'), {});
      setOverview(result.overview);
      setForm(result.overview.config);
      setStartConfirmOpen(false);
      dirtyRef.current = false;
      setDirty(false);
      toast.success(`已加入 ${result.enrolled} 位客户`, {
        description: '自动开发已开启；第 1 封生成后会直接发送，并在 3/7/14 天节奏内继续。',
      });
    } catch (caught) {
      setError(toErrorMessage(caught, '自动开发操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (): Promise<void> => {
    if (!overview) return;
    if (!overview.config.enabled) {
      setStartConfirmOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await apiPost<OutreachAutomationOverview>(scoped('/outreach-automation/pause'), {});
      setOverview(next);
      setForm(next.config);
      dirtyRef.current = false;
      setDirty(false);
      toast.info('自动开发已暂停', { description: '不会再创建新的自动发送任务。' });
    } catch (caught) {
      setError(toErrorMessage(caught, '自动开发操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const enrollMore = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<OutreachAutomationStartResult>(scoped('/outreach-automation/start'), {});
      setOverview(result.overview);
      setForm(result.overview.config);
      toast.success(`已加入 ${result.enrolled} 位客户`);
    } catch (caught) {
      setError(toErrorMessage(caught, '加入客户失败'));
    } finally {
      setBusy(false);
    }
  };

  const controlRow = async (row: OutreachAutomationQueueRow): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const action = row.status === 'paused' || row.status === 'failed' ? 'resume' : 'pause';
      const next = await apiPost<OutreachAutomationOverview>(scoped(`/outreach-automation/enrollments/${row.id}/${action}`), {});
      setOverview(next);
      setForm(next.config);
      toast.success(action === 'pause' ? '已暂停该客户' : '已恢复该客户');
    } catch (caught) {
      setError(toErrorMessage(caught, '客户自动开发操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const mailbox = overview?.mailbox;
  const canStart = (overview?.config.rolloutMode === 'shadow' || Boolean(mailbox?.canSend)) && Boolean(overview?.stats.eligible || overview?.stats.enrolled);
  const issueCount = (overview?.stats.paused ?? 0) + (overview?.stats.failed ?? 0) + (overview?.stats.blocked ?? 0);

  return (
    <div className="workspace-page">
      <PageHeader
        title="自动开发"
        description="用你自己的已验证邮箱，按 3/7/14 天节奏自动完成三封开发信；回复、退订、退信后立即停止。"
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={busy || loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
              刷新
            </Button>
            <Button type="button" size="sm" onClick={() => void toggle()} disabled={busy || loading || (!overview?.config.enabled && !canStart)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : overview?.config.enabled ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {overview?.config.enabled ? '暂停自动开发' : '开始自动开发'}
            </Button>
          </div>
        }
      />

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {loading && !overview ? (
        <p role="status" className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          正在读取自动开发状态…
        </p>
      ) : null}

      {isAdmin ? <LegacyUpgradeAuditBanner key={`upgrade-${activeProjectId}`} onMigrated={() => void load(true)} /> : null}

      {overview ? (
        <>
          <section className="rounded-lg border bg-card p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${overview.config.enabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                  {overview.config.enabled ? <Bot className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {overview.config.enabled ? '自动开发运行中' : '自动开发未运行'}
                    <Badge variant={overview.config.enabled ? 'developed' : 'outline'}>
                      {overview.config.enabled ? '自动发送' : '已停止'}
                    </Badge>
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {overview.config.enabled
                      ? `工作日 ${formatWindow(overview.config)} · 每天最多 ${overview.config.dailyLimit} 封 · 每域名 ${overview.config.perDomainLimit} 封`
                      : overview.config.pausedReason || '开启后会从符合条件的客户开始，第 1、2、3 封自动发送。'}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <MailCheck className="h-3.5 w-3.5" aria-hidden />
                  {mailbox?.email || '未配置发件邮箱'}
                </span>
                <Badge variant={mailbox?.canSend ? 'developed' : 'failed'}>
                  {mailbox?.canSend ? '邮箱已验证' : '邮箱未就绪'}
                </Badge>
                {mailbox?.warmup?.enabled ? (
                  <Badge variant={mailbox.warmup.reason === 'mailbox_bounce_cooldown' ? 'warning' : 'outline'}>
                    独立预热 · 活跃 {mailbox.warmup.activeSendDays} 天 · 今日限 {mailbox.warmup.effectiveLimit}/{mailbox.dailyLimit} 封
                    {mailbox.warmup.reason === 'mailbox_bounce_cooldown' ? '（退信降速中）' : mailbox.warmup.reason === 'mailbox_bounce_hold' ? '（退信暂缓加量）' : ''}
                  </Badge>
                ) : null}
              </div>
            </div>
            {!mailbox?.canSend ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-200/70 bg-amber-50/70 p-2.5 text-xs leading-5 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {mailbox?.reason || '还没有可用的个人发件邮箱，自动开发不会发送任何邮件。'}{' '}
                {isAdmin
                  ? <Link to="/users" className="font-medium underline underline-offset-2">去用户管理配置</Link>
                  : <span className="font-medium">请联系管理员配置并发件邮箱。</span>}
              </p>
            ) : null}
            {overview.config.enabled && !overview.windowOpen ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-sky-200/70 bg-sky-50/70 p-2.5 text-xs leading-5 text-sky-800 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                当前不在发送时段（工作日 {formatWindow(overview.config)}，{overview.config.timezone}）。队列会保留，等到下一个工作日自动继续。
              </p>
            ) : null}
            {overview.config.enabled && overview.stats.remainingToday === 0 ? (
              <p className="mt-3 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
                今天这个邮箱的 {overview.config.dailyLimit} 封额度已用完，明天发送时段会继续。
              </p>
            ) : null}
          </section>

          <section aria-label="自动开发指标" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: '可加入客户', value: overview.stats.eligible, hint: '待开发，或已有开发信记录', icon: Users },
              { label: '进行中', value: overview.stats.active, hint: `队列共 ${overview.stats.enrolled} 位`, icon: Bot },
              { label: '今日已发', value: `${overview.stats.sentToday}/${overview.config.dailyLimit}`, hint: `剩余 ${overview.stats.remainingToday} 封`, icon: Send },
              { label: '需要处理', value: issueCount, hint: '暂停、失败或已停止', icon: ShieldCheck },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border bg-card p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <item.icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                </div>
                <p className="mt-1 text-xl font-semibold tabular-nums">{item.value}</p>
                <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{item.hint}</p>
              </div>
            ))}
          </section>

          <div className="grid gap-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                  发送设置
                </CardTitle>
                <CardDescription className="text-xs leading-5">保存后自动生效；修改不会重置队列。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isAdmin ? (
                  <div className="space-y-1.5 border-b pb-3">
                    <Label htmlFor="auto-owner">执行账号</Label>
                    <Select value={ownerId} onValueChange={(value) => { ownerTouchedRef.current = true; setOwnerId(value); }} disabled={busy || owners.length === 0}>
                      <SelectTrigger id="auto-owner"><SelectValue placeholder="选择业务员" /></SelectTrigger>
                      <SelectContent>
                        {owners.map((owner) => (
                          <SelectItem key={owner.id} value={owner.id}>
                            {owner.displayName || owner.username}{owner.role === 'admin' ? '（管理员）' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] leading-5 text-muted-foreground">使用该业务员自己的已验证邮箱发送，20 封/天按邮箱独立计算。</p>
                  </div>
                ) : null}
                {form ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="auto-rollout">发送模式</Label>
                      <Select value={form.rolloutMode} onValueChange={(value: OutreachAutomationConfig['rolloutMode']) => patch({ rolloutMode: value })}>
                        <SelectTrigger id="auto-rollout"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="shadow">模拟校验</SelectItem>
                          <SelectItem value="pilot">小流量试发</SelectItem>
                          <SelectItem value="active">按设置发送</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">模拟只记录校验结果。试发每天每个邮箱最多 5 封，且遵守下方额度。</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="auto-daily-limit">每天最多</Label>
                        <Input id="auto-daily-limit" type="number" min={1} max={20} value={form.dailyLimit} onChange={(e) => patch({ dailyLimit: Number(e.target.value) })} />
                        <p className="text-[11px] text-muted-foreground">封 / 邮箱，最多 20 封</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="auto-domain-limit">每域名</Label>
                        <Input id="auto-domain-limit" type="number" min={1} max={10} value={form.perDomainLimit} onChange={(e) => patch({ perDomainLimit: Number(e.target.value) })} />
                        <p className="text-[11px] text-muted-foreground">封 / 24 小时</p>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>发送时段</Label>
                      <div className="flex items-center gap-2">
                        <Input type="time" aria-label="发送开始时间" value={form.windowStart} onChange={(e) => patch({ windowStart: e.target.value })} />
                        <span className="text-xs text-muted-foreground">至</span>
                        <Input type="time" aria-label="发送结束时间" value={form.windowEnd} onChange={(e) => patch({ windowEnd: e.target.value })} />
                      </div>
                      <p className="text-[11px] text-muted-foreground">仅工作日发送；时区见下方。</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="auto-timezone">默认发送时区</Label>
                      <Select value={form.timezone} onValueChange={(value) => patch({ timezone: value })}>
                        <SelectTrigger id="auto-timezone"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {TIMEZONES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-start justify-between gap-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
                      <div className="min-w-0">
                        <Label htmlFor="auto-buyer-tz" className="cursor-pointer text-xs font-medium">按买家当地时间发送</Label>
                        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">按收件人国家/时区与当地工作日（含夏令时）排程；缺少时区时回退上方默认时区。</p>
                      </div>
                      <Switch
                        id="auto-buyer-tz"
                        checked={Boolean(form.useBuyerTimezone)}
                        onCheckedChange={(checked) => patch({ useBuyerTimezone: checked })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="auto-min-pacing">最小错峰（秒）</Label>
                        <Input
                          id="auto-min-pacing"
                          type="number"
                          min={30}
                          max={3600}
                          value={form.minPacingSeconds ?? 90}
                          onChange={(e) => patch({ minPacingSeconds: Number(e.target.value) })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="auto-max-pacing">最大错峰（秒）</Label>
                        <Input
                          id="auto-max-pacing"
                          type="number"
                          min={60}
                          max={3600}
                          value={form.maxPacingSeconds ?? 240}
                          onChange={(e) => patch({ maxPacingSeconds: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                    <Button type="button" className="w-full" disabled={!dirty || busy} onClick={() => void save()}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                      保存设置
                    </Button>
                  </>
                ) : null}
                <div className="border-t pt-3">
                  <p className="text-xs font-medium">节奏</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">第 1 封发出后第 3 天发第 2 封，第 7 天发第 3 封；第 3 封后 14 天无回复自动停止。</p>
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
                    自动开发队列
                  </CardTitle>
                  <CardDescription className="text-xs leading-5">每 5 秒刷新；只显示当前账号负责的客户。</CardDescription>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={busy || !overview.config.enabled || overview.stats.eligible === 0} onClick={() => void enrollMore()}>
                  <Users className="h-4 w-4" aria-hidden />
                  加入符合条件客户
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {overview.queue.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <Bot className="mx-auto h-7 w-7 text-muted-foreground/60" aria-hidden />
                    <p className="mt-2 text-sm font-medium">还没有自动开发客户</p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                      {canStart ? '点击右上角「开始自动开发」，系统会从符合条件的客户开始准备并发送下一封。' : '先配置并验证个人发件邮箱，再开始自动开发。'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table aria-label="自动开发队列">
                      <TableHeader>
                        <TableRow>
                          <TableHead>客户</TableHead>
                          <TableHead>进度</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>下一动作</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {overview.queue.map((row) => {
                          const status = phaseBadge(row, overview.windowOpen);
                          const controllable = row.status === 'active' || row.status === 'paused' || row.status === 'failed';
                          return (
                            <TableRow key={row.id}>
                              <TableCell>
                                <Link to={`/customers/${row.customerId}`} className="block max-w-[15rem] truncate text-sm font-medium hover:text-primary hover:underline">
                                  {row.customerName}
                                </Link>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.company || row.email || '—'}</p>
                              </TableCell>
                              <TableCell className="min-w-[9.5rem] whitespace-nowrap">
                                <StepProgress row={row} />
                              </TableCell>
                              <TableCell>
                                <Badge variant={status.variant}>{status.label}</Badge>
                                {status.detail ? (
                                  <p className={`mt-1 max-w-[14rem] text-[11px] leading-4 ${status.variant === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                                    {status.detail}
                                  </p>
                                ) : row.lastError ? (
                                  <p className={`mt-1 max-w-[14rem] text-[11px] leading-4 ${row.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                                    {row.lastError}
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell className="min-w-[12rem] text-xs text-muted-foreground">
                                {nextActionLabel(row, overview.windowOpen, formatWindow(overview.config))}
                              </TableCell>
                              <TableCell className="text-right">
                                {controllable ? (
                                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void controlRow(row)}>
                                    {row.status === 'active' ? '暂停' : '恢复'}
                                  </Button>
                                ) : <span className="text-xs text-muted-foreground">—</span>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <OutreachResultsPanel key={`${activeProjectId}-${ownerId}`} endpoint={scoped('/outreach-automation/results')} isAdmin={isAdmin} />
          {isAdmin ? <WritingReleaseCard key={`release-${activeProjectId}`} /> : null}
          {isAdmin ? <OutreachExperimentsCard key={`exp-${activeProjectId}`} /> : null}

          {overview.recent.length ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Send className="h-4 w-4 text-muted-foreground" aria-hidden />
                  最近自动发送
                </CardTitle>
                <CardDescription className="text-xs">只统计通过自动开发发出的邮件。</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {overview.recent.map((row) => (
                    <li key={row.letterId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <span className="min-w-0 truncate font-medium">{row.customerName}</span>
                      <span className="text-xs text-muted-foreground">第 {row.step || '—'} 封 · {formatRelative(row.sentAt)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={startConfirmOpen}
        onOpenChange={(open) => { if (!busy) setStartConfirmOpen(open); }}
        title="开始自动开发？"
        description={`将把 ${overview?.stats.eligible ?? 0} 位符合条件的客户加入自动开发队列。`}
        confirmText="开始自动开发"
        loading={busy}
        onConfirm={start}
      >
        <div className="space-y-2 leading-5">
          {overview?.config.rolloutMode === 'shadow' ? <p>系统会准备草稿并记录是否通过校验。模拟模式不会投递邮件。</p> : <>
            <p>校验通过的草稿会通过 {overview?.mailbox?.email || '业务员邮箱'} 自动发送。</p>
            <p>发送时段为工作日 {overview ? formatWindow(overview.config) : '09:30–17:30'}。客户回复、退订、退信或明确拒绝后会停止跟进。</p>
          </>}
          <p className="font-medium">请确认这个业务员的客户名单和邮箱已经核对无误。</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
interface OutreachResults {
  totalMatched?: number;
  analyzedCount?: number;
  truncated?: boolean;
  denominatorNote?: string;
  complaintCoverageNotice?: string;
  groups: {
    angle: string;
    preferenceName?: string;
    step: number;
    version: string;
    sent: number;
    hardBounces: number;
    optOuts?: number;
    complaints?: number;
    opened: number;
    clicked: number;
    proxyOpens: number;
    scannerClicks: number;
    replies: number;
    interested?: number;
    referrals?: number;
    notInterested?: number;
    autoReplies?: number;
    inquiries: number;
    sampleRequests: number;
    humanEdited?: number;
    quoted?: number;
    won?: number;
    highOpenLowReply?: boolean;
    recommendation?: 'keep' | 'rewrite' | 'pause' | 'insufficient_sample';
    recommendationReason?: string;
  }[];
  unmatchedReplies?: { total: number; note: string };
  optOuts: number;
  observedComplaints: number;
  observedBounces: number;
}

const RECOMMENDATION_BADGE: Record<string, { label: string; variant: 'developed' | 'warning' | 'failed' | 'outline' }> = {
  keep: { label: '建议保留', variant: 'developed' },
  rewrite: { label: '建议改写', variant: 'warning' },
  pause: { label: '建议停用', variant: 'failed' },
  insufficient_sample: { label: '样本不足', variant: 'outline' },
};

interface CrossBrandReport {
  windowDays: number;
  projects: {
    projectId: string;
    projectName: string;
    brandKey: string;
    sent: number;
    replies: number;
    interested: number;
    inquiries: number;
    sampleRequests: number;
    quoted: number;
    won: number;
    replyRate: number;
    optOuts: number;
    observedBounces: number;
    observedComplaints: number;
    highOpenLowReplyGroups: number;
  }[];
}

function OutreachResultsPanel({ endpoint, isAdmin }: { endpoint: string; isAdmin: boolean }) {
  const [data, setData] = React.useState<OutreachResults>();
  const [crossBrand, setCrossBrand] = React.useState<CrossBrandReport>();
  const [mode, setMode] = React.useState<'project' | 'cross_brand'>('project');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [harvesting, setHarvesting] = React.useState(false);

  async function load(targetMode = mode) {
    setLoading(true); setError('');
    try {
      if (targetMode === 'cross_brand') {
        setCrossBrand(await apiGet<CrossBrandReport>('/outreach-automation/results/cross-brand?windowDays=30'));
      } else {
        setData(await apiGet<OutreachResults>(endpoint));
      }
    }
    catch (reason) { setError(toErrorMessage(reason, '效果数据加载失败')); }
    finally { setLoading(false); }
  }

  async function harvestExemplars() {
    setHarvesting(true);
    try {
      const res = await apiPost<{ harvested: number }>('/outreach-automation/exemplars/harvest', { days: 60 });
      toast.success(`已回流 ${res.harvested} 篇脱敏优秀邮件范本`, { description: '后续写信与英文模板建议将参考已验证表现良好的范本。' });
    } catch (reason) {
      toast.error('回流范本失败', { description: toErrorMessage(reason, '请稍后重试') });
    } finally {
      setHarvesting(false);
    }
  }

  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
      <div className="space-y-1"><CardTitle className="text-sm">近 30 天自动开发效果与归因复盘</CardTitle>
        <CardDescription>按切入点、采购偏好、步骤和写信版本统计；自动标记「打开多、回复少」并给出保留/改写/停用建议。</CardDescription></div>
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <Button size="sm" variant={mode === 'project' ? 'secondary' : 'ghost'} className="h-7 px-2 text-xs" onClick={() => { setMode('project'); void load('project'); }}>当前项目</Button>
            <Button size="sm" variant={mode === 'cross_brand' ? 'secondary' : 'ghost'} className="h-7 px-2 text-xs" onClick={() => { setMode('cross_brand'); void load('cross_brand'); }}>跨品牌对照</Button>
          </div>
        ) : null}
        {isAdmin ? (
          <Button size="sm" variant="outline" onClick={() => void harvestExemplars()} disabled={harvesting}>
            {harvesting ? '回流中…' : '回流优秀范本'}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>{loading ? '加载中' : (mode === 'cross_brand' ? crossBrand : data) ? '刷新' : '查看'}</Button>
      </div>
    </CardHeader>
    {error && <CardContent><p role="alert" className="text-sm text-destructive">{error}</p></CardContent>}
    {mode === 'cross_brand' && crossBrand && <CardContent className="space-y-3">
      {crossBrand.projects.length ? <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow>{['项目 / 品牌', '已发', '有效回复（率）', '意向 / 询价 / 要样', '报价 / 成交', '退订 / 退信 / 投诉', '打开多回复少组'].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{crossBrand.projects.map(p => <TableRow key={p.projectId}>
          <TableCell><p className="font-medium">{p.projectName}</p><p className="text-xs text-muted-foreground">{p.brandKey}</p></TableCell>
          <TableCell className="tabular-nums">{p.sent}</TableCell>
          <TableCell className="tabular-nums">{p.replies}（{(p.replyRate * 100).toFixed(1)}%）</TableCell>
          <TableCell className="tabular-nums">{p.interested} / {p.inquiries} / {p.sampleRequests}</TableCell>
          <TableCell className="tabular-nums">{p.quoted} / {p.won}</TableCell>
          <TableCell className="tabular-nums">{p.optOuts} / {p.observedBounces} / {p.observedComplaints}</TableCell>
          <TableCell className="tabular-nums">{p.highOpenLowReplyGroups}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div> : <p className="text-sm text-muted-foreground">暂无可对照的活跃品牌项目。</p>}
    </CardContent>}
    {mode === 'project' && data && <CardContent className="space-y-3">
      <div className="space-y-1 text-xs text-muted-foreground">
        <p className="text-sm text-foreground">
          观察到 {data.observedBounces} 个收件地址硬退信 · {data.optOuts} 个退订 · {data.observedComplaints} 个投诉
          {data.unmatchedReplies?.total ? ` · 另有 ${data.unmatchedReplies.total} 封未匹配到具体开发信的来信` : ''}
        </p>
        {data.denominatorNote ? <p>{data.denominatorNote}</p> : null}
        {data.complaintCoverageNotice ? <p>{data.complaintCoverageNotice}</p> : null}
        {data.truncated ? <p className="text-amber-700 dark:text-amber-300">注：匹配记录超出单次窗口上限，已按最新发送记录优先统计。</p> : null}
      </div>
      {data.groups.length ? <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow>{['切入点 / 偏好', '已发（改稿）', '有效回复', '询价 / 要样', '报价 / 成交', '打开 / 点击（代理）', '负反馈（退订/退信）', '复盘建议'].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{data.groups.map(row => {
          const rec = row.recommendation ? RECOMMENDATION_BADGE[row.recommendation] : undefined;
          return <TableRow key={`${row.angle}-${row.preferenceName || ''}-${row.step}-${row.version}`}>
            <TableCell>
              <p className="font-medium">{row.angle}{row.preferenceName && row.preferenceName !== '未标定' ? ` · ${row.preferenceName}` : ''}</p>
              <p className="text-xs text-muted-foreground">第 {row.step || '—'} 封 · {row.version}</p>
            </TableCell>
            <TableCell className="tabular-nums">{row.sent}{row.humanEdited ? `（改 ${row.humanEdited}）` : ''}</TableCell>
            <TableCell className="tabular-nums">{row.replies}{row.autoReplies ? <span className="block text-[11px] text-muted-foreground">排除自动回复 {row.autoReplies}</span> : null}</TableCell>
            <TableCell className="tabular-nums">{row.inquiries} / {row.sampleRequests}</TableCell>
            <TableCell className="tabular-nums">{row.quoted ?? 0} / {row.won ?? 0}</TableCell>
            <TableCell className="tabular-nums">
              {row.opened} / {row.clicked}
              <span className="block text-[11px] text-muted-foreground">代理 {row.proxyOpens} · 扫描 {row.scannerClicks}</span>
            </TableCell>
            <TableCell className="tabular-nums">{row.optOuts ?? 0} / {row.hardBounces}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1">
                {rec ? <Badge variant={rec.variant}>{rec.label}</Badge> : null}
                {row.highOpenLowReply ? <Badge variant="warning">打开多回复少</Badge> : null}
              </div>
              {row.recommendationReason ? <p className="mt-1 max-w-[14rem] text-[11px] leading-4 text-muted-foreground">{row.recommendationReason}</p> : null}
            </TableCell>
          </TableRow>;
        })}</TableBody>
      </Table></div> : <p className="text-sm text-muted-foreground">近 30 天暂无自动发送记录。</p>}
    </CardContent>}
  </Card>;
}

interface WritingReleaseMetricBucket {
  brandKey: string;
  customerTier: string;
  writingVersion: string;
  totalDrafts: number;
  rewrittenCount: number;
  blockedCount: number;
  sendableCount: number;
  rewriteRate: number;
  blockRate: number;
  sendableRate: number;
}

interface WritingReleaseState {
  activeVersion: string;
  defaultVersion: string;
  previousVersion: string;
  paused: boolean;
  pausedReason?: string;
  metrics: WritingReleaseMetricBucket[];
}

function WritingReleaseCard() {
  const [state, setState] = React.useState<WritingReleaseState | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setState(await apiGet<WritingReleaseState>('/agent/writing-release'));
    } catch {
      // ignore initial optional panel error
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function updateRelease(body: { action: 'set_version' | 'pause_new' | 'rollback' | 'resume'; version?: string; reason?: string }) {
    setBusy(true);
    try {
      const next = await apiPut<WritingReleaseState>('/agent/writing-release', body);
      setState(next);
      toast.success('写信版本策略已更新');
    } catch (reason) {
      toast.error('更新失败', { description: toErrorMessage(reason, '请稍后重试') });
    } finally {
      setBusy(false);
    }
  }

  const totals = React.useMemo(() => {
    const rows = state?.metrics ?? [];
    const totalDrafts = rows.reduce((sum, r) => sum + r.totalDrafts, 0);
    const sendable = rows.reduce((sum, r) => sum + r.sendableCount, 0);
    const blocked = rows.reduce((sum, r) => sum + r.blockedCount, 0);
    const rewritten = rows.reduce((sum, r) => sum + r.rewrittenCount, 0);
    return {
      totalDrafts,
      sendableRate: totalDrafts > 0 ? sendable / totalDrafts : 0,
      blockRate: totalDrafts > 0 ? blocked / totalDrafts : 0,
      rewriteRate: totalDrafts > 0 ? rewritten / totalDrafts : 0,
    };
  }, [state]);

  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
      <div className="space-y-1">
        <CardTitle className="text-sm">写信版本发版门槛与回退控制</CardTitle>
        <CardDescription>跟踪可发送率、拦截率与人工改写率；如新版表现退步可一键切回上一版或暂停新版。</CardDescription>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => void load()}>刷新</Button>
        {state?.paused ? (
          <Button size="sm" disabled={busy} onClick={() => void updateRelease({ action: 'resume' })}>恢复新版写法</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void updateRelease({ action: 'rollback', reason: '人工回退到上一版写法' })}>切回上一版</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void updateRelease({ action: 'pause_new', reason: '暂停新版写法等待复盘' })}>暂停新版</Button>
          </>
        )}
      </div>
    </CardHeader>
    {state ? (
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={state.paused ? 'warning' : 'developed'}>当前版本：{state.activeVersion}</Badge>
          {state.paused && state.pausedReason ? <span className="text-amber-700 dark:text-amber-300">{state.pausedReason}</span> : null}
        </div>
        <p className="text-muted-foreground">
          近 30 天草稿 {totals.totalDrafts} 封 · 可发送率 {(totals.sendableRate * 100).toFixed(1)}% · 拦截率 {(totals.blockRate * 100).toFixed(1)}% · 人工改写率 {(totals.rewriteRate * 100).toFixed(1)}%
        </p>
      </CardContent>
    ) : null}
  </Card>;
}

interface LegacyAuditResult {
  countsByMode: { shadow: number; pilot: number; active: number; legacyUnset: number };
  pendingQueuedLetters: number;
  recommendation: string;
}

function LegacyUpgradeAuditBanner({ onMigrated }: { onMigrated: () => void }) {
  const [audit, setAudit] = React.useState<LegacyAuditResult | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void apiGet<LegacyAuditResult>('/outreach-automation/upgrade-audit')
      .then((res) => { if (active) setAudit(res); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!audit || audit.countsByMode.legacyUnset === 0) return null;

  async function migrate(targetMode: 'shadow' | 'pilot' | 'active') {
    setBusy(true);
    try {
      await apiPost('/outreach-automation/migrate-legacy-modes', { targetMode });
      toast.success(`已将历史配置统一迁移为 ${targetMode} 模式`);
      setAudit(null);
      onMigrated();
    } catch (reason) {
      toast.error('迁移失败', { description: toErrorMessage(reason, '请稍后重试') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
      <div className="space-y-0.5">
        <p className="font-semibold">升级前配置检查：发现 {audit.countsByMode.legacyUnset} 条历史自动开发配置未设置发送模式（排队邮件 {audit.pendingQueuedLetters} 封）</p>
        <p>{audit.recommendation}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void migrate('shadow')}>归类为模拟</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void migrate('pilot')}>归类为试发</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void migrate('active')}>确认为正式</Button>
      </div>
    </section>
  );
}

interface ExperimentSummary {
  id: string;
  name: string;
  controlVersion: string;
  treatmentVersion: string;
  observationWindowDays: number;
  minSamplePerArm: number;
  status: string;
  assignedCount: number;
}

interface ExperimentEval {
  id: string;
  name: string;
  status: string;
  control: { writingVersion: string; assigned: number; sent: number; validReplies: number; replyRate: number };
  treatment: { writingVersion: string; assigned: number; sent: number; validReplies: number; replyRate: number };
  zScore: number | null;
  pValueApprox: number | null;
  verdict: string;
  verdictNote: string;
}

function OutreachExperimentsCard() {
  const [items, setItems] = React.useState<ExperimentSummary[]>([]);
  const [selected, setSelected] = React.useState<ExperimentEval | null>(null);
  const [name, setName] = React.useState('');
  const [windowDays, setWindowDays] = React.useState(14);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setItems(await apiGet<ExperimentSummary[]>('/outreach-automation/experiments'));
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await apiPost<ExperimentEval>('/outreach-automation/experiments', {
        name: name.trim(),
        controlVersion: 'legacy-2026-10',
        treatmentVersion: '2026-11-19.2',
        stratifyBy: ['brand', 'data_tier', 'contact_role'],
        observationWindowDays: windowDays,
        minSamplePerArm: 30,
      });
      setSelected(created);
      setName('');
      toast.success('已启动分层 A/B 试发实验', { description: '新生成草稿将自动按分层确定性分桶并记录版本归因。' });
      await load();
    } catch (reason) {
      toast.error('创建实验失败', { description: toErrorMessage(reason, '请检查实验参数') });
    } finally {
      setBusy(false);
    }
  }

  async function inspect(id: string) {
    setBusy(true);
    try {
      setSelected(await apiGet<ExperimentEval>(`/outreach-automation/experiments/${id}`));
    } catch (reason) {
      toast.error('读取实验报告失败', { description: toErrorMessage(reason, '请稍后重试') });
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    setBusy(true);
    try {
      const stopped = await apiPost<ExperimentEval>(`/outreach-automation/experiments/${id}/stop`, {});
      setSelected(stopped);
      toast.success('实验已结束并锁定观察期');
      await load();
    } catch (reason) {
      toast.error('结束实验失败', { description: toErrorMessage(reason, '请稍后重试') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">分层可比较试发实验（旧版 vs 新版）</CardTitle>
        <CardDescription>按品牌、客户资料丰富度与联系人角色自动分桶，固定写法版本与观察期并做双比例显著性检验。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="实验名称（如：11 月新版正文 vs 旧版对照）"
            className="h-8 max-w-xs text-xs"
            disabled={busy}
          />
          <Input
            type="number"
            min={3}
            max={90}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value) || 14)}
            className="h-8 w-24 text-xs"
            aria-label="观察天数"
            disabled={busy}
          />
          <span className="text-muted-foreground">天观察期</span>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void create()}>启动新实验</Button>
        </div>

        {items.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {items.slice(0, 6).map((exp) => (
              <li key={exp.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div>
                  <span className="font-medium text-foreground">{exp.name}</span>
                  <span className="ml-2 text-muted-foreground">{exp.controlVersion} vs {exp.treatmentVersion} · 已分桶 {exp.assignedCount} 位</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant={exp.status === 'running' ? 'developed' : 'outline'}>{exp.status === 'running' ? '运行中' : '已结束'}</Badge>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void inspect(exp.id)}>查看统计</Button>
                  {exp.status === 'running' ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void stop(exp.id)}>结束</Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">当前暂无试发实验；启动后新生成的开发信会自动按分层规则分配对照组与新版组。</p>}

        {selected ? (
          <div className="space-y-1.5 rounded-md border bg-muted/20 p-3">
            <p className="font-medium text-foreground">实验报告：{selected.name}（{selected.verdict}）</p>
            <p className="text-muted-foreground">
              对照组（{selected.control.writingVersion}）：已发 {selected.control.sent} · 有效回复 {selected.control.validReplies}（{(selected.control.replyRate * 100).toFixed(1)}%）
              {' | '}
              新版组（{selected.treatment.writingVersion}）：已发 {selected.treatment.sent} · 有效回复 {selected.treatment.validReplies}（{(selected.treatment.replyRate * 100).toFixed(1)}%）
            </p>
            <p className="text-muted-foreground">
              {selected.zScore !== null ? `z = ${selected.zScore}, p ≈ ${selected.pValueApprox} · ` : ''}{selected.verdictNote}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
