/**
 * 客户发现工作区（Prospecting）— 三栏式 AI 线索研究工作台
 * ------------------------------------------------------------------
 * 对齐 02_客户发现 设计架构，采用微暖画廊白与炭黑（Notion / Claude 质感）：
 * - 顶部：工作区标题、操作组、我的/公共/团队线索池页签 + 5 栏核心指标与 AI 策略卡
 * - 主体三栏工作台：
 *   1. 左栏（筛选条件）：关键词即时过滤、线索状态、匹配度分层、目标市场国家标签、数据来源
 *   2. 中栏（线索结果）：高密度可勾选线索流卡片（带匹配度徽章、快捷全选与批量转化）
 *   3. 右栏（深度研究工作区）：公司横幅、官网/社媒直达、「研究摘要 / 公司与联系人 / 采集与同步」多页签、
 *      AI 研究摘要与匹配依据 + AI 开发建议快捷动作卡（一键转为客户并准备开发信）
 */
import * as React from 'react';
import { ProspectingSettingsDialog, ProspectingRunDialog } from '@/components/prospecting/search-profile-dialogs';
import {
  AtSign,
  BookOpen,
  Check,
  ChevronRight,
  ExternalLink,
  FileSpreadsheet,
  Globe2,
  Instagram,
  Linkedin,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Target,
  UserMinus,
  UserPlus,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { DataPagination } from '@/components/common/data-pagination';
import { DEFAULT_PAGE_SIZE } from '@/constants';
import { Badge } from '@/components/ui/badge';
import { CountryFlag } from '@/components/common/country-flag';
import { countryInfo } from '@/lib/country';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ImportDialog } from '@/components/customers/import-dialog';
import { EnrichDialog } from '@/components/prospecting/enrich-dialog';
import { usePageTitle } from '@/hooks/use-ui';
import { apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth.store';
import { useUiStore } from '@/store/ui.store';
import type { Prospect, ProspectingReport, ProspectingToday } from '@/types';

function socialHref(value: string, host: string, prefix = '') {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname.replace(/^www\./, '') === host
      ? url.href
      : undefined;
  } catch {
    return /^[\w.%-]{1,100}$/.test(value) ? 'https://' + host + '/' + prefix + encodeURIComponent(value) : undefined;
  }
}

function scoreBadgeClass(score: number) {
  if (score >= 80) return 'border-emerald-300/75 bg-emerald-50/85 text-emerald-800 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300';
  if (score >= 60) return 'border-border bg-surface text-foreground';
  return 'border-border bg-muted text-muted-foreground';
}

export function ProspectingPage(): React.JSX.Element {
  usePageTitle('客户发现');
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const currentUser = useAuthStore((state) => state.user);
  const openAgentWithPrompt = useUiStore((s) => s.openAgentWithPrompt);

  const [data, setData] = React.useState<ProspectingToday | null>(null);
  const [report, setReport] = React.useState<ProspectingReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [batch, setBatch] = React.useState<{ total: number; done: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [runOpen, setRunOpen] = React.useState(false);
  const [configOpen, setConfigOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [enrichOpen, setEnrichOpen] = React.useState(false);

  const [statusFilter, setStatusFilter] = React.useState<'all' | 'ready' | 'needs_contact' | 'low'>('all');
  const [keyword, setKeyword] = React.useState('');
  const [scoreTier, setScoreTier] = React.useState<'all' | 'high' | 'mid'>('all');
  const [countryFilter, setCountryFilter] = React.useState<string>('all');
  const [sourceFilter, setSourceFilter] = React.useState<'all' | 'web' | 'excel'>('all');
  const [inspectorTab, setInspectorTab] = React.useState<'summary' | 'profile' | 'sync'>('summary');

  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);
  const requestId = React.useRef(0);
  const resultsTopRef = React.useRef<HTMLDivElement>(null);
  const previousPage = React.useRef(page);
  const [scope, setScope] = React.useState<'mine' | 'shared' | 'team'>(isAdmin ? 'shared' : 'mine');
  const openedSharedForEmptyMine = React.useRef(false);

  const load = React.useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const offset = (page - 1) * pageSize;
      const query = `/prospecting/today?scope=${scope}&status=${statusFilter}&limit=${pageSize}&offset=${offset}`;
      const [today, summary] = await Promise.all([
        apiGet<ProspectingToday>(query),
        isAdmin ? apiGet<ProspectingReport>('/prospecting/report?days=14').catch(() => null) : Promise.resolve(null),
      ]);
      if (currentRequest !== requestId.current) return;
      setData(today);
      if (
        !isAdmin &&
        !openedSharedForEmptyMine.current &&
        today.scope === 'mine' &&
        (today.scopeTotals?.mine ?? 0) === 0 &&
        (today.scopeTotals?.shared ?? 0) > 0
      ) {
        openedSharedForEmptyMine.current = true;
        setScope('shared');
      }
      setReport(summary);
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      toast.error('加载失败', { description: toErrorMessage(error, '请稍后重试') });
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [scope, statusFilter, isAdmin, page, pageSize]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    setPage(1);
  }, [scope, statusFilter]);

  React.useEffect(() => {
    const totalPages = Math.max(1, Math.ceil((data?.openTotal ?? 0) / pageSize));
    if (!loading && page > totalPages) setPage(totalPages);
  }, [data?.openTotal, loading, page, pageSize]);

  React.useEffect(() => {
    if (previousPage.current === page) return;
    if (data?.offset !== (page - 1) * pageSize) return;
    previousPage.current = page;
    requestAnimationFrame(() => {
      resultsTopRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  }, [page, data?.offset, pageSize]);

  React.useEffect(() => {
    if (data?.run?.status !== 'running') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.run?.status, load]);

  const openRun = () => setRunOpen(true);
  const openConfig = () => setConfigOpen(true);

  const approve = async (id: string) => {
    setBusy(id);
    const hasEmail = Boolean(data?.prospects.find((item) => item.id === id)?.emails.length);
    try {
      const result = await apiPost<{
        customer: { id: string; name: string; owner?: { name?: string } };
        draftTaskId?: string;
        draftError?: string;
        duplicates?: { id: string; name: string; reason: string }[];
      }>(`/prospecting/${id}/approve`, {});
      toast.success('已转为正式客户', {
        description: [
          `负责人：${result.customer?.owner?.name || (scope === 'team' ? '原业务员' : '你')}`,
          !hasEmail
            ? '没有邮箱，已先转为客户；补上邮箱后可再生成开发信'
            : result.draftError
              ? `草稿任务未创建：${result.draftError}`
              : result.draftTaskId
                ? '三封开发信草稿正在后台依次生成，完成后在“查看草稿”里审核'
                : result.customer?.name ?? '可在客户管理里继续写开发信',
        ].join('；'),
      });
      if (result.duplicates?.length) {
        toast.warning('客户库里可能有重复', {
          description: `${result.duplicates.map((item) => `${item.name}（${item.reason}）`).join('；')}，请到客户管理核对是否同一家。`,
          duration: 12000,
        });
      }
      await load();
    } catch (error) {
      toast.error('转换失败', { description: toErrorMessage(error, '请稍后重试') });
    } finally {
      setBusy(null);
    }
  };

  const claim = async (id: string) => {
    setBusy(id);
    try {
      await apiPost(`/prospecting/${id}/claim`, {});
      toast.success('已领取到「我的线索池」', { description: '这条线索已归你负责，其他业务员不会在公共线索池再看到。' });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (scope === 'mine') await load();
      else setScope('mine');
    } catch (error) {
      toast.error('领取失败', { description: toErrorMessage(error, '可能已被其他业务员领取，请刷新') });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const release = async (id: string) => {
    setBusy(id);
    try {
      await apiPost(`/prospecting/${id}/release`, {});
      toast.success('已放回公共线索池', { description: '其他业务员现在可以领取这条线索。' });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    } catch (error) {
      toast.error('放回失败', { description: toErrorMessage(error, '请刷新后重试') });
    } finally {
      setBusy(null);
    }
  };

  const reject = async (id: string) => {
    setBusy(id);
    try {
      await apiPost(`/prospecting/${id}/reject`, { reason: '人工跳过' });
      toast.info('已跳过该线索，不再出现在待处理列表');
      await load();
    } catch (error) {
      toast.error('跳过线索失败', { description: toErrorMessage(error, '请稍后重试') });
    } finally {
      setBusy(null);
    }
  };

  const sync = async (id: string) => {
    setBusy(id);
    try {
      const result = await apiPost<{ filledFields: string[] }>('/prospecting/' + id + '/sync-customer', {});
      toast.success(result.filledFields.length ? '已补齐 ' + result.filledFields.length + ' 个空白字段' : '无需补齐，已有客户资料未改动', {
        description: '只补充空白项，不会覆盖你已填写的客户信息。',
      });
      await load();
    } catch (error) {
      toast.error('补齐客户资料失败', { description: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const refreshContact = async (id: string) => {
    setBusy(id);
    try {
      const result = await apiPost<{ filledFields: string[] }>('/prospecting/' + id + '/refresh-contact', {}, { timeout: 600000 });
      toast.success(
        result.filledFields.length ? '官网已更新并补齐 ' + result.filledFields.length + ' 个空白字段' : '官网已重新读取，未发现新的空白项可补齐',
        { description: '客户原有资料保持不变。' },
      );
      await load();
    } catch (error) {
      toast.error('重新读取官网资料失败', { description: toErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pendingTargets, setPendingTargets] = React.useState<Prospect[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelected(new Set());
  }, [scope, statusFilter]);

  const availableCountries = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data?.prospects ?? []) {
      const c = p.country?.trim();
      if (c) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [data?.prospects]);

  const filteredProspects = React.useMemo(() => {
    const list = data?.prospects ?? [];
    const q = keyword.trim().toLowerCase();
    return list.filter((item) => {
      if (scoreTier === 'high' && item.score < 80) return false;
      if (scoreTier === 'mid' && (item.score < 60 || item.score >= 80)) return false;
      if (countryFilter !== 'all' && (item.country?.trim() || '') !== countryFilter) return false;
      if (sourceFilter === 'excel' && item.source !== 'excel') return false;
      if (sourceFilter === 'web' && item.source === 'excel') return false;
      if (q) {
        const hay = [item.name, item.company, item.domain, item.country, item.industry, item.contactName, ...item.emails]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data?.prospects, keyword, scoreTier, countryFilter, sourceFilter]);

  React.useEffect(() => {
    const first = filteredProspects[0]?.id ?? null;
    setActiveId((prev) => (prev && filteredProspects.some((p) => p.id === prev) ? prev : first));
  }, [filteredProspects]);

  const activeProspect = React.useMemo(
    () => (activeId ? filteredProspects.find((p) => p.id === activeId) ?? null : null),
    [filteredProspects, activeId],
  );

  const isConvertible = React.useCallback((item: Prospect) => item.status !== 'converted' && item.status !== 'rejected', []);

  const toggleSelected = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const convertibleItems = React.useMemo(() => filteredProspects.filter(isConvertible), [filteredProspects, isConvertible]);
  const chosenItems = React.useMemo(() => convertibleItems.filter((i) => selected.has(i.id)), [convertibleItems, selected]);
  const allChosen = convertibleItems.length > 0 && chosenItems.length === convertibleItems.length;

  const triggerBatchConvert = () => {
    const chosen = chosenItems.length ? chosenItems : convertibleItems;
    if (!chosen.length) return;
    setPendingTargets(chosen);
    setConfirmOpen(true);
  };

  const approveAll = async () => {
    const targets = pendingTargets;
    setConfirmOpen(false);
    if (!targets.length) return;
    setBatch({ total: targets.length, done: 0 });
    let ok = 0;
    let okWithEmail = 0;
    let okNoEmail = 0;
    let failed = 0;
    let draftErrors = 0;
    let duplicateCount = 0;
    const failedReasons: string[] = [];
    for (const prospect of targets) {
      try {
        const result = await apiPost<{ customer?: { id: string; name: string }; duplicates?: unknown[]; draftTaskId?: string; draftError?: string }>(
          `/prospecting/${prospect.id}/approve`,
          {},
        );
        ok += 1;
        if (prospect.emails.length > 0) okWithEmail += 1;
        else okNoEmail += 1;
        if (result?.duplicates?.length) duplicateCount += 1;
        if (result?.draftError) draftErrors += 1;
      } catch (error) {
        failed += 1;
        const label = prospect.contactName || prospect.company || prospect.domain;
        failedReasons.push(`${label}：${toErrorMessage(error, '转换失败')}`);
      }
      setBatch((prev) => (prev ? { total: prev.total, done: prev.done + 1 } : prev));
    }
    setBatch(null);
    setSelected(new Set());
    setPendingTargets([]);
    await load();
    const summaryParts = [
      failed ? `跳过/失败 ${failed} 条：${failedReasons.slice(0, 3).join('；')}${failedReasons.length > 3 ? ` 等共 ${failedReasons.length} 条` : ''}` : '',
      okNoEmail ? `其中 ${okNoEmail} 位暂无邮箱，需补充邮箱后再生成开发信` : '',
      duplicateCount ? `${duplicateCount} 位与现有客户疑似重复，请在客户管理中核对` : '',
      draftErrors ? `${draftErrors} 位客户的开发信草稿未创建，可在客户页手动生成` : okWithEmail > 0 ? `有邮箱的 ${okWithEmail} 位客户将在后台准备开发信草稿` : '',
    ]
      .filter(Boolean)
      .join('；');
    if (ok === 0) {
      toast.error(`本次未转换任何客户（失败 ${failed} 条）`, { description: summaryParts || '请检查线索状态或重复记录' });
    } else if (failed > 0 || duplicateCount > 0 || draftErrors > 0) {
      toast.warning(`已转换 ${ok} 位客户，跳过/失败 ${failed} 条`, { description: summaryParts });
    } else {
      toast.success(`已转换 ${ok} 位客户`, { description: summaryParts || undefined });
    }
  };

  const resetLocalFilters = () => {
    setKeyword('');
    setScoreTier('all');
    setCountryFilter('all');
    setSourceFilter('all');
    setStatusFilter('all');
  };

  const run = data?.run;
  const counts = data?.counts;
  const totalOpen = (counts?.ready ?? 0) + (counts?.needsContact ?? 0) + (counts?.low ?? 0);

  return (
    <div className="workspace-page">
      <PageHeader
        title="客户发现工作区"
        description="寻找与当前项目匹配的海外潜在采购商 · AI 官网研究 · 个人与公共线索池严格去重 · 一键转化。"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />导入线索
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEnrichOpen(true)} title={isAdmin ? undefined : '只处理公共线索池和你自己名下的线索'}>
              <Wand2 className="h-3.5 w-3.5" aria-hidden />批量补全
            </Button>
            {isAdmin ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void openConfig()}>
                <Settings2 className="h-3.5 w-3.5" aria-hidden />搜索设置
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={() => void openRun()} disabled={run?.status === 'running'}>
              {run?.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {run?.status === 'running' ? '生成中…' : '生成今日线索'}
            </Button>
          </div>
        }
      />

      {/* Unified Trade OS Scope Switcher + Inline Telemetry Strip */}
      <div className="os-telemetry-strip grid-cols-1 lg:grid-cols-[auto_1fr]">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="os-segmented">
            {([
              { key: 'mine' as const, label: '我的线索池', count: data?.scopeTotals?.mine ?? 0 },
              { key: 'shared' as const, label: '公共线索池', count: data?.scopeTotals?.shared ?? 0 },
              ...(isAdmin ? [{ key: 'team' as const, label: '团队线索池', count: data?.scopeTotals?.team ?? 0 }] : []),
            ]).map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-pressed={scope === tab.key}
                onClick={() => {
                  setScope(tab.key);
                  setStatusFilter('all');
                }}
                className={cn('os-segmented-item', scope === tab.key && 'os-segmented-item-active')}
              >
                <span>{tab.label}</span>
                <span className="tabular-nums text-[11px] text-muted-foreground">{tab.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-border/75 sm:grid-cols-5">
          {[
            { label: '待处理总量', value: counts?.total ?? 0, sub: counts?.carriedFromEarlier ? `含往期 ${counts.carriedFromEarlier}` : '池内线索', filter: 'all' as const },
            { label: '可立即触达', value: counts?.ready ?? 0, sub: '已备邮箱', filter: 'ready' as const },
            { label: '待补决策人', value: counts?.needsContact ?? 0, sub: '官网可补查', filter: 'needs_contact' as const },
            { label: '已转化客户', value: counts?.converted ?? 0, sub: '已入正式库', filter: null },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => item.filter && setStatusFilter(item.filter)}
              className={cn(
                'flex flex-col justify-center px-3.5 py-2.5 text-left transition-colors hover:bg-surface/65',
                item.filter && statusFilter === item.filter && 'bg-surface/85',
              )}
            >
              <span className="text-[11px] font-medium text-muted-foreground">{item.label}</span>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-base font-bold tabular-nums tracking-tight text-foreground">{item.value}</span>
                <span className="truncate text-[10.5px] text-muted-foreground">{item.sub}</span>
              </div>
            </button>
          ))}

          <button
            type="button"
            onClick={() =>
              openAgentWithPrompt('请结合当前项目的行业画像与产品特点，为我推荐高潜力海外目标市场、买家类型及线索筛选策略。')
            }
            className="group col-span-2 flex items-center justify-between gap-2 bg-surface/40 px-3.5 py-2.5 text-left transition-colors hover:bg-surface sm:col-span-1"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                <Sparkles className="h-3 w-3 shrink-0" aria-hidden />AI 拓客策略
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                {(counts?.ready ?? 0) > 0 ? `优先转化 ${counts?.ready} 条含邮箱线索` : '生成目标市场搜索词'}
              </p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
          </button>
        </div>
      </div>

      {run ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-xs',
            run.status === 'failed'
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : run.status === 'running'
                ? 'border-amber-300/60 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                : 'border-border bg-surface text-foreground',
          )}
        >
          {run.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          <span>
            本轮{run.profileName ? `（${run.profileName}）` : ''}：检索 {run.imported} 家网站 · 去重 {run.deduped} · 补全 {run.enriched} · 找到邮箱 {run.hunterFound} · 入选 {run.selected}
          </span>
          {run.error ? <span>{run.error}</span> : null}
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void load()}>
              <RefreshCw className="h-3 w-3" aria-hidden />刷新
            </Button>
          </div>
        </div>
      ) : null}

      {/* ====================================================================
         TRUE 3-PANE VIEWPORT-ALIGNED PROSPECT RESEARCH WORKBENCH
         ==================================================================== */}
      <div
        ref={resultsTopRef}
        className="grid gap-4 lg:grid-cols-[224px_320px_minmax(0,1fr)] xl:h-[calc(100dvh-14.25rem)] xl:min-h-[610px] xl:grid-cols-[236px_348px_minmax(0,1fr)] xl:items-stretch"
      >
        {/* PANE 1: Left Structured Filter Rail */}
        <aside aria-label="线索筛选条件" className="panel space-y-4 p-4 xl:flex xl:h-full xl:flex-col xl:overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-foreground">筛选条件</h2>
            <button
              type="button"
              onClick={resetLocalFilters}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              重置
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索公司、域名、邮箱…"
              className="h-8 pl-8 text-xs"
            />
          </div>

          <div className="space-y-1 border-t border-border/75 pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground">处理状态</p>
            {([
              { key: 'all' as const, label: '全部待处理', count: totalOpen },
              { key: 'ready' as const, label: '可以发送', count: counts?.ready ?? 0 },
              { key: 'needs_contact' as const, label: '待补联系方式', count: counts?.needsContact ?? 0 },
              ...((counts?.low ?? 0) > 0 ? [{ key: 'low' as const, label: '低优先', count: counts?.low ?? 0 }] : []),
            ]).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setStatusFilter(opt.key)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  statusFilter === opt.key
                    ? 'border-foreground/25 bg-foreground/[0.065] font-semibold text-foreground'
                    : 'border-transparent text-foreground/80 hover:bg-surface',
                )}
              >
                <span>{opt.label}</span>
                <span className="tabular-nums text-[11px] text-muted-foreground">
                  {opt.count}
                </span>
              </button>
            ))}
          </div>

          <div className="space-y-1 border-t border-border/75 pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground">匹配度分层</p>
            {([
              ['all', '全部评分'],
              ['high', '高潜力（≥ 80 分）'],
              ['mid', '匹配（60 – 79 分）'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setScoreTier(key)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  scoreTier === key ? 'bg-surface font-semibold text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-surface hover:text-foreground',
                )}
              >
                <span>{label}</span>
                {scoreTier === key ? <Check className="h-3 w-3" aria-hidden /> : null}
              </button>
            ))}
          </div>

          {availableCountries.length > 0 ? (
            <div className="space-y-2 border-t border-border/75 pt-3">
              <p className="text-[11px] font-semibold text-muted-foreground">目标市场</p>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setCountryFilter('all')}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                    countryFilter === 'all' ? 'os-pill-active' : 'border-border bg-surface text-muted-foreground hover:text-foreground',
                  )}
                >
                  全部
                </button>
                {availableCountries.map(([country, cnt]) => (
                  <button
                    key={country}
                    type="button"
                    onClick={() => setCountryFilter(country === countryFilter ? 'all' : country)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                      countryFilter === country ? 'os-pill-active' : 'border-border bg-card text-foreground hover:bg-surface',
                    )}
                  >
                    <CountryFlag value={country} />
                    <span>{countryInfo(country)?.name ?? country}</span>
                    <span className="opacity-70">{cnt}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-1 border-t border-border/75 pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground">数据来源</p>
            {([
              ['all', '全部来源'],
              ['web', '智能官网检索'],
              ['excel', 'Excel 名单导入'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSourceFilter(key)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  sourceFilter === key ? 'bg-surface font-semibold text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-surface hover:text-foreground',
                )}
              >
                <span>{label}</span>
                {sourceFilter === key ? <Check className="h-3 w-3" aria-hidden /> : null}
              </button>
            ))}
          </div>

          <div className="mt-auto border-t border-border/75 pt-3">
            <Button type="button" className="w-full text-xs" size="sm" onClick={() => void openRun()} disabled={run?.status === 'running'}>
              {run?.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              生成今日线索
            </Button>
          </div>
        </aside>

        {/* PANE 2: Center High-Density Prospect Stream */}
        <section aria-label="线索列表" className="panel flex flex-col overflow-hidden xl:h-full">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3.5 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[0.875rem] font-semibold text-foreground">
                线索结果
              </h2>
              <span className="chip chip-muted tabular-nums">{filteredProspects.length}</span>
            </div>

            {convertibleItems.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (allChosen) convertibleItems.forEach((i) => next.delete(i.id));
                      else convertibleItems.forEach((i) => next.add(i.id));
                      return next;
                    })
                  }
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  {allChosen ? '取消全选' : '全选'}
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 border-foreground/25 bg-surface/80 px-2.5 text-[11px] font-semibold hover:bg-card"
                  disabled={Boolean(batch)}
                  onClick={triggerBatchConvert}
                >
                  {batch ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  {batch ? `${batch.done}/${batch.total}` : chosenItems.length ? `转化 (${chosenItems.length})` : `一键转化 (${convertibleItems.length})`}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="max-h-[680px] divide-y divide-border/75 overflow-y-auto xl:max-h-none xl:min-h-0 xl:flex-1">
            {loading ? (
              <p className="py-16 text-center text-xs text-muted-foreground">正在加载线索池…</p>
            ) : filteredProspects.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">
                  <Target className="h-5 w-5" aria-hidden />
                </span>
                <p className="mt-3 text-sm font-semibold text-foreground">
                  {data?.prospects.length ? '没有匹配筛选条件的线索' : scope === 'mine' ? '我的线索池暂无待处理线索' : '公共线索池暂无待领取线索'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {data?.prospects.length
                    ? '可清空左侧筛选条件查看全部线索。'
                    : '点击右上角「生成今日线索」自动检索目标买家，或通过 Excel 批量导入企业名单。'}
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {data?.prospects.length ? (
                    <Button size="sm" variant="outline" onClick={resetLocalFilters}>清空筛选</Button>
                  ) : (
                    <>
                      {scope === 'mine' && (data?.scopeTotals?.shared ?? 0) > 0 ? (
                        <Button size="sm" onClick={() => setScope('shared')}>
                          去公共线索池（{data?.scopeTotals?.shared ?? 0}）
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>导入 Excel</Button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              filteredProspects.map((prospect) => {
                const isActive = activeProspect?.id === prospect.id;
                const isSelected = selected.has(prospect.id);
                const canSelect = isConvertible(prospect);
                const displayTitle = prospect.name || prospect.company || prospect.domain;
                return (
                  <div
                    key={prospect.id}
                    onClick={() => setActiveId(prospect.id)}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 px-3.5 py-3 transition-colors',
                      isActive ? 'bg-surface ring-inset ring-1 ring-foreground/15' : 'hover:bg-surface/60',
                    )}
                  >
                    {canSelect ? (
                      <div onClick={(e) => e.stopPropagation()} className="pt-1">
                        <Checkbox
                          checked={isSelected}
                          disabled={busy === prospect.id || Boolean(batch)}
                          onCheckedChange={() => toggleSelected(prospect.id)}
                          aria-label={`选择 ${displayTitle}`}
                        />
                      </div>
                    ) : null}

                    <span className="avatar-bubble mt-0.5 flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg border border-border/80 text-xs font-semibold">
                      {initials(displayTitle)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-[0.8125rem] font-semibold text-foreground">{displayTitle}</p>
                        <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums', scoreBadgeClass(prospect.score))}>
                          {prospect.score}
                        </span>
                      </div>

                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        {prospect.country ? <CountryFlag value={prospect.country} /> : null}
                        <span className="truncate">
                          {[
                            prospect.industry,
                            prospect.country ? countryInfo(prospect.country)?.name ?? prospect.country : '',
                            prospect.domain,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {prospect.score >= 80 ? <span className="chip chip-amber">高潜力</span> : null}
                        {prospect.emails.length > 0 ? (
                          <span className="chip chip-mint">有邮箱</span>
                        ) : (
                          <span className="chip chip-muted">待补邮箱</span>
                        )}
                        {prospect.status === 'converted' ? <span className="chip chip-violet">已转客户</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {data && (data.openTotal ?? 0) > pageSize ? (
            <div className="border-t border-border px-2 py-1.5">
              <DataPagination
                page={page}
                limit={pageSize}
                total={data.openTotal ?? 0}
                totalPages={Math.max(1, Math.ceil((data.openTotal ?? 0) / pageSize))}
                onPageChange={setPage}
                onLimitChange={(next) => {
                  setPageSize(next);
                  setPage(1);
                }}
                disabled={loading || Boolean(batch)}
              />
            </div>
          ) : null}
        </section>

        {/* PANE 3: Right Deep Research & Conversion Workspace */}
        <section aria-label="线索深度研究工作区" className="panel min-w-0 p-5 xl:flex xl:h-full xl:flex-col xl:overflow-y-auto">
          {activeProspect ? (
            <div className="flex flex-1 flex-col space-y-4">
              {/* Top Company Identity Header */}
              <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3.5">
                  <span className="avatar-bubble flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border text-sm font-bold">
                    {initials(activeProspect.name || activeProspect.company || activeProspect.domain)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-foreground">
                        {activeProspect.name || activeProspect.company || activeProspect.domain}
                      </h2>
                      <span className={cn('rounded-md border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums', scoreBadgeClass(activeProspect.score))}>
                        匹配度 {activeProspect.score}
                      </span>
                      {activeProspect.aiScore !== undefined ? <Badge variant="outline">AI 评分 {activeProspect.aiScore}</Badge> : null}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {activeProspect.industry ? <span>{activeProspect.industry}</span> : null}
                      {activeProspect.country ? (
                        <span className="inline-flex items-center gap-1">
                          <CountryFlag value={activeProspect.country} />
                          {countryInfo(activeProspect.country)?.name ?? activeProspect.country}
                        </span>
                      ) : null}
                      {activeProspect.website ? (
                        <a
                          href={activeProspect.website}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                        >
                          <Globe2 className="h-3.5 w-3.5" aria-hidden />
                          {activeProspect.domain}
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      ) : (
                        <span>{activeProspect.domain}</span>
                      )}
                      {activeProspect.instagram ? (
                        <a
                          href={socialHref(activeProspect.instagram, 'instagram.com')}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          <Instagram className="h-3.5 w-3.5" aria-hidden />Instagram
                        </a>
                      ) : null}
                      {activeProspect.linkedin ? (
                        <a
                          href={socialHref(activeProspect.linkedin, 'linkedin.com', 'company/')}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          <Linkedin className="h-3.5 w-3.5" aria-hidden />LinkedIn
                        </a>
                      ) : null}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant="secondary">
                        {activeProspect.ownerId === currentUser?.id
                          ? '我的线索'
                          : activeProspect.ownerId
                            ? activeProspect.ownerName || '同事跟进'
                            : '公共线索'}
                      </Badge>
                      {activeProspect.source === 'excel' ? <Badge variant="outline">Excel 导入</Badge> : <Badge variant="outline">官网检索</Badge>}
                      {activeProspect.emails.map((em) => (
                        <a key={em} href={`mailto:${em}`} className="chip chip-mint hover:underline">
                          <AtSign className="h-3 w-3" aria-hidden />{em}
                        </a>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Top Right Secondary Actions */}
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {activeProspect.status !== 'converted' ? (
                    <>
                      {scope === 'shared' && !activeProspect.ownerId ? (
                        <Button size="sm" variant="outline" disabled={busy === activeProspect.id} onClick={() => void claim(activeProspect.id)}>
                          <UserPlus className="h-3.5 w-3.5" aria-hidden />领取
                        </Button>
                      ) : null}
                      {scope === 'mine' && activeProspect.ownerId ? (
                        <Button size="sm" variant="outline" disabled={busy === activeProspect.id} onClick={() => void release(activeProspect.id)}>
                          <UserMinus className="h-3.5 w-3.5" aria-hidden />放回公海
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" disabled={busy === activeProspect.id} onClick={() => void reject(activeProspect.id)}>
                        <X className="h-3.5 w-3.5" aria-hidden />跳过
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Sub-Navigation Tabs */}
              <div className="flex items-center gap-5 border-b border-border text-xs">
                {([
                  ['summary', '研究摘要与开发建议'],
                  ['profile', '公司与联系人资料'],
                  ['sync', '官网采集与同步'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setInspectorTab(key)}
                    className={cn(
                      '-mb-px border-b-2 pb-2.5 font-medium transition-colors',
                      inspectorTab === key ? 'border-foreground font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {inspectorTab === 'summary' ? (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                  {/* Left: AI Research Summary */}
                  <div className="well space-y-3 p-4">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      AI 研究摘要
                    </div>
                    <p className="whitespace-pre-line text-xs leading-relaxed text-foreground/85">
                      {activeProspect.notes || activeProspect.excerpt || activeProspect.snippet || '该线索来自域名与公开目录匹配，建议点击右侧重新采集官网资料以补充产品定位详情。'}
                    </p>

                    {activeProspect.reasons.length > 0 ? (
                      <div className="border-t border-border/75 pt-3">
                        <p className="text-[11px] font-semibold text-muted-foreground">匹配与评分依据</p>
                        <ul className="mt-2 space-y-1.5 text-xs text-foreground/90">
                          {activeProspect.reasons.map((reason) => (
                            <li key={reason} className="flex items-start gap-2">
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mint" aria-hidden />
                              <span>{reason}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  {/* Right: AI Outreach Action Stack */}
                  <div className="well flex flex-col justify-between space-y-3 p-4">
                    <div className="space-y-2.5">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                        AI 开发建议
                      </p>

                      <button
                        type="button"
                        onClick={() =>
                          openAgentWithPrompt(
                            `请结合项目产品卖点，针对潜在客户 ${activeProspect.company || activeProspect.domain}（${activeProspect.country || ''} ${activeProspect.industry || ''}）给出首封开发信切入角度与话术建议。`,
                          )
                        }
                        className="group flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-left text-xs transition-colors hover:border-foreground/25"
                      >
                        <div>
                          <p className="font-semibold text-foreground">定制首封切入角度</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">基于品牌调性与行业痛点生成话术</p>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          openAgentWithPrompt(
                            `请从当前项目已发布的产品目录中，挑选最适合推荐给 ${activeProspect.company || activeProspect.domain}（${activeProspect.industry || '目标买家'}）的主打规格与 MOQ 方案。`,
                          )
                        }
                        className="group flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-left text-xs transition-colors hover:border-foreground/25"
                      >
                        <div>
                          <p className="font-semibold text-foreground">推荐匹配产品与阶梯价</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">对照项目知识库匹配主推款式</p>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                      </button>
                    </div>

                    <div className="space-y-2 border-t border-border/75 pt-3">
                      {activeProspect.status === 'converted' && activeProspect.customerId ? (
                        <div className="flex flex-wrap gap-2">
                          <Button className="flex-1 text-xs" onClick={() => window.location.assign(`/customers/${activeProspect.customerId}`)}>
                            <ExternalLink className="h-3.5 w-3.5" />查看正式客户档案
                          </Button>
                          {activeProspect.draftTaskId ? (
                            <Button
                              variant="outline"
                              className="text-xs"
                              onClick={() => window.location.assign(`/customers/${activeProspect.customerId}?outreachTask=${activeProspect.draftTaskId}`)}
                            >
                              审核草稿
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <Button
                          className="w-full text-xs"
                          disabled={busy === activeProspect.id || Boolean(batch)}
                          onClick={() => void approve(activeProspect.id)}
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden />
                          转为客户并准备开发信
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Bottom Full-Span Trade OS Dossier & Execution Rhythm Strip (Fills Right Studio Naturally) */}
                  <div className="xl:col-span-2 grid gap-3 rounded-xl border border-border/80 bg-surface/45 p-4 sm:grid-cols-2">
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground">企业触达通道与关键字段</span>
                        <button
                          type="button"
                          onClick={() => setInspectorTab('profile')}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          完整档案 →
                        </button>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
                        <div>
                          <dt className="text-muted-foreground">主域名</dt>
                          <dd className="truncate font-medium text-foreground">{activeProspect.domain || '—'}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">决策人 / 职位</dt>
                          <dd className="truncate font-medium text-foreground">
                            {activeProspect.contactName
                              ? `${activeProspect.contactName}${activeProspect.contactTitle ? ` · ${activeProspect.contactTitle}` : ''}`
                              : '待采集'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">验证邮箱</dt>
                          <dd className="truncate font-medium text-foreground">{activeProspect.emails[0] || '待补全'}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">社媒 / 电话</dt>
                          <dd className="truncate font-medium text-foreground">
                            {[
                              activeProspect.phone,
                              activeProspect.whatsapp ? 'WhatsApp' : '',
                              activeProspect.linkedin ? 'LinkedIn' : '',
                              activeProspect.instagram ? 'Instagram' : '',
                            ]
                              .filter(Boolean)
                              .join(' · ') || '未公开'}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="space-y-2 border-t border-border/70 pt-3 text-xs sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                      <span className="font-semibold text-foreground">Trade OS 转化后自动推进链路</span>
                      <ol className="space-y-1.5 text-[11.5px] text-muted-foreground">
                        <li className="flex items-center gap-2">
                          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[10px] font-semibold text-foreground ring-1 ring-border">1</span>
                          <span>自动去重写入当前项目客户库，保留原始发现来源</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[10px] font-semibold text-foreground ring-1 ring-border">2</span>
                          <span>联动本项目知识库与对外口径，起草个性化开发信</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[10px] font-semibold text-foreground ring-1 ring-border">3</span>
                          <span>进入待审核草稿池，由业务员确认后发送或排入跟进序列</span>
                        </li>
                      </ol>
                    </div>
                  </div>
                </div>
              ) : inspectorTab === 'profile' ? (
                <div className="well p-4">
                  <dl className="grid gap-x-6 gap-y-3.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ['公司名称', activeProspect.company],
                      ['联系人', activeProspect.contactName],
                      ['职位', activeProspect.contactTitle],
                      ['联系邮箱', activeProspect.emails.join(', ')],
                      ['联系电话', activeProspect.phone],
                      ['国家 / 地区', activeProspect.country],
                      ['所属行业', activeProspect.industry],
                      ['详细地址', activeProspect.address],
                      ['WhatsApp', activeProspect.whatsapp],
                      ['Instagram', activeProspect.instagram],
                      ['LinkedIn', activeProspect.linkedin],
                      ['Facebook', activeProspect.facebook],
                    ].map(([label, val]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-[11px] text-muted-foreground">{label}</dt>
                        <dd className="mt-0.5 break-words font-medium text-foreground">{val || '未采集'}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 border-t border-border/75 pt-3 text-[11px] text-muted-foreground">
                    转化后以上字段将原样写入客户档案；查不到的字段保持空白，系统绝不编造采购需求。
                  </p>
                </div>
              ) : (
                <div className="well space-y-3 p-4 text-xs">
                  <p className="font-semibold text-foreground">官网深度重采与客户资料同步</p>
                  <p className="text-muted-foreground">
                    最多读取该企业官网 3 个公开页面补齐空白联系方式与简介；已人工填写的客户字段不会被覆盖。
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {isAdmin ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === activeProspect.id}
                        onClick={() => void refreshContact(activeProspect.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {busy === activeProspect.id ? '正在采集…' : '重新采集官网资料'}
                      </Button>
                    ) : null}
                    {activeProspect.status === 'converted' ? (
                      <Button size="sm" variant="outline" disabled={busy === activeProspect.id} onClick={() => void sync(activeProspect.id)}>
                        补齐已获取资料到客户档案
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-h-[380px] flex-col justify-between">
              <div>
                <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  PROSPECT DISCOVERY PIPELINE
                </p>
                <h3 className="mt-1.5 text-base font-semibold text-foreground">AI 潜客发现与深度研究工作台</h3>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  在左侧配置目标市场或导入企业名单后，点选任意一条线索即可在此查看官网摘要、匹配评分依据、决策人邮箱并一键转化为正式客户。
                </p>

                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {[
                    { step: '01', title: '定义买家画像', desc: '设置目标国家、行业关键词与排除规则，精准锁定海外采购商。' },
                    { step: '02', title: '官网抓取与邮箱补全', desc: '自动读取企业官网定位并匹配决策人邮箱，区分高潜与待补全线索。' },
                    { step: '03', title: '一键转化并生成草稿', desc: '转为正式客户后自动在后台准备 3 封个性化开发信待审草稿。' },
                  ].map((item) => (
                    <div key={item.step} className="well p-3.5">
                      <span className="font-mono text-[11px] font-semibold text-muted-foreground">{item.step}</span>
                      <p className="mt-1 text-xs font-semibold text-foreground">{item.title}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                <Button size="sm" onClick={() => void openRun()} disabled={run?.status === 'running'}>
                  <Play className="h-3.5 w-3.5" />生成今日线索
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                  <FileSpreadsheet className="h-3.5 w-3.5" />导入 Excel 名单
                </Button>
                {isAdmin ? (
                  <Button size="sm" variant="outline" onClick={() => void openConfig()}>
                    <Settings2 className="h-3.5 w-3.5" />配置搜索画像
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openAgentWithPrompt('请结合当前项目知识库，建议几组高转化海外采购商搜索关键词。')}
                >
                  <BookOpen className="h-3.5 w-3.5" />AI 推荐搜索词
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Admin 14-Day Run Report */}
      {isAdmin && report && report.runs.length ? (
        <details className="panel group p-4">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-xs">
            <div>
              <span className="font-semibold text-foreground">近 {report.days} 天自动发现运行记录</span>
              <span className="ml-2 text-muted-foreground">
                {report.sinceDay} 至 {report.today}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                ['线索', report.totals.candidates],
                ['可发', report.totals.ready],
                ['已转', report.totals.converted],
                ['发出', report.totals.sent],
                ['回复', report.totals.replies],
              ].map(([label, value]) => (
                <Badge key={String(label)} variant="outline">
                  {label} {value}
                </Badge>
              ))}
            </div>
          </summary>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="bg-surface text-muted-foreground">
                <tr>
                  {['日期', '状态', '搜索', '去重', '补全', 'Hunter', '入选', '失败'].map((title) => (
                    <th key={title} className="px-3 py-2 text-left font-medium">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.runs.slice(0, 10).map((entry) => (
                  <tr key={entry.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">{entry.day.slice(5)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={entry.status === 'failed' ? 'failed' : entry.status === 'running' ? 'muted' : 'developed'}>
                        {entry.status === 'completed' ? '完成' : entry.status === 'partial' ? '部分完成' : entry.status === 'running' ? '运行中' : '失败'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{entry.imported}</td>
                    <td className="px-3 py-2 tabular-nums">{entry.deduped}</td>
                    <td className="px-3 py-2 tabular-nums">{entry.enriched}</td>
                    <td className="px-3 py-2 tabular-nums">{entry.hunterFound}</td>
                    <td className="px-3 py-2 tabular-nums">{entry.selected}</td>
                    <td className="px-3 py-2 tabular-nums">{entry.failed.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} entry="prospecting" onImported={() => void load()} />
      <EnrichDialog open={enrichOpen} onOpenChange={setEnrichOpen} onCompleted={() => void load()} />
      <ProspectingRunDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        personal={!isAdmin}
        onCompleted={() => {
          if (!isAdmin) setScope('mine');
          void load();
        }}
      />
      <ProspectingSettingsDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        onCompleted={() => {
          toast.success('搜索方案已保存');
          void load();
        }}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>一键转为客户？</AlertDialogTitle>
            <AlertDialogDescription>
              将把 {pendingTargets.length} 个线索转为正式客户，有邮箱的会创建三封开发信草稿（不会直接发送邮件）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void approveAll()}>确认转换</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
