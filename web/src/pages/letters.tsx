/**
 * 开发信记录页（Gallery-White & Charcoal Master-Detail Workbench）
 * ------------------------------------------------------------------
 * 跨客户查看所有已发送 / 草稿 / 失败的开发信，支持：
 *  - 顶部 4 维核心指标与趋势微图
 *  - 状态快速切换与多维筛选栏
 *  - 左表 + 右侧常驻「开发信详情」预览检查器（Master-Detail 双栏工作台）
 *  - 导出 Excel、审核草稿连续流转、重新发送与批量删除
 */
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Eye,
  FilePenLine,
  FilterX,
  Mail,
  Maximize2,
  RotateCw,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { WorkspaceToolbar } from '@/components/common/workspace';
import { SearchInput } from '@/components/common/search-input';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { LetterStatusBadge } from '@/components/common/status-badge';
import { MiniSparkline } from '@/components/common/charts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LetterTable } from '@/components/letters/letter-table';
import { LetterViewDialog } from '@/components/letters/letter-view-dialog';
import { SendLetterDialog } from '@/components/letters/send-letter-dialog';
import { useLetterList } from '@/hooks/use-queries';
import { usePageTitle } from '@/hooks/use-ui';
import { useLetterStore, type LetterSortField } from '@/store/letter.store';
import { useMetaStore } from '@/store/meta.store';
import { useUiStore } from '@/store/ui.store';
import { apiGet, toErrorMessage } from '@/lib/api';
import { downloadFile, stampedFilename } from '@/lib/download';
import { copyToClipboard, formatDateTime, formatRelative, htmlToPlainText } from '@/lib/format';
import { customerDetailPath, LETTER_STATUS_OPTIONS, MAIL_CHANNEL_LABEL, ROUTES } from '@/constants';
import type { Customer, DevelopmentLetter, MailChannel } from '@/types';

/** Select 的「不限」值（Radix 不接受空字符串） */
const ALL = 'all';

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: ALL, label: '全部方式' },
  ...Object.entries(MAIL_CHANNEL_LABEL).map(([value, label]) => ({ value, label })),
];

export function LettersPage(): React.JSX.Element {
  usePageTitle('开发信记录');
  const navigate = useNavigate();
  const openAgentWithPrompt = useUiStore((state) => state.openAgentWithPrompt);

  /* ---------------------------- store 订阅 ---------------------------- */

  const items = useLetterStore((state) => state.items);
  const total = useLetterStore((state) => state.total);
  const totalPages = useLetterStore((state) => state.totalPages);
  const loading = useLetterStore((state) => state.loading);
  const sending = useLetterStore((state) => state.sending);
  const error = useLetterStore((state) => state.error);
  const selectedIds = useLetterStore((state) => state.selectedIds);

  const search = useLetterStore((state) => state.search);
  const status = useLetterStore((state) => state.status);
  const channel = useLetterStore((state) => state.channel);
  const page = useLetterStore((state) => state.page);
  const limit = useLetterStore((state) => state.limit);
  const sortBy = useLetterStore((state) => state.sortBy);
  const sortOrder = useLetterStore((state) => state.sortOrder);

  const setFilters = useLetterStore((state) => state.setFilters);
  const setPage = useLetterStore((state) => state.setPage);
  const setLimit = useLetterStore((state) => state.setLimit);
  const setSorting = useLetterStore((state) => state.setSorting);
  const resetFilters = useLetterStore((state) => state.resetFilters);
  const buildQuery = useLetterStore((state) => state.buildQuery);
  const fetchList = useLetterStore((state) => state.fetchList);
  const toggleSelect = useLetterStore((state) => state.toggleSelect);
  const toggleSelectAll = useLetterStore((state) => state.toggleSelectAll);
  const clearSelection = useLetterStore((state) => state.clearSelection);
  const deleteLetter = useLetterStore((state) => state.deleteLetter);
  const bulkDelete = useLetterStore((state) => state.bulkDelete);

  const mailChannel = useMetaStore((state) => state.mailChannel);

  useLetterList();

  /* ---------------------------- 本地状态 ---------------------------- */

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [expandedBody, setExpandedBody] = React.useState(false);
  const [viewTarget, setViewTarget] = React.useState<DevelopmentLetter | null>(null);
  const [viewOpen, setViewOpen] = React.useState(false);
  const [sendOpen, setSendOpen] = React.useState(false);
  const [sendCustomer, setSendCustomer] = React.useState<Customer | null>(null);
  const [resendTarget, setResendTarget] = React.useState<DevelopmentLetter | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DevelopmentLetter | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);

  const hasFilters = search.trim() !== '' || status !== ALL || channel !== ALL;

  React.useEffect(() => {
    if (items.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !items.some((item) => item.id === activeId)) {
      setActiveId(items[0].id);
      setExpandedBody(false);
    }
  }, [items, activeId]);

  const activeLetter = React.useMemo(
    () => items.find((item) => item.id === activeId) ?? items[0] ?? null,
    [items, activeId],
  );

  const selectedLetters = React.useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  );

  const draftQueue = React.useMemo(
    () => items.filter((item) => item.status === 'draft' && item.review?.decision !== 'rejected'),
    [items],
  );

  /* ---------------------------- 统计指标（基于真实返回） ---------------------------- */

  const stats = React.useMemo(() => {
    const delivered = items.filter((item) => item.status === 'sent' || item.status === 'opened').length;
    const opened = items.filter((item) => item.status === 'opened' || Boolean(item.tracking?.opened)).length;
    const pendingAction = items.filter(
      (item) => item.status === 'draft' || item.status === 'failed' || Boolean(item.needsReview),
    ).length;
    const openRate = delivered > 0 ? Math.round((opened / delivered) * 100) : 0;
    return { delivered, opened, pendingAction, openRate };
  }, [items]);

  /* ---------------------------- 动作 ---------------------------- */

  const openLetterInDialog = React.useCallback(async (letter: DevelopmentLetter) => {
    if (letter.needsReview) {
      toast.warning('投递结果未知，暂不能重发', {
        description: '请先在邮件中心核对发件记录并确认是否已发出。',
      });
      return;
    }
    if (['queued', 'scheduled', 'sending', 'retrying'].includes(letter.status)) {
      toast.info('这封邮件正在排队或发送中', {
        description: '如需修改，请先到邮件中心取消待发任务。',
      });
      return;
    }
    setViewOpen(false);
    setPreparing(true);
    try {
      const [customer, fullLetter] = await Promise.all([
        apiGet<Customer>(`/customers/${letter.customerId}`),
        letter.status === 'draft' ? apiGet<DevelopmentLetter>(`/letters/${letter.id}`) : Promise.resolve(letter),
      ]);
      setSendCustomer(customer);
      setResendTarget(fullLetter);
      setSendOpen(true);
    } catch (caught) {
      toast.error('无法打开邮件编辑页', {
        description: toErrorMessage(caught, '客户或草稿信息加载失败，可能已被删除'),
      });
    } finally {
      setPreparing(false);
    }
  }, []);

  const openResend = React.useCallback(
    async (letter: DevelopmentLetter) => {
      await openLetterInDialog(letter);
    },
    [openLetterInDialog],
  );

  const handleSent = React.useCallback(() => {
    void fetchList();
  }, [fetchList]);

  const handleExport = React.useCallback(async () => {
    setExporting(true);
    try {
      const { page: _page, limit: _limit, ...filters } = buildQuery();
      await downloadFile('/letters/export', stampedFilename('开发信记录'), filters);
      toast.success('导出成功', { description: '文件已下载到浏览器默认目录' });
    } catch (caught) {
      toast.error('导出失败', { description: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setExporting(false);
    }
  }, [buildQuery]);

  const handleCopyLetter = React.useCallback(async (letter: DevelopmentLetter) => {
    const text = letter.contentText || htmlToPlainText(letter.content);
    if (!text.trim()) {
      toast.warning('该开发信没有可复制的正文');
      return;
    }
    const ok = await copyToClipboard(`${letter.subject}\n\n${text}`);
    if (ok) toast.success('已复制主题与正文');
    else toast.error('复制失败', { description: '浏览器阻止了剪贴板访问' });
  }, []);

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteLetter(deleteTarget.id);
      toast.success('开发信记录已删除', { description: '客户的开发信数量会同步减少' });
      setDeleteTarget(null);
      setViewOpen(false);
      await fetchList();
    } catch (caught) {
      toast.error('删除失败', { description: caught instanceof Error ? caught.message : String(caught) });
    }
  }, [deleteTarget, deleteLetter, fetchList]);

  const confirmBulkDelete = React.useCallback(async () => {
    if (selectedIds.length === 0) return;
    const requested = selectedIds.length;
    try {
      const result = await bulkDelete(selectedIds);
      if (result) {
        const skipped = Math.max(0, requested - result.deleted);
        if (result.deleted === 0) {
          toast.warning('未删除任何记录', { description: '所选记录均处于发送中或投递结果待确认，已自动跳过。' });
        } else if (skipped > 0) {
          toast.warning(`已删除 ${result.deleted} 条，跳过 ${skipped} 条`, {
            description: '跳过的记录处于发送中或投递结果待确认，暂不允许删除。',
          });
        } else {
          toast.success(`已删除 ${result.deleted} 条开发信记录`);
        }
      }
      setBulkDeleteOpen(false);
    } catch (caught) {
      toast.error('批量删除失败', { description: toErrorMessage(caught, '请稍后重试') });
    }
  }, [selectedIds, bulkDelete]);

  const activePlainBody = React.useMemo(() => {
    if (!activeLetter) return '';
    return (activeLetter.contentText || htmlToPlainText(activeLetter.content)).trim();
  }, [activeLetter]);

  const activeLocked = Boolean(
    activeLetter &&
      (['queued', 'scheduled', 'sending', 'retrying'].includes(activeLetter.status) ||
        (activeLetter.status === 'failed' && Boolean(activeLetter.needsReview))),
  );

  /* ---------------------------- 渲染 ---------------------------- */

  return (
    <div className="workspace-page">
      <PageHeader
        title="开发信记录"
        description={
          total > 0 ? (
            <>
              统一查询发送、草稿、审核及投递记录，当前共{' '}
              <span className="font-semibold text-foreground tabular-nums">{total.toLocaleString('zh-CN')}</span> 条留档
              {hasFilters ? '（已应用筛选条件）' : ''}
            </>
          ) : (
            '统一查询发送、草稿、审核及投递记录，跟踪开发信触达效果并持续优化沟通策略'
          )
        }
        actions={
          <>
            {hasFilters ? (
              <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                <FilterX className="h-4 w-4" aria-hidden />
                清空筛选
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={exporting}
              disabled={exporting || (total === 0 && !loading)}
              onClick={() => void handleExport()}
            >
              {!exporting ? <Download className="h-4 w-4" aria-hidden /> : null}
              导出记录
            </Button>
            <Button type="button" size="sm" asChild>
              <Link to={ROUTES.customers}>
                <Send className="h-3.5 w-3.5" aria-hidden />
                新建开发信
              </Link>
            </Button>
          </>
        }
      />

      {/* Unified Outreach Delivery Telemetry Strip + Status Segmented Switcher */}
      <section aria-label="开发信统计概览" className="os-telemetry-strip">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav aria-label="开发信状态快速切换" className="os-segmented">
            {(
              [
                ['all', '全部记录'],
                ['draft', '草稿'],
                ['sent', '已发送'],
                ['opened', '已打开'],
                ['failed', '失败与待确认'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilters({ status: key })}
                className={`os-segmented-item text-xs ${status === key ? 'os-segmented-item-active' : ''}`}
              >
                {label}
                {status === key && total > 0 ? (
                  <span className="ml-1 rounded-full bg-surface px-1.5 py-0 text-[10px] font-semibold tabular-nums text-foreground">
                    {total}
                  </span>
                ) : key === 'draft' && draftQueue.length > 0 && status !== 'draft' ? (
                  <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] font-medium tabular-nums text-amber-800 dark:text-amber-300">
                    {draftQueue.length}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center divide-x divide-border/70">
            {mailChannel === 'mock' ? (
              <div className="flex items-center gap-1.5 pr-4 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                模拟发送模式
              </div>
            ) : null}
            <div className="flex items-center gap-2 px-4">
              <Send className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-xs text-muted-foreground">全部记录</span>
              <span className="text-lg font-bold tabular-nums text-foreground">{total.toLocaleString('zh-CN')}</span>
              <MiniSparkline className="hidden w-12 shrink-0 2xl:block" values={[Math.max(1, items.length - 3), Math.max(1, items.length - 1), items.length, Math.max(total, items.length)]} />
            </div>
            <div className="flex items-center gap-2 px-4">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
              <span className="text-xs text-muted-foreground">本页投递</span>
              <span className="text-lg font-bold tabular-nums text-foreground">{stats.delivered}</span>
            </div>
            <div className="flex items-center gap-2 px-4">
              <Eye className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-xs text-muted-foreground">已打开</span>
              <span className="text-lg font-bold tabular-nums text-foreground">{stats.opened}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">({stats.openRate}%)</span>
            </div>
            <div className="flex items-center gap-2 pl-4">
              <Clock3 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="text-xs text-muted-foreground">待审与异常</span>
              <span className="text-lg font-bold tabular-nums text-foreground">{stats.pendingAction}</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------- 筛选栏 ---------------------------- */}

      <WorkspaceToolbar>
        <SearchInput
          value={search}
          onChange={(value) => setFilters({ search: value })}
          placeholder="搜索主题 / 收件人 / 邮箱…"
          className="w-full sm:w-64 lg:w-72"
          aria-label="搜索开发信"
        />

        <Select value={status} onValueChange={(value) => setFilters({ status: value as typeof status })}>
          <SelectTrigger className="h-8 w-auto min-w-[7.5rem] max-w-[12rem] text-xs" aria-label="开发信状态">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            {LETTER_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={channel} onValueChange={(value) => setFilters({ channel: value as MailChannel | 'all' })}>
          <SelectTrigger className="h-8 w-auto min-w-[8rem] max-w-[13rem] text-xs" aria-label="发送方式">
            <SelectValue placeholder="全部方式" />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {preparing ? <span className="text-xs text-muted-foreground">正在打开邮件编辑页…</span> : null}
      </WorkspaceToolbar>

      {/* ---------------------------- Master-Detail 双栏工作台 ---------------------------- */}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_324px] xl:items-stretch 2xl:grid-cols-[minmax(0,1fr)_356px]">
        <Card className="relative flex min-w-0 flex-col overflow-hidden">
          <LetterTable
            letters={items}
            loading={loading}
            error={error}
            selectedIds={selectedIds}
            activeId={activeLetter?.id ?? null}
            sortBy={sortBy}
            sortOrder={sortOrder}
            hasFilters={hasFilters}
            busy={sending}
            onSort={(field: LetterSortField) => setSorting(field)}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onSelectActive={(letter) => {
              setActiveId(letter.id);
              setExpandedBody(false);
            }}
            onView={(letter) => {
              setActiveId(letter.id);
              setViewTarget(letter);
              setViewOpen(true);
            }}
            onResend={(letter) => void openResend(letter)}
            onDelete={setDeleteTarget}
            onRetry={() => void fetchList()}
            onResetFilters={resetFilters}
            page={page}
            limit={limit}
            total={total}
            totalPages={totalPages}
            onPageChange={setPage}
            onLimitChange={setLimit}
          />
        </Card>

        {/* 右侧常驻「开发信详情」检查器 */}
        <aside
          aria-label="开发信详情预览"
          className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/80 bg-surface text-foreground">
                <Mail className="h-3.5 w-3.5" aria-hidden />
              </span>
              <h2 className="text-sm font-semibold text-foreground">开发信详情</h2>
            </div>
            {activeLetter ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="打开完整开发信详情"
                onClick={() => {
                  setViewTarget(activeLetter);
                  setViewOpen(true);
                }}
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>

          {activeLetter ? (
            <div className="mt-3.5 space-y-4">
              <div>
                <h3 className="text-[0.9375rem] font-semibold leading-snug text-foreground">
                  {activeLetter.subject || '（无主题）'}
                </h3>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <LetterStatusBadge status={activeLetter.status} needsReview={activeLetter.needsReview} />
                  <span className="text-[11px] text-muted-foreground">
                    {MAIL_CHANNEL_LABEL[activeLetter.channel] ?? activeLetter.channel}
                  </span>
                </div>
              </div>

              <dl className="space-y-2 rounded-lg border border-border/70 bg-surface/50 p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">收件人</dt>
                  <dd className="min-w-0 truncate text-right font-medium text-foreground">
                    {activeLetter.recipientName ? `${activeLetter.recipientName} · ` : ''}
                    {activeLetter.recipientEmail}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">所属客户</dt>
                  <dd className="min-w-0 truncate text-right">
                    {activeLetter.customer ? (
                      <Link
                        to={customerDetailPath(activeLetter.customer.id)}
                        className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        <User className="h-3 w-3 text-muted-foreground" aria-hidden />
                        <span className="truncate">{activeLetter.customer.name}</span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">客户已删除</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">发送时间</dt>
                  <dd className="text-right tabular-nums text-foreground">
                    {activeLetter.sentAt
                      ? `${formatDateTime(activeLetter.sentAt)}（${formatRelative(activeLetter.sentAt)}）`
                      : activeLetter.status === 'scheduled' && activeLetter.scheduledAt
                        ? `定时 ${formatDateTime(activeLetter.scheduledAt)}`
                        : '尚未发送'}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">打开情况</dt>
                  <dd className="text-right text-foreground">
                    {activeLetter.tracking?.opened
                      ? `已打开 ${activeLetter.tracking.dedupedOpenCount ?? activeLetter.tracking.openCount} 次`
                      : activeLetter.status === 'opened'
                        ? '已记录打开'
                        : '暂无打开回执'}
                  </dd>
                </div>
              </dl>

              {activeLetter.status === 'failed' && activeLetter.error ? (
                <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-3 py-2 text-xs text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300">
                  失败原因：{activeLetter.error}
                </div>
              ) : null}

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">邮件内容</span>
                  <button
                    type="button"
                    onClick={() => {
                      setViewTarget(activeLetter);
                      setViewOpen(true);
                    }}
                    className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    查看富文本排版
                  </button>
                </div>
                <div className="rounded-lg border border-border/80 bg-surface/60 p-3.5 text-xs leading-relaxed text-foreground/90">
                  {activePlainBody ? (
                    <>
                      <p className="whitespace-pre-line break-words">
                        {expandedBody || activePlainBody.length <= 320
                          ? activePlainBody
                          : `${activePlainBody.slice(0, 320)}…`}
                      </p>
                      {activePlainBody.length > 320 ? (
                        <button
                          type="button"
                          onClick={() => setExpandedBody((prev) => !prev)}
                          className="mt-2 inline-flex items-center text-[11px] font-semibold text-foreground underline-offset-2 hover:underline"
                        >
                          {expandedBody ? '收起正文' : '展开完整内容'}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-muted-foreground">（暂无正文内容）</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || activeLocked}
                  onClick={() => void openResend(activeLetter)}
                >
                  {activeLetter.status === 'draft' ? (
                    <>
                      <FilePenLine className="h-3.5 w-3.5" aria-hidden />
                      审核并发送
                    </>
                  ) : (
                    <>
                      <RotateCw className="h-3.5 w-3.5" aria-hidden />
                      重新发送
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopyLetter(activeLetter)}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  复制正文
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-center border border-border/70 bg-surface/50 text-xs hover:bg-surface"
                onClick={() =>
                  openAgentWithPrompt(
                    `请基于发给「${activeLetter.customer?.name || activeLetter.recipientName || activeLetter.recipientEmail}」的开发信《${activeLetter.subject || '无主题'}》，帮我起草一封简洁得体的二次跟进邮件（Follow-up），突出差异化价值并礼貌询问反馈。`,
                  )
                }
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                让 AI 基于此信起草二次跟进
              </Button>
            </div>
          ) : (
            <div className="py-12 text-center">
              <p className="text-xs font-medium text-foreground">未选中开发信记录</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                在左侧表格点击任意一行，即可在此快速检视收件人、投递状态与完整正文摘要。
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* ---------------------------- 批量操作条 ---------------------------- */}

      {selectedIds.length > 0 ? (
        <div
          className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-foreground/25 bg-card/95 px-3 py-2 shadow-lg backdrop-blur animate-in slide-in-from-bottom-2 duration-200"
          role="toolbar"
          aria-label="批量操作"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            已选
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2 text-xs font-semibold tabular-nums text-primary-foreground">
              {selectedIds.length}
            </span>
            条记录
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={sending}
            loading={sending}
            onClick={() => setBulkDeleteOpen(true)}
          >
            删除所选
          </Button>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={clearSelection}>
            取消选择
          </Button>
        </div>
      ) : null}

      {/* ---------------------------- 弹窗 ---------------------------- */}

      <LetterViewDialog
        open={viewOpen}
        onOpenChange={(open) => {
          setViewOpen(open);
          if (!open) setViewTarget(null);
        }}
        letter={viewTarget}
        onResend={(letter) => void openResend(letter)}
        onDelete={setDeleteTarget}
        onOpenCustomer={(customerId) => {
          setViewOpen(false);
          navigate(customerDetailPath(customerId));
        }}
      />

      <SendLetterDialog
        open={sendOpen}
        onOpenChange={(open) => {
          setSendOpen(open);
          if (!open) {
            setResendTarget(null);
            setSendCustomer(null);
          }
        }}
        customer={sendCustomer}
        letter={resendTarget}
        onSent={handleSent}
        onReviewed={(updated) => {
          setResendTarget(updated);
          void fetchList();
        }}
        queueProgress={(() => {
          if (!resendTarget || resendTarget.status !== 'draft') return undefined;
          const idx = draftQueue.findIndex((item) => item.id === resendTarget.id);
          if (idx < 0) return undefined;
          return {
            index: idx,
            total: draftQueue.length,
            hasPrev: idx > 0,
            hasNext: idx < draftQueue.length - 1,
          };
        })()}
        onAdvanceNext={() => {
          if (!resendTarget) return;
          const remaining = draftQueue.filter((item) => item.id !== resendTarget.id);
          const nextItem = remaining[0];
          if (!nextItem) {
            setSendOpen(false);
            setResendTarget(null);
            setSendCustomer(null);
            return;
          }
          void openLetterInDialog(nextItem);
        }}
        onNavigateQueue={(delta) => {
          if (!resendTarget) return;
          const idx = draftQueue.findIndex((item) => item.id === resendTarget.id);
          const nextItem = draftQueue[idx + delta];
          if (!nextItem) return;
          void openLetterInDialog(nextItem);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除开发信记录"
        description={
          deleteTarget
            ? `确定要删除「${deleteTarget.subject || '（无主题）'}」这条记录吗？删除后无法恢复。`
            : undefined
        }
        confirmText="删除"
        variant="destructive"
        loading={sending}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`删除 ${selectedIds.length} 条开发信记录`}
        description="这些记录会被永久删除，客户的开发信数量会同步减少。"
        confirmText="全部删除"
        variant="destructive"
        loading={sending}
        onConfirm={confirmBulkDelete}
      >
        {selectedLetters.length > 0 ? (
          <ul className="space-y-1">
            {selectedLetters.slice(0, 20).map((letter) => (
              <li key={letter.id} className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{letter.subject || '（无主题）'}</span>
                <span className="shrink-0 truncate text-muted-foreground">{letter.recipientEmail}</span>
              </li>
            ))}
            {selectedLetters.length > 20 ? (
              <li className="pt-1 text-muted-foreground">…等共 {selectedLetters.length} 条</li>
            ) : null}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
