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
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  OutreachDraftStage,
  OutreachEnrollmentErrorHistoryItem,
  OutreachSendGateDetail,
  ProjectApprovedProofBlock,
  UserDto,
} from '@/types';

type SendGateFixAction = 'recheck' | 'strip_offer' | 'split_paragraphs';

interface ReverifyBatchResult {
  scanned: number;
  queued: number;
  skipped: number;
  skippedDetails?: { customerId: string; customerName: string; reason: string }[];
  skippedReasons?: { reason: string; count: number }[];
}

function isExceptionQueueRow(row: OutreachAutomationQueueRow): boolean {
  return Boolean(
    row.draftNeedsReverify
    || row.draftStage === 'draft_audit_failed'
    || row.draftStage === 'task_failed'
    || row.draftStage === 'delivery_failed'
    || row.status === 'failed',
  );
}

interface EnrollmentDiagnosticsDto {
  enrollmentId: string;
  customerId: string;
  customerName: string;
  company?: string;
  email?: string;
  enrollmentStatus: string;
  currentStep: number;
  nextStep: number;
  lastError?: string;
  pausedReadyToResume?: boolean;
  errorHistory?: OutreachEnrollmentErrorHistoryItem[];
  sendReadiness?: {
    status:
      | 'ready_to_send'
      | 'paused_ready_to_resume'
      | 'waiting_buyer_window'
      | 'blocked_by_send_gate'
      | 'blocked_by_audit'
      | 'delivery_failed'
      | 'task_in_progress'
      | 'task_failed'
      | 'completed'
      | 'stopped'
      | 'no_draft';
    label: string;
    detail: string;
    auditPassed: boolean;
    sendGatePassed: boolean;
    sendGateIssues: string[];
    sendGateDetail?: OutreachSendGateDetail;
    bodyHashValid?: boolean;
    knowledgeFresh?: boolean;
    staleSources?: { sourceId: string; title: string; reason: string }[];
    waitingForWindow: boolean;
    waitingForSchedule: boolean;
  };
  timezone: {
    effectiveTimezone: string;
    source: 'explicit' | 'country' | 'fallback';
    windowStart: string;
    windowEnd: string;
    windowOpen: boolean;
    nextSendAt: string;
    useBuyerTimezone: boolean;
    defaultTimezone: string;
  };
  latestTask: {
    id: string;
    status: string;
    currentStep?: string;
    currentStepLabel?: string;
    attempts: number;
    failureClass?: 'circuit_rejected' | 'upstream_error' | 'none';
    errorCode?: string;
    errorMessage?: string;
    totalDurationMs: number;
    createdAt: string;
    updatedAt: string;
    steps: {
      key: string;
      label: string;
      state: string;
      attempts: number;
      durationMs?: number;
      error?: string;
      verifyMode?: string;
      checksCount?: number;
      issuesCount?: number;
      completeness?: string;
      failureCategory?: string;
      failureCode?: string;
    }[];
    recentEvents: { at: string; step?: string; message: string }[];
  } | null;
  latestDraft: {
    id: string;
    status: string;
    outreachStep?: number;
    subject: string;
    updatedAt: string;
    needsReverify: boolean;
    auditReason?: string;
    sendGateIssue?: string;
    completeness?: string;
    factAuditMode?: string;
    failureCategory?: string;
    failureCategoryLabel?: string;
    failureCode?: string;
    failureStage?: string;
    failureStageLabel?: string;
    failureDetail?: string;
    fastPath?: boolean;
    fallbackApplied?: boolean;
    fallbackNote?: string;
    tierSummary?: { red: number; yellow: number; green: number; proofBlocksUsed: string[] };
    checksTotal: number;
    checksSupported: number;
    checksNonClaim: number;
    checksFailed: number;
    failedChecks?: {
      id: string;
      status: string;
      reason: string;
      excerpt: string;
    }[];
    issues: { code: string; message: string }[];
  } | null;
}

const DRAFT_STAGE_META: Record<
  Exclude<OutreachDraftStage, 'none'>,
  { label: string; variant: 'outline' | 'warning' | 'failed' | 'developed' }
> = {
  reverify_queued: { label: '已提交重核（排队）', variant: 'outline' },
  waiting_model: { label: '等待模型', variant: 'warning' },
  draft_saved_verified: { label: '核验通过', variant: 'developed' },
  draft_audit_failed: { label: '核验不完整', variant: 'failed' },
  task_failed: { label: 'AI 任务失败', variant: 'failed' },
  delivery_failed: { label: '投递失败（SMTP）', variant: 'failed' },
};

const TZ_SOURCE_LABELS: Record<'explicit' | 'country' | 'fallback', string> = {
  explicit: '客户指定时区',
  country: '国家/区号推断',
  fallback: '回退默认时区',
};

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
  blocked: { label: () => '按规则停止', variant: 'muted' },
  completed: { label: () => '三封已完成', variant: 'developed' },
  failed: { label: () => '需要处理', variant: 'failed' },
};

function formatWindow(config: OutreachAutomationConfig): string {
  return `${config.windowStart}–${config.windowEnd}`;
}

function blockedStatus(reason: string): { label: string; detail: string; variant: 'warning' | 'muted' | 'developed' } {
  if (reason.includes('已回复')) {
    return { label: '按规则停止 · 客户已回复', detail: '已自动停止后续开发，转人工跟进（非故障）', variant: 'developed' };
  }
  if (reason.includes('退订') || reason.includes('退信') || reason.includes('拒绝')) {
    return { label: '按规则停止 · 退订/拒收', detail: '已按合规规则停止发送（非故障）', variant: 'muted' };
  }
  if (reason.includes('已删除') || reason.includes('归属已变化')) {
    return { label: '按规则停止 · 归属变更', detail: '客户已删除或负责人已变更', variant: 'muted' };
  }
  if (reason.includes('不在可开发状态')) {
    return { label: '按规则停止 · 已转人工', detail: '客户状态已变化，自动开发停止（非故障）', variant: 'muted' };
  }
  return { label: '按规则停止', detail: reason || '按业务规则不再继续发送', variant: 'muted' };
}

function phaseBadge(
  row: OutreachAutomationQueueRow,
  windowOpen: boolean,
): { label: string; variant: 'outline' | 'warning' | 'failed' | 'muted' | 'developed'; detail?: string } {
  if (row.isRuleStopped || row.phase === 'blocked') {
    return blockedStatus(row.lastError ?? '');
  }
  if (row.draftStage === 'delivery_failed') {
    return { label: '投递失败（SMTP）', variant: 'failed' };
  }
  if (row.pausedReadyToResume) {
    return { label: '队列暂停 · 待恢复', variant: 'warning' };
  }
  if (row.draftStage === 'draft_audit_failed') {
    if (row.sendGateDetail) {
      return { label: '其他发送检查拦截', variant: 'failed' };
    }
    return { label: '事实核验不完整', variant: 'failed' };
  }
  const effectiveOpen = row.recipientWindowOpen ?? windowOpen;
  if (!effectiveOpen && ['due', 'ready', 'generating', 'sending'].includes(row.phase)) {
    return { label: '等待当地发送时段', variant: 'outline' };
  }
  const meta = PHASE_META[row.phase];
  return { label: meta.label(row.nextStep), variant: meta.variant };
}

function nextActionLabel(row: OutreachAutomationQueueRow, windowOpen: boolean, windowText: string): string {
  const effectiveOpen = row.recipientWindowOpen ?? windowOpen;
  if (row.isRuleStopped || row.phase === 'blocked') {
    const status = blockedStatus(row.lastError ?? '');
    if (status.label.includes('客户已回复')) return '按规则停止：查看客户并人工跟进';
    if (status.label.includes('归属变更')) return '按规则停止：请确认负责人后重新加入';
    if (status.label.includes('退订/拒收')) return '按规则停止：保持停发，保留记录';
    if (status.label.includes('已转人工')) return '按规则停止：已转人工跟进';
    return '按规则停止（非系统故障）';
  }
  if (row.draftStage === 'delivery_failed') {
    return `第 ${row.nextStep} 封邮件投递失败（与草稿核验无关），请排查收件箱/退信后处理`;
  }
  if (row.draftStage === 'waiting_model') {
    return row.taskStepLabel ? `模型执行中：${row.taskStepLabel}` : '模型正在生成与核验草稿';
  }
  if (row.draftStage === 'reverify_queued') {
    return '已入队等待模型处理';
  }
  if (row.pausedReadyToResume) {
    return '当前草稿检查已通过，队列仍暂停，待恢复（不会自动恢复）';
  }
  if (row.draftStage === 'draft_audit_failed') {
    if (row.sendGateDetail) {
      return row.sendGateDetail.guidance;
    }
    return row.draftAuditDetail?.rebuiltAndFailedAgain
      ? '新稿再次核验失败：请查看下方具体缺失句子/步骤，补充依据后再处理'
      : '请查看具体缺失句子或点「诊断」定位核验缺口，勿盲目反复重建';
  }
  if (row.draftStage === 'task_failed') {
    return row.taskRetryAt
      ? `下次退避重试：${formatDateTime(row.taskRetryAt)}`
      : '请点「诊断」排查 AI 上游错误后再单条试跑';
  }
  if (!effectiveOpen && ['due', 'ready', 'sending'].includes(row.phase)) {
    return `等当地工作日 ${windowText}（${formatDateTime(row.nextRunAt)}）`;
  }
  switch (row.phase) {
    case 'waiting':
      return `${formatRelative(row.nextRunAt)}（${formatDateTime(row.nextRunAt)}）${row.draftReady ? ' · 草稿已过核验待发' : ''}`;
    case 'generating':
      return '正在生成并核验草稿';
    case 'ready':
      return row.draftReady ? '草稿已过核验，等待发送队列' : '等待核验与发送检查';
    case 'sending':
      return '正在通过 SMTP 发送';
    case 'due':
      return '已到发送时间，等待处理';
    case 'paused':
      return row.draftStage === 'draft_saved_verified' ? '当前草稿检查已通过，队列仍暂停，待恢复' : '暂停中（可单条试跑核验）';
    case 'failed':
      return '请点「诊断」排查后单条试跑';
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
  const [diagOpen, setDiagOpen] = React.useState(false);
  const [diagLoading, setDiagLoading] = React.useState(false);
  const [diagData, setDiagData] = React.useState<EnrollmentDiagnosticsDto | null>(null);
  const [diagRowId, setDiagRowId] = React.useState('');
  const [queueFilter, setQueueFilter] = React.useState<'all' | 'exceptions' | 'paused_ready'>('all');
  const [lastReverifyResult, setLastReverifyResult] = React.useState<ReverifyBatchResult | null>(null);
  const [error, setError] = React.useState('');
  const dirtyRef = React.useRef(false);
  const ownerTouchedRef = React.useRef(false);
  const queueCardRef = React.useRef<HTMLDivElement | null>(null);

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
    setLastReverifyResult(null);
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
      const action = row.status === 'paused' || row.status === 'failed' || row.status === 'blocked' ? 'resume' : 'pause';
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

  const reverifyAllUnverified = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<ReverifyBatchResult & { overview: OutreachAutomationOverview }>(
        scoped('/outreach-automation/reverify-unverified'),
        {},
      );
      setOverview(res.overview);
      setForm(res.overview.config);
      setLastReverifyResult({
        scanned: res.scanned,
        queued: res.queued,
        skipped: res.skipped,
        skippedDetails: res.skippedDetails,
        skippedReasons: res.skippedReasons,
      });
      const skipSummary = res.skippedReasons?.length
        ? `；跳过原因：${res.skippedReasons.map((r) => `${r.reason}（${r.count}）`).join('，')}`
        : '';
      if (res.queued > 0) {
        toast.success(`重建结果：入队 ${res.queued} 封，跳过 ${res.skipped} 封`, {
          description: `${res.overview.config.enabled
            ? '新草稿将在后台用当前模型完成逐项核验后按节奏发送'
            : '正式发送仍保持暂停；等待核验完成后确认无待核验项再恢复发送'}${skipSummary}`,
        });
      } else if (res.skipped > 0) {
        toast.info(`已扫描 ${res.scanned} 封：入队 0 封，跳过 ${res.skipped} 封`, {
          description: skipSummary.replace(/^；/, '') || '请查看横幅下方跳过明细',
        });
      } else {
        toast.info('当前没有可重建的未核验草稿（其余拦截请按各自入口处理）');
      }
    } catch (caught) {
      setError(toErrorMessage(caught, '批量重建未核验草稿失败'));
    } finally {
      setBusy(false);
    }
  };

  const fixSendGate = async (enrollmentId: string, action: SendGateFixAction, refreshDiag = false): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{
        fixed: boolean;
        action: SendGateFixAction;
        remainingIssue?: string;
        summary: string;
        overview: OutreachAutomationOverview;
      }>(scoped(`/outreach-automation/enrollments/${enrollmentId}/fix-send-gate`), { action });
      setOverview(res.overview);
      setForm(res.overview.config);
      if (res.fixed) {
        toast.success(res.summary);
      } else {
        toast.warning(res.summary);
      }
      if (refreshDiag) {
        const updatedDiag = await apiGet<EnrollmentDiagnosticsDto>(
          scoped(`/outreach-automation/enrollments/${enrollmentId}/diagnostics`),
        );
        setDiagData(updatedDiag);
      }
    } catch (caught) {
      toast.error(toErrorMessage(caught, '发送检查处理失败'));
    } finally {
      setBusy(false);
    }
  };

  const regenerateRow = async (row: OutreachAutomationQueueRow): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{
        queued: boolean;
        taskId?: string;
        overview: OutreachAutomationOverview;
      }>(scoped(`/outreach-automation/enrollments/${row.id}/regenerate`), {});
      setOverview(res.overview);
      setForm(res.overview.config);
      toast.success(`已为 ${row.customerName} 提交单条第 ${row.nextStep} 封生成与核验`, {
        description: res.overview.config.enabled
          ? '核验通过后按买家当地排程发送。'
          : '正式发送仍保持暂停；可点「诊断」跟踪步骤耗时与核验结果。',
      });
    } catch (caught) {
      setError(toErrorMessage(caught, '重新生成草稿失败'));
    } finally {
      setBusy(false);
    }
  };

  const drainQueuedTasks = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ cancelled: number; overview: OutreachAutomationOverview }>(
        scoped('/outreach-automation/drain-queued-tasks'),
        {},
      );
      setOverview(res.overview);
      setForm(res.overview.config);
      toast.success(`已清理 ${res.cancelled} 条积压排队任务`, {
        description: '正在执行的任务和已保存草稿未受影响；现在可挑 1 条客户点「单条试跑」验证。',
      });
    } catch (caught) {
      setError(toErrorMessage(caught, '清理积压排队任务失败'));
    } finally {
      setBusy(false);
    }
  };

  const recoverCircuitFailed = async (includeUpstreamAiFailures = false): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ scanned: number; recovered: number; skipped: number; overview: OutreachAutomationOverview }>(
        scoped('/outreach-automation/recover-circuit-failed'),
        includeUpstreamAiFailures ? { includeUpstreamAiFailures: true } : {},
      );
      setOverview(res.overview);
      setForm(res.overview.config);
      if (res.recovered > 0) {
        toast.success(
          includeUpstreamAiFailures
            ? `已用当前模型重新恢复 ${res.recovered} 位旧 AI 失败客户`
            : `已恢复 ${res.recovered} 位因 AI 熔断误停的客户`,
          {
            description: res.overview.config.enabled
              ? '已错峰排程并在单账号并发上限 3 条内逐步恢复；历史发信失败和合规停止的客户未受影响。'
              : '已重置为暂停待发状态（总开关仍关闭），不会触发发送；历史发信失败和合规停止的客户未受影响。',
          },
        );
      } else {
        toast.info('当前没有符合条件的 AI 失败客户需要恢复');
      }
    } catch (caught) {
      setError(toErrorMessage(caught, '恢复失败客户失败'));
    } finally {
      setBusy(false);
    }
  };

  const loadDiagnostics = React.useCallback(async (enrollmentId: string) => {
    setDiagRowId(enrollmentId);
    setDiagOpen(true);
    setDiagLoading(true);
    try {
      const data = await apiGet<EnrollmentDiagnosticsDto>(scoped(`/outreach-automation/enrollments/${enrollmentId}/diagnostics`));
      setDiagData(data);
    } catch (caught) {
      toast.error(toErrorMessage(caught, '加载单条诊断失败'));
    } finally {
      setDiagLoading(false);
    }
  }, [scoped]);

  const mailbox = overview?.mailbox;
  const canStart = (overview?.config.rolloutMode === 'shadow' || Boolean(mailbox?.canSend)) && Boolean(overview?.stats.eligible || overview?.stats.enrolled);
  const ruleStoppedCount = overview?.stats.ruleStopped ?? 0;
  const nonRuleBlocked = Math.max(0, (overview?.stats.blocked ?? 0) - ruleStoppedCount);
  const issueCount = (overview?.stats.paused ?? 0) + (overview?.stats.failed ?? 0) + nonRuleBlocked;
  const unverifiedCount = overview?.stats.unverifiedDrafts ?? 0;
  const rebuildableCount = overview?.stats.rebuildableUnverifiedDrafts ?? unverifiedCount;
  const sendGateBlockedCount = overview?.stats.sendGateBlockedDrafts ?? 0;
  const pausedReadyCount = overview?.stats.pausedReadyCount ?? 0;
  const deliveryFailedCount = overview?.stats.deliveryFailedCount ?? 0;
  const circuitFailedCount = overview?.stats.circuitFailed ?? 0;
  const aiFailedCount = overview?.stats.aiFailed ?? 0;
  const circuitOpen = Boolean(overview?.circuit?.open);
  const circuitCooldownSec = Math.ceil((overview?.circuit?.cooldownRemainingMs ?? 0) / 1000);
  const queuedTasksCount = overview?.stats.queuedTasks ?? 0;
  const runningTasksCount = overview?.stats.runningTasks ?? 0;
  const retryingTasksCount = overview?.stats.retryingTasks
    ?? (overview?.queue.filter((r) => r.draftStage === 'task_failed' && Boolean(r.taskRetryAt)).length ?? 0);
  const failedTasksCount = overview?.stats.failedTasks ?? 0;
  const historicalFailedTasksCount = overview?.stats.historicalFailedTasks ?? 0;
  const sendGateCounts = React.useMemo(() => {
    const rows = (overview?.queue ?? []).filter((r) => r.draftStage === 'draft_audit_failed' && r.sendGateDetail);
    return {
      missingEvidence: rows.filter((r) => r.sendGateDetail?.code === 'missing_supplier_evidence').length,
      offerMismatch: rows.filter((r) => r.sendGateDetail?.code === 'offer_unauthorized' || r.sendGateDetail?.code === 'offer_condition_unmet').length,
      layoutOrLength: rows.filter((r) => ['paragraph_too_long', 'word_count', 'cta_count'].includes(r.sendGateDetail?.code ?? '')).length,
    };
  }, [overview?.queue]);

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
            {overview.config.enabled && overview.config.useBuyerTimezone ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-sky-200/70 bg-sky-50/70 p-2.5 text-xs leading-5 text-sky-800 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                已开启按买家当地时间发送（各客户按其当地工作日 {formatWindow(overview.config)} 排程；无法识别时区时回退默认时区 {overview.config.timezone}）。具体时区与下次发送时间见下方队列。
              </p>
            ) : overview.config.enabled && !overview.windowOpen ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-sky-200/70 bg-sky-50/70 p-2.5 text-xs leading-5 text-sky-800 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                当前不在发送时段（工作日 {formatWindow(overview.config)}，{overview.config.timezone}）。队列会保留，等到下一个工作日自动继续。
              </p>
            ) : null}
            {(queuedTasksCount > 0 || runningTasksCount > 0 || retryingTasksCount > 0 || failedTasksCount > 0 || historicalFailedTasksCount > 0) ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground">AI 草稿任务状态：</span>
                  <span>当前排队 <strong className="tabular-nums text-foreground">{queuedTasksCount}</strong></span>
                  <span>· 运行中 <strong className="tabular-nums text-foreground">{runningTasksCount}</strong></span>
                  <span>· 待重试 <strong className="tabular-nums text-foreground">{retryingTasksCount}</strong></span>
                  {failedTasksCount > 0 ? (
                    <span>· 当前任务阻塞 <strong className="tabular-nums text-destructive">{failedTasksCount}</strong></span>
                  ) : null}
                  {historicalFailedTasksCount > 0 ? (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      历史失败记录 {historicalFailedTasksCount}（旧轮次累计，非当前阻塞）
                    </Badge>
                  ) : null}
                  <span className="text-[11px]">（单账号自动并发上限 3 条）</span>
                </div>
                {queuedTasksCount > 0 ? (
                  <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void drainQueuedTasks()}>
                    清理积压排队任务（{queuedTasksCount}）
                  </Button>
                ) : null}
              </div>
            ) : null}
            {overview.config.enabled && overview.stats.remainingToday === 0 ? (
              <p className="mt-3 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
                今天这个邮箱的 {overview.config.dailyLimit} 封额度已用完，明天发送时段会继续。
              </p>
            ) : null}
            {circuitOpen || circuitFailedCount > 0 || aiFailedCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                <div className="flex min-w-0 items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <div className="space-y-0.5">
                    <p className="font-semibold">
                      {circuitOpen
                        ? `AI 通道处于熔断冷却中（剩余约 ${circuitCooldownSec} 秒），期间已暂停新建任务且不消耗客户重试次数`
                        : circuitFailedCount > 0
                          ? `发现 ${circuitFailedCount} 位客户曾因 AI 通道熔断/并发保护误停（共 ${aiFailedCount} 位旧 AI 失败客户）`
                          : `发现 ${aiFailedCount} 位客户因历史 AI 超时/502 达到重试上限而停发`}
                    </p>
                    <p className="leading-5 text-muted-foreground">
                      切换更稳定的模型（如 DeepSeek）后，点击右侧按钮可一键清理旧 AI 失败记录并错峰恢复（严格不动历史 SMTP 发信失败与合规停止客户）。
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {circuitFailedCount > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 border-destructive/40 bg-background text-destructive hover:bg-destructive/10"
                      disabled={busy}
                      onClick={() => void recoverCircuitFailed(false)}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                      仅恢复熔断误停（{circuitFailedCount}）
                    </Button>
                  ) : null}
                  {aiFailedCount > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 border-destructive/40 bg-background text-destructive hover:bg-destructive/10"
                      disabled={busy}
                      onClick={() => void recoverCircuitFailed(true)}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                      切模型后恢复旧 AI 失败（{aiFailedCount}）
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {unverifiedCount > 0 ? (
              <div className="mt-3 space-y-2 rounded-md border border-amber-300/70 bg-amber-50/70 p-2.5 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <div className="space-y-0.5">
                      <p className="font-semibold">
                        事实核验不完整：{unverifiedCount} 封（当前可重建 {rebuildableCount} 封）
                        {sendGateBlockedCount > 0 ? `；另有 ${sendGateBlockedCount} 封正文已过核验、卡在其他发送检查` : ''}
                      </p>
                      <p className="leading-5">
                        右侧按钮仅重建「事实核验不完整」且满足条件的可重建草稿，不会误处理其他发送检查或已人工批准草稿
                        {overview.config.enabled ? '。' : '（正式发送仍保持暂停，核验通过后您再手动恢复）。'}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 border-amber-400/70 bg-background text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
                    disabled={busy || rebuildableCount === 0}
                    onClick={() => void reverifyAllUnverified()}
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                    一键重建未核验草稿（{rebuildableCount}）
                  </Button>
                </div>
              </div>
            ) : null}
            {lastReverifyResult ? (
              <div className="mt-2.5 flex flex-wrap items-start justify-between gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    本次批量重建结果：已扫描 {lastReverifyResult.scanned} 封 · 入队 <strong className="text-emerald-600 dark:text-emerald-400">{lastReverifyResult.queued}</strong> 封 · 跳过 <strong>{lastReverifyResult.skipped}</strong> 封
                  </p>
                  {lastReverifyResult.skippedReasons && lastReverifyResult.skippedReasons.length > 0 ? (
                    <p className="text-muted-foreground">
                      跳过原因汇总：{lastReverifyResult.skippedReasons.map((r) => `${r.reason}（${r.count}）`).join('；')}
                    </p>
                  ) : null}
                  {lastReverifyResult.skippedDetails && lastReverifyResult.skippedDetails.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      跳过明细：{lastReverifyResult.skippedDetails.slice(0, 8).map((d) => `${d.customerName}：${d.reason}`).join('；')}
                      {lastReverifyResult.skippedDetails.length > 8 ? ` 等共 ${lastReverifyResult.skippedDetails.length} 条` : ''}
                    </p>
                  ) : null}
                </div>
                <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setLastReverifyResult(null)}>
                  收起
                </Button>
              </div>
            ) : null}
            {sendGateBlockedCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-300/70 bg-sky-50/70 p-2.5 text-xs text-sky-900 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200">
                <div className="space-y-0.5">
                  <p className="font-semibold">
                    其他发送检查拦截：{sendGateBlockedCount} 封（正文逐项核验已通过，请勿盲目重建）
                  </p>
                  <p className="leading-5">
                    {[
                      sendGateCounts.missingEvidence > 0 ? `首封缺我方能力依据 ${sendGateCounts.missingEvidence} 封` : '',
                      sendGateCounts.offerMismatch > 0 ? `寄样/色卡或优惠授权不匹配 ${sendGateCounts.offerMismatch} 封（可一键删除提议后重检）` : '',
                      sendGateCounts.layoutOrLength > 0 ? `单段过长/字数/提问规则 ${sendGateCounts.layoutOrLength} 封（可拆段或调整后重检）` : '',
                    ].filter(Boolean).join(' · ') || '请在下方队列按每行具体拦截提示使用对应处理按钮。'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 bg-background"
                  onClick={() => {
                    setQueueFilter('exceptions');
                    queueCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  查看并处理（{sendGateBlockedCount}）
                </Button>
              </div>
            ) : null}
            {pausedReadyCount > 0 || deliveryFailedCount > 0 ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-xs text-muted-foreground">
                {pausedReadyCount > 0 ? (
                  <span>
                    · 已有 <strong className="text-foreground">{pausedReadyCount}</strong> 位客户当前草稿检查已通过，队列仍暂停，待手动恢复（不会自动恢复发送）
                  </span>
                ) : null}
                {deliveryFailedCount > 0 ? (
                  <span>
                    · 另有 <strong className="text-destructive">{deliveryFailedCount}</strong> 位客户历史发信投递失败（SMTP 拒收/发送异常，与草稿核验无关）
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          <section aria-label="自动开发指标" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: '可加入客户', value: overview.stats.eligible, hint: '待开发，或已有开发信记录', icon: Users },
              { label: '进行中', value: overview.stats.active, hint: `队列共 ${overview.stats.enrolled} 位`, icon: Bot },
              { label: '今日已发', value: `${overview.stats.sentToday}/${overview.config.dailyLimit}`, hint: `剩余 ${overview.stats.remainingToday} 封`, icon: Send },
              { label: '需要处理', value: issueCount, hint: `暂停/待处理/异常停止${ruleStoppedCount > 0 ? `（按规则停止 ${ruleStoppedCount} 位不计入）` : ''}`, icon: ShieldCheck },
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

            <Card ref={queueCardRef} className="min-w-0">
              <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
                    自动开发队列
                  </CardTitle>
                  <CardDescription className="text-xs leading-5">每 5 秒刷新；只显示当前账号负责的客户。</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border p-0.5 text-xs">
                    <Button
                      type="button"
                      size="sm"
                      variant={queueFilter === 'all' ? 'secondary' : 'ghost'}
                      className="h-7 px-2 text-xs"
                      onClick={() => setQueueFilter('all')}
                    >
                      全部（{overview.queue.length}）
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={queueFilter === 'exceptions' ? 'secondary' : 'ghost'}
                      className="h-7 px-2 text-xs"
                      onClick={() => setQueueFilter('exceptions')}
                    >
                      异常待审（{overview.queue.filter(isExceptionQueueRow).length}）
                    </Button>
                    {pausedReadyCount > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={queueFilter === 'paused_ready' ? 'secondary' : 'ghost'}
                        className="h-7 px-2 text-xs"
                        onClick={() => setQueueFilter('paused_ready')}
                      >
                        已过检待恢复（{pausedReadyCount}）
                      </Button>
                    ) : null}
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={busy || !overview.config.enabled || overview.stats.eligible === 0} onClick={() => void enrollMore()}>
                    <Users className="h-4 w-4" aria-hidden />
                    加入符合条件客户
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {(() => {
                  const visibleQueue = queueFilter === 'exceptions'
                    ? overview.queue.filter(isExceptionQueueRow)
                    : queueFilter === 'paused_ready'
                      ? overview.queue.filter((r) => Boolean(r.pausedReadyToResume))
                      : overview.queue;
                  if (visibleQueue.length === 0) {
                    return (
                      <div className="px-4 py-10 text-center">
                        <Bot className="mx-auto h-7 w-7 text-muted-foreground/60" aria-hidden />
                        <p className="mt-2 text-sm font-medium">
                          {queueFilter === 'exceptions'
                            ? '当前没有异常待审客户'
                            : queueFilter === 'paused_ready'
                              ? '当前没有已过检待恢复的客户'
                              : '还没有自动开发客户'}
                        </p>
                        <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                          {queueFilter === 'exceptions'
                            ? '所有已生成的草稿均已通过分级核验与发送检查，无需人工介入。'
                            : queueFilter === 'paused_ready'
                              ? '当前没有处于暂停且草稿已过检的客户。'
                              : canStart ? '点击右上角「开始自动开发」，系统会从符合条件的客户开始准备并发送下一封。' : '先配置并验证个人发件邮箱，再开始自动开发。'}
                        </p>
                      </div>
                    );
                  }
                  return (
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
                        {visibleQueue.map((row) => {
                          const status = phaseBadge(row, overview.windowOpen);
                          const verificationBlocked = row.status === 'blocked' && Boolean(row.lastError && /核验|依据审核|依据已变化|模拟校验|缺少依据|partial|unverif/i.test(row.lastError));
                          const complianceBlocked = Boolean(row.isRuleStopped) || (row.status === 'blocked' && !verificationBlocked);
                          const controllable = !complianceBlocked && (row.status === 'active' || row.status === 'paused' || row.status === 'failed' || verificationBlocked);
                          const sendGate = row.sendGateDetail;
                          const canSingleTestRun = row.status !== 'completed'
                            && !complianceBlocked
                            && row.draftStage !== 'waiting_model'
                            && !sendGate;
                          const stageMeta = row.draftStage && row.draftStage !== 'none' ? DRAFT_STAGE_META[row.draftStage] : undefined;
                          const showStageMeta = Boolean(stageMeta && stageMeta.label !== status.label);
                          const lastArchivedError = row.errorHistory?.length ? row.errorHistory[row.errorHistory.length - 1] : undefined;
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
                                <div className="flex flex-wrap items-center gap-1">
                                  <Badge variant={status.variant}>{status.label}</Badge>
                                  {showStageMeta && stageMeta ? <Badge variant={stageMeta.variant}>{stageMeta.label}</Badge> : null}
                                  {row.draftAuditDetail?.completeness === 'partial' ? (
                                    <Badge variant="outline" className="text-[10px]">部分核验</Badge>
                                  ) : null}
                                  {row.draftAuditDetail?.failureStageLabel ? (
                                    <Badge variant="outline" className="text-[10px]">{row.draftAuditDetail.failureStageLabel}</Badge>
                                  ) : null}
                                  {row.draftAuditDetail?.rebuiltAndFailedAgain ? (
                                    <Badge variant="warning" className="text-[10px]">新稿再次失败</Badge>
                                  ) : null}
                                </div>
                                {row.draftStage === 'task_failed' && row.taskError ? (
                                  <p className="mt-1 max-w-[18rem] text-[11px] leading-4 text-destructive">
                                    {row.taskStepLabel ? `[${row.taskStepLabel}] ` : ''}
                                    {row.taskError}
                                    {row.taskErrorCode ? ` (${row.taskErrorCode})` : ''}
                                  </p>
                                ) : row.draftStage === 'delivery_failed' ? (
                                  <div className="mt-1 max-w-[18rem] space-y-0.5 text-[11px] leading-4 text-destructive">
                                    <p>第 {row.nextStep} 封邮件投递失败（SMTP）：{row.deliveryError || row.lastError || '邮件发送被拒或异常'}</p>
                                    <Link to={`/customers/${row.customerId}`} className="inline-block text-primary underline underline-offset-2">
                                      查看客户发信记录
                                    </Link>
                                  </div>
                                ) : row.draftStage === 'waiting_model' && row.taskStepLabel ? (
                                  <p className="mt-1 max-w-[15rem] text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                                    当前步骤：{row.taskStepLabel}
                                  </p>
                                ) : sendGate ? (
                                  <div className="mt-1 max-w-[20rem] space-y-0.5 text-[11px] leading-4">
                                    <p className="font-medium text-destructive">{sendGate.label}</p>
                                    <p className="text-muted-foreground">{sendGate.detail}</p>
                                  </div>
                                ) : row.draftNeedsReverify && (row.draftAuditDetail || row.draftAuditReason) ? (
                                  <div className="mt-1 max-w-[20rem] space-y-1 text-[11px] leading-4">
                                    <p className="text-destructive">
                                      {row.draftAuditDetail?.summary || row.draftAuditReason}
                                      {row.draftUpdatedAt ? `（更新：${formatDateTime(row.draftUpdatedAt)}）` : ''}
                                    </p>
                                    {row.draftAuditDetail?.previousError ? (
                                      <p className="text-muted-foreground">
                                        上次失败原因（已归档）：{row.draftAuditDetail.previousError}
                                      </p>
                                    ) : null}
                                    {row.draftAuditDetail?.failedChecks?.length ? (
                                      <ul className="space-y-0.5 rounded bg-muted/40 p-1.5 text-[11px]">
                                        {row.draftAuditDetail.failedChecks.slice(0, 2).map((chk, idx) => (
                                          <li key={`${chk.id}-${idx}`} className="text-muted-foreground">
                                            <span className="font-medium text-destructive">[{chk.status}]</span>{' '}
                                            {chk.excerpt ? `“${chk.excerpt}”` : ''}{' '}
                                            <span>{chk.reason}</span>
                                          </li>
                                        ))}
                                        {row.draftAuditDetail.checksFailed > 2 ? (
                                          <li className="text-muted-foreground">
                                            还有 {row.draftAuditDetail.checksFailed - 2} 处未通过句，点「诊断」查看全部
                                          </li>
                                        ) : null}
                                      </ul>
                                    ) : null}
                                  </div>
                                ) : row.pausedReadyToResume ? (
                                  <div className="mt-1 max-w-[18rem] space-y-0.5 text-[11px] leading-4">
                                    <p className="text-emerald-700 dark:text-emerald-300">
                                      当前草稿核验与发送检查均已通过（队列仍暂停）
                                    </p>
                                    {lastArchivedError ? (
                                      <p className="text-muted-foreground">
                                        已归档旧拦截：{lastArchivedError.message}
                                      </p>
                                    ) : null}
                                  </div>
                                ) : status.detail ? (
                                  <p className={`mt-1 max-w-[14rem] text-[11px] leading-4 ${status.variant === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                                    {status.detail}
                                  </p>
                                ) : row.lastError ? (
                                  <p className={`mt-1 max-w-[14rem] text-[11px] leading-4 ${row.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                                    {row.lastError}
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell className="min-w-[14rem] text-xs text-muted-foreground">
                                <p>{nextActionLabel(row, overview.windowOpen, formatWindow(overview.config))}</p>
                                {row.effectiveTimezone && row.status !== 'completed' && !complianceBlocked ? (
                                  <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                                    时区：{row.effectiveTimezone}（{TZ_SOURCE_LABELS[row.timezoneSource ?? 'fallback']}
                                    {row.recipientWindowOpen ? ' · 当前在时段内' : ' · 非当地时段'}）
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="inline-flex flex-wrap items-center justify-end gap-1">
                                  {sendGate?.canStripOffer ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-8 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() => void fixSendGate(row.id, 'strip_offer')}
                                    >
                                      删除提议后重检
                                    </Button>
                                  ) : null}
                                  {sendGate?.canSplitParagraphs ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-8 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() => void fixSendGate(row.id, 'split_paragraphs')}
                                    >
                                      拆段并重检
                                    </Button>
                                  ) : null}
                                  {sendGate?.code === 'missing_supplier_evidence' ? (
                                    isAdmin ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-8 px-2 text-xs"
                                        onClick={() => document.getElementById('approved-proof-blocks')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                      >
                                        去补充证据块
                                      </Button>
                                    ) : (
                                      <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" asChild>
                                        <Link to="/knowledge">查看知识依据</Link>
                                      </Button>
                                    )
                                  ) : null}
                                  {sendGate?.canRecheck ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-2 text-xs"
                                      disabled={busy}
                                      onClick={() => void fixSendGate(row.id, 'recheck')}
                                    >
                                      重检
                                    </Button>
                                  ) : null}
                                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void loadDiagnostics(row.id)}>
                                    诊断
                                  </Button>
                                  {canSingleTestRun ? (
                                    <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void regenerateRow(row)}>
                                      单条试跑
                                    </Button>
                                  ) : null}
                                  {controllable ? (
                                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void controlRow(row)}>
                                      {row.status === 'active' ? '暂停' : '恢复'}
                                    </Button>
                                  ) : null}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  );
                })()}
              </CardContent>
            </Card>
          </div>

          {isAdmin ? <ApprovedProofBlocksCard key={`proofs-${activeProjectId}`} onSaved={() => void load(true)} /> : null}
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

      <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 text-base">
              <span>单条诊断 · {diagData?.customerName || '加载中'}</span>
              {diagRowId ? (
                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={diagLoading} onClick={() => void loadDiagnostics(diagRowId)}>
                  <RefreshCw className={`h-3 w-3 ${diagLoading ? 'animate-spin' : ''}`} aria-hidden />
                  刷新诊断
                </Button>
              ) : null}
            </DialogTitle>
            <DialogDescription className="text-xs">
              按任务 ID 串联模型生成、逐项核验耗时与错误码、草稿保存状态以及买家实际时区排程。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 text-xs">
            {diagLoading && !diagData ? (
              <p className="flex items-center gap-2 py-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />读取中…</p>
            ) : diagData ? (
              <>
                {diagData.sendReadiness ? (
                  <div className={`rounded-md border p-3 space-y-1.5 ${
                    diagData.sendReadiness.status === 'ready_to_send' || diagData.sendReadiness.status === 'waiting_buyer_window' || diagData.sendReadiness.status === 'completed'
                      ? 'border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10'
                      : diagData.sendReadiness.status === 'blocked_by_send_gate' || diagData.sendReadiness.status === 'blocked_by_audit' || diagData.sendReadiness.status === 'task_failed'
                        ? 'border-destructive/40 bg-destructive/5'
                        : 'bg-muted/20'
                  }`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={
                        diagData.sendReadiness.status === 'ready_to_send' || diagData.sendReadiness.status === 'waiting_buyer_window' || diagData.sendReadiness.status === 'completed'
                          ? 'developed'
                          : diagData.sendReadiness.status === 'blocked_by_send_gate' || diagData.sendReadiness.status === 'blocked_by_audit' || diagData.sendReadiness.status === 'task_failed'
                            ? 'failed'
                            : 'outline'
                      }>
                        {diagData.sendReadiness.label}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        正文核验：{diagData.sendReadiness.auditPassed ? '通过' : '未通过'}
                        {' · '}发送闸门：{diagData.sendReadiness.sendGatePassed ? '通过' : '未通过'}
                        {diagData.sendReadiness.bodyHashValid !== undefined ? ` · 正文指纹：${diagData.sendReadiness.bodyHashValid ? '一致' : '已变更'}` : ''}
                        {diagData.sendReadiness.knowledgeFresh !== undefined ? ` · 依据新鲜度：${diagData.sendReadiness.knowledgeFresh ? '最新' : '已过期'}` : ''}
                      </span>
                    </div>
                    <p className="leading-5 text-foreground">{diagData.sendReadiness.detail}</p>
                    {diagData.sendReadiness.sendGateDetail ? (
                      <div className="space-y-1.5 rounded border border-border/70 bg-background/80 p-2">
                        <p className="font-medium text-foreground">处理建议：{diagData.sendReadiness.sendGateDetail.guidance}</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {diagData.sendReadiness.sendGateDetail.canStripOffer ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() => void fixSendGate(diagData.enrollmentId, 'strip_offer', true)}
                            >
                              删除提议后重检
                            </Button>
                          ) : null}
                          {diagData.sendReadiness.sendGateDetail.canSplitParagraphs ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() => void fixSendGate(diagData.enrollmentId, 'split_paragraphs', true)}
                            >
                              拆段并重检
                            </Button>
                          ) : null}
                          {diagData.sendReadiness.sendGateDetail.canRecheck ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() => void fixSendGate(diagData.enrollmentId, 'recheck', true)}
                            >
                              立即重检
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {diagData.sendReadiness.sendGateIssues.length > 0 ? (
                      <ul className="list-disc pl-4 text-destructive">
                        {diagData.sendReadiness.sendGateIssues.map((msg, idx) => (
                          <li key={idx}>{msg}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {diagData.errorHistory && diagData.errorHistory.length > 0 ? (
                  <div className="rounded-md border bg-muted/20 p-3 space-y-1.5">
                    <p className="font-semibold text-foreground">历史拦截归档记录（{diagData.errorHistory.length}）</p>
                    <ul className="space-y-1 text-[11px] text-muted-foreground">
                      {diagData.errorHistory.slice().reverse().map((item, idx) => (
                        <li key={`${item.at}-${idx}`} className="rounded bg-background px-2 py-1">
                          <span className="font-medium text-foreground">
                            {item.step ? `第 ${item.step} 封 · ` : ''}{item.message}
                          </span>
                          {item.resolvedReason ? ` → ${item.resolvedReason}` : ''}
                          {item.resolvedAt ? `（${formatDateTime(item.resolvedAt)}）` : `（${formatDateTime(item.at)}）`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="rounded-md border bg-muted/20 p-3 space-y-1">
                  <p className="font-semibold text-foreground">买家实际排程时区（第 {diagData.nextStep} 封）</p>
                  <p className="text-muted-foreground">
                    使用时区：<strong className="text-foreground">{diagData.timezone.effectiveTimezone}</strong>（{TZ_SOURCE_LABELS[diagData.timezone.source]}）
                    · 发送时段 {diagData.timezone.windowStart}–{diagData.timezone.windowEnd}
                    · {diagData.timezone.windowOpen ? '当前在时段内' : `下一次可发送：${formatDateTime(diagData.timezone.nextSendAt)}`}
                  </p>
                </div>

                <div className="rounded-md border p-3 space-y-2">
                  <p className="font-semibold text-foreground">最新草稿与逐项核验分层</p>
                  {diagData.latestDraft ? (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={diagData.latestDraft.needsReverify || diagData.latestDraft.sendGateIssue ? 'failed' : 'developed'}>
                          {diagData.latestDraft.needsReverify
                            ? (diagData.latestDraft.failureCategoryLabel ? `核验失败 · ${diagData.latestDraft.failureCategoryLabel}` : '正文核验未通过')
                            : diagData.latestDraft.sendGateIssue
                              ? '正文核验通过 · 其他发送检查未通过'
                              : '草稿已保存且核验通过'}
                        </Badge>
                        {diagData.latestDraft.fastPath ? (
                          <Badge variant="developed">预审卖点零等待直通</Badge>
                        ) : null}
                        {diagData.latestDraft.fallbackApplied ? (
                          <Badge variant="outline">槽位安全降级</Badge>
                        ) : null}
                        {diagData.latestDraft.failureStageLabel ? (
                          <Badge variant="outline">阶段：{diagData.latestDraft.failureStageLabel}</Badge>
                        ) : null}
                        {diagData.latestDraft.failureCode ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{diagData.latestDraft.failureCode}</code>
                        ) : null}
                        <span className="text-muted-foreground">
                          第 {diagData.latestDraft.outreachStep ?? '—'} 封 · completeness={diagData.latestDraft.completeness ?? '—'} · mode={diagData.latestDraft.factAuditMode ?? '—'}
                        </span>
                      </div>
                      <p className="text-foreground">主题：{diagData.latestDraft.subject}</p>
                      <p className="text-muted-foreground">
                        逐项核验：总计 {diagData.latestDraft.checksTotal} 项 · 支持 {diagData.latestDraft.checksSupported} · 非事实 {diagData.latestDraft.checksNonClaim} · 未通过 {diagData.latestDraft.checksFailed} · 更新于 {formatDateTime(diagData.latestDraft.updatedAt)}
                      </p>
                      {diagData.latestDraft.tierSummary ? (
                        <p className="text-muted-foreground">
                          红/黄/绿分层：红线 {diagData.latestDraft.tierSummary.red} · 黄线客户实体 {diagData.latestDraft.tierSummary.yellow} · 绿线卖点/非事实 {diagData.latestDraft.tierSummary.green}
                          {diagData.latestDraft.tierSummary.proofBlocksUsed.length > 0 ? ` · 命中预审块 ${diagData.latestDraft.tierSummary.proofBlocksUsed.length} 条` : ''}
                        </p>
                      ) : null}
                      {diagData.latestDraft.fallbackNote ? (
                        <p className="rounded bg-sky-50/70 px-2 py-1 text-sky-900 dark:bg-sky-400/10 dark:text-sky-200">
                          降级说明：{diagData.latestDraft.fallbackNote}
                        </p>
                      ) : null}
                      {diagData.latestDraft.failureDetail ? (
                        <p className="rounded bg-amber-50/70 px-2 py-1 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">
                          核验分层说明：{diagData.latestDraft.failureDetail}
                        </p>
                      ) : null}
                      {diagData.latestDraft.failedChecks && diagData.latestDraft.failedChecks.length > 0 ? (
                        <div className="space-y-1 rounded border bg-muted/20 p-2">
                          <p className="font-medium text-foreground">未通过核验的段落/句子（{diagData.latestDraft.failedChecks.length} 处）：</p>
                          <ul className="space-y-1.5">
                            {diagData.latestDraft.failedChecks.map((chk, idx) => (
                              <li key={`${chk.id}-${idx}`} className="rounded bg-background p-1.5 text-[11px]">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant="failed" className="px-1.5 py-0 text-[10px]">{chk.status}</Badge>
                                  <span className="font-medium text-destructive">{chk.reason}</span>
                                </div>
                                {chk.excerpt ? <p className="mt-1 text-muted-foreground">摘录：{chk.excerpt}</p> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {diagData.latestDraft.sendGateIssue ? (
                        <p className="text-destructive">自动发送闸门原因：{diagData.latestDraft.sendGateIssue}</p>
                      ) : null}
                      {diagData.latestDraft.issues.length > 0 ? (
                        <ul className="list-disc pl-4 text-amber-700 dark:text-amber-300">
                          {diagData.latestDraft.issues.map((i, idx) => (
                            <li key={idx}>[{i.code}] {i.message}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">当前第 {diagData.nextStep} 封尚未保存新草稿。</p>
                  )}
                </div>

                <div className="rounded-md border p-3 space-y-2">
                  <p className="font-semibold text-foreground">最新 AI 任务串联日志</p>
                  {diagData.latestTask ? (
                    <div className="space-y-2">
                      <p className="text-muted-foreground">
                        任务 ID：<code className="text-[11px]">{diagData.latestTask.id}</code>
                        · 状态：<strong className="text-foreground">{diagData.latestTask.status}</strong>
                        {diagData.latestTask.currentStepLabel ? ` · 步骤：${diagData.latestTask.currentStepLabel}` : ''}
                        · 累计耗时：{(diagData.latestTask.totalDurationMs / 1000).toFixed(1)}s
                      </p>
                      {diagData.latestTask.errorMessage ? (
                        <p className="rounded bg-destructive/10 px-2 py-1 text-destructive">
                          {diagData.latestTask.failureClass === 'circuit_rejected' ? '[熔断/并发保护，未发往上游] ' : '[实际发往上游失败] '}
                          {diagData.latestTask.errorMessage}
                          {diagData.latestTask.errorCode ? ` (${diagData.latestTask.errorCode})` : ''}
                        </p>
                      ) : null}
                      {diagData.latestTask.steps.length > 0 ? (
                        <div className="overflow-x-auto rounded border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="h-7 text-[11px]">步骤</TableHead>
                                <TableHead className="h-7 text-[11px]">状态</TableHead>
                                <TableHead className="h-7 text-[11px]">耗时</TableHead>
                                <TableHead className="h-7 text-[11px]">核验/错误详情</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {diagData.latestTask.steps.map((s, idx) => (
                                <TableRow key={`${s.key}-${idx}`}>
                                  <TableCell className="py-1.5 text-[11px]">{s.label}</TableCell>
                                  <TableCell className="py-1.5 text-[11px]">{s.state}</TableCell>
                                  <TableCell className="py-1.5 text-[11px] tabular-nums">{s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                                  <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                                    {s.error
                                      ? <span className="text-destructive">{s.error}</span>
                                      : s.verifyMode
                                        ? `${s.verifyMode} · ${s.checksCount ?? 0} checks · ${s.issuesCount ?? 0} issues${s.failureCategory ? ` · ${s.failureCategory}` : ''}`
                                        : '—'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">暂无第 {diagData.nextStep} 封 AI 任务记录。</p>
                  )}
                </div>
              </>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>

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

const PROOF_SLOT_LABELS: Record<ProjectApprovedProofBlock['slot'], string> = {
  identity: '公司定位（identity）',
  proof: '核心卖点（proof）',
  cta: '低压力提问（cta）',
};

function ApprovedProofBlocksCard({ onSaved }: { onSaved: () => void }) {
  const [blocks, setBlocks] = React.useState<ProjectApprovedProofBlock[]>([]);
  const [suggested, setSuggested] = React.useState<ProjectApprovedProofBlock[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  const loadBlocks = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ blocks: ProjectApprovedProofBlock[]; suggested: ProjectApprovedProofBlock[] }>('/outreach-automation/proof-blocks');
      setBlocks(res.blocks);
      setSuggested(res.suggested);
      setDirty(false);
    } catch {
      // ignore initial load error
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void loadBlocks(); }, [loadBlocks]);

  const applySuggested = () => {
    if (!suggested.length) {
      toast.info('当前项目已发布知识库中未提取到可用的英文无承诺卖点句，可手动添加。');
      return;
    }
    const existingKeys = new Set(blocks.map((b) => b.text.trim().toLowerCase()));
    const fresh = suggested.filter((s) => !existingKeys.has(s.text.trim().toLowerCase()));
    if (!fresh.length) {
      toast.info('知识库候选卖点块均已在列表中。');
      return;
    }
    setBlocks((prev) => [...prev, ...fresh].slice(0, 30));
    setExpanded(true);
    setDirty(true);
    toast.success(`已导入 ${fresh.length} 条知识库候选卖点块，核对后点「保存预审卖点块」生效`);
  };

  const addEmpty = () => {
    setBlocks((prev) => [
      ...prev,
      {
        id: `custom_${Date.now().toString(36)}`,
        slot: 'proof',
        label: '自定义英文卖点',
        text: '',
        enabled: true,
      },
    ]);
    setExpanded(true);
    setDirty(true);
  };

  const updateAt = (index: number, patch: Partial<ProjectApprovedProofBlock>) => {
    setBlocks((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
    setDirty(true);
  };

  const removeAt = (index: number) => {
    setBlocks((prev) => prev.filter((_, idx) => idx !== index));
    setDirty(true);
  };

  const saveBlocks = async () => {
    setSaving(true);
    try {
      const cleaned = blocks.filter((b) => b.label.trim() && b.text.trim());
      const res = await apiPut<{ blocks: ProjectApprovedProofBlock[] }>('/outreach-automation/proof-blocks', { blocks: cleaned });
      setBlocks(res.blocks);
      setDirty(false);
      toast.success(`已保存 ${res.blocks.filter((b) => b.enabled).length} 条启用的项目预审卖点块`, {
        description: '新生成开发信将优先原句锚定这些卖点块，核验可直接零等待直通，减少 50%+ AI 请求和 502 风险。',
      });
      onSaved();
    } catch (caught) {
      toast.error('保存预审卖点块失败', { description: toErrorMessage(caught, '请检查每条卖点块的标题和英文正文') });
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = blocks.filter((b) => b.enabled && b.text.trim()).length;

  return (
    <Card id="approved-proof-blocks">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            项目预审英文卖点块（Approved Proof Blocks）
            <Badge variant={enabledCount > 0 ? 'developed' : 'outline'}>已启用 {enabledCount} 条</Badge>
          </CardTitle>
          <CardDescription className="text-xs leading-5">
            行业标准 4 槽位写稿 + 红黄绿分级核验：开发信原句引用下方预审卖点块时可走零 LLM 快速核验直通，大幅提升通过率并降低上游 502/超时；红线商业承诺（价格/MOQ/交期/认证/免费）仍 100% 严格拦截。
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={loading || saving} onClick={applySuggested}>
            从知识库自动提取（{suggested.length}）
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={saving} onClick={addEmpty}>
            新增一条
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开管理（${blocks.length}）`}
          </Button>
          {dirty ? (
            <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={saving} onClick={() => void saveBlocks()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              保存预审卖点块
            </Button>
          ) : null}
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="space-y-2.5 text-xs">
          {blocks.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-muted-foreground">
              暂无项目预审卖点块。点右上角「从知识库自动提取」即可从当前项目已发布英文知识库一键生成候选定位句、卖点句和低压力提问。
            </p>
          ) : (
            <div className="space-y-2">
              {blocks.map((block, idx) => (
                <div key={`${block.id}-${idx}`} className="grid gap-2 rounded-md border bg-muted/20 p-2.5 md:grid-cols-[10rem_11rem_minmax(0,1fr)_auto]">
                  <Select value={block.slot} onValueChange={(v: ProjectApprovedProofBlock['slot']) => updateAt(idx, { slot: v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['identity', 'proof', 'cta'] as const).map((slot) => (
                        <SelectItem key={slot} value={slot}>{PROOF_SLOT_LABELS[slot]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={block.label}
                    onChange={(e) => updateAt(idx, { label: e.target.value })}
                    placeholder="中文标签（如：工厂定位）"
                    className="h-8 text-xs"
                  />
                  <Input
                    value={block.text}
                    onChange={(e) => updateAt(idx, { text: e.target.value })}
                    placeholder="已审核的标准英文句子（不含未确认价格/MOQ/交期/免费承诺）"
                    className="h-8 text-xs"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Switch checked={block.enabled} onCheckedChange={(checked) => updateAt(idx, { enabled: checked })} aria-label="启用该卖点块" />
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => removeAt(idx)}>
                      删除
                    </Button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end pt-1">
                <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void saveBlocks()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                  保存预审卖点块
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
