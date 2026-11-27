/**
 * 开发信模板中心（3-Pane Template Studio）
 * ------------------------------------------------------------------
 * 升级为三栏专业工作台：
 *  - 左栏：搜索 + 可滚动场景模板目录
 *  - 中栏：常驻模板预览 / 行内编辑 Studio（高亮 {{变量}} 胶囊 + AI 文案快捷调优）
 *  - 右栏：可点击插入/复制的「模板变量」清单、「模板信息」与真实「效果评估」
 * 完整保留新建/弹窗富文本编辑/复制/AI建议副本/删除与全部统计窗口。
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  FilePlus2,
  FilterX,
  Info,
  Mail,
  Pencil,
  Save,
  Sparkles,
  Tag,
  Target,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { SearchInput } from '@/components/common/search-input';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorState, InlineLoader, NoResultState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LetterEditor, type LetterEditorHandle } from '@/components/letters/letter-editor';
import { TemplateFormDialog } from '@/components/templates/template-form-dialog';
import { TemplateSuggestionDialog } from '@/components/templates/template-suggestion-dialog';
import { apiGet, toErrorMessage } from '@/lib/api';
import { copyToClipboard, formatDateTime, formatRelative, htmlToPlainText } from '@/lib/format';
import { useProjectStore } from '@/store/project.store';
import { selectCompany, selectPlaceholderDefs, useMetaStore } from '@/store/meta.store';
import { usePageTitle } from '@/hooks/use-ui';
import { useTemplateStore } from '@/store/template.store';
import { useUiStore } from '@/store/ui.store';
import {
  TEMPLATE_CATEGORY_FILTER_OPTIONS,
  TEMPLATE_CATEGORY_LABEL,
  TEMPLATE_CATEGORY_OPTIONS,
} from '@/constants';
import type {
  LetterTemplate,
  TemplateCategory,
  TemplatePerformanceStage,
  TemplatePerformanceSummary,
} from '@/types';

const STAGES: { key: TemplatePerformanceStage; label: string }[] = [
  { key: 'replied', label: '回复' },
  { key: 'interested', label: '意向' },
  { key: 'quoted', label: '报价' },
  { key: 'won', label: '成交' },
  { key: 'unsubscribed', label: '退订' },
  { key: 'bounced', label: '退信' },
];

const ALL = 'all';

const TOKEN_SPLIT_REGEX = /(\{\{[a-zA-Z0-9_]+\}\})/g;
const TOKEN_MATCH_REGEX = /^\{\{[a-zA-Z0-9_]+\}\}$/;

/** 将含 {{token}} 的文本渲染为精致胶囊高亮 */
function HighlightedTemplateText({ text }: { text: string }): React.JSX.Element {
  if (!text) return <span className="text-muted-foreground">（未填写）</span>;
  const parts = text.split(TOKEN_SPLIT_REGEX);
  return (
    <>
      {parts.map((part, idx) =>
        TOKEN_MATCH_REGEX.test(part) ? (
          <span
            key={idx}
            className="mx-0.5 inline-flex items-center rounded border border-foreground/20 bg-surface px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-foreground"
          >
            {part}
          </span>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

export function TemplatesPage(): React.JSX.Element {
  usePageTitle('模板中心');

  const items = useTemplateStore((state) => state.items);
  const loading = useTemplateStore((state) => state.loading);
  const mutating = useTemplateStore((state) => state.mutating);
  const error = useTemplateStore((state) => state.error);
  const category = useTemplateStore((state) => state.category);
  const keyword = useTemplateStore((state) => state.keyword);
  const setFilters = useTemplateStore((state) => state.setFilters);
  const resetFilters = useTemplateStore((state) => state.resetFilters);
  const visibleItems = useTemplateStore((state) => state.visibleItems);
  const fetchList = useTemplateStore((state) => state.fetchList);
  const updateTemplate = useTemplateStore((state) => state.updateTemplate);
  const duplicateTemplate = useTemplateStore((state) => state.duplicateTemplate);
  const deleteTemplate = useTemplateStore((state) => state.deleteTemplate);

  const activeProject = useProjectStore((state) => state.activeProject);
  const projectId = activeProject?.id;
  const placeholderDefs = useMetaStore(selectPlaceholderDefs);
  const company = useMetaStore(selectCompany);
  const openAgentWithPrompt = useUiStore((state) => state.openAgentWithPrompt);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [inlineEditing, setInlineEditing] = React.useState(false);
  const [draftName, setDraftName] = React.useState('');
  const [draftCategory, setDraftCategory] = React.useState<TemplateCategory>('first_contact');
  const [draftSubject, setDraftSubject] = React.useState('');
  const [draftContent, setDraftContent] = React.useState('');
  const inlineEditorRef = React.useRef<LetterEditorHandle | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<LetterTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<LetterTemplate | null>(null);
  const [suggestTarget, setSuggestTarget] = React.useState<LetterTemplate | null>(null);
  const [windowDays, setWindowDays] = React.useState<30 | 90 | 180>(30);
  const [performance, setPerformance] = React.useState<TemplatePerformanceSummary | null>(null);
  const [performanceError, setPerformanceError] = React.useState<string | null>(null);
  const [performanceLoading, setPerformanceLoading] = React.useState(false);
  const [refreshVersion, setRefreshVersion] = React.useState(0);

  React.useEffect(() => {
    setSuggestTarget(null);
    setPerformance(null);
    setInlineEditing(false);
    if (projectId) void fetchList();
  }, [fetchList, projectId]);

  React.useEffect(() => {
    if (!projectId) return;
    let active = true;
    setPerformance(null);
    setPerformanceError(null);
    setPerformanceLoading(true);
    void apiGet<TemplatePerformanceSummary>(`/templates/performance?windowDays=${windowDays}`)
      .then((response) => {
        if (active) setPerformance(response);
      })
      .catch((caught: unknown) => {
        if (active) setPerformanceError(toErrorMessage(caught, '模板效果加载失败'));
      })
      .finally(() => {
        if (active) setPerformanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, windowDays, refreshVersion]);

  const templates = React.useMemo(() => visibleItems(), [visibleItems, items, category, keyword]);
  const hasFilters = category !== ALL || keyword.trim() !== '';

  React.useEffect(() => {
    if (templates.length === 0) {
      setSelectedId(null);
      setInlineEditing(false);
      return;
    }
    if (!selectedId || !templates.some((item) => item.id === selectedId)) {
      setSelectedId(templates[0].id);
      setInlineEditing(false);
    }
  }, [templates, selectedId]);

  const activeTemplate = React.useMemo(
    () => templates.find((item) => item.id === selectedId) ?? templates[0] ?? null,
    [templates, selectedId],
  );

  const startInlineEdit = React.useCallback((template: LetterTemplate) => {
    setDraftName(template.name);
    setDraftCategory(template.category);
    setDraftSubject(template.subject);
    setDraftContent(template.content);
    setInlineEditing(true);
  }, []);

  const saveInlineEdit = React.useCallback(async () => {
    if (!activeTemplate) return;
    if (!draftName.trim() || !draftSubject.trim()) {
      toast.warning('请填写模板名称与邮件主题');
      return;
    }
    try {
      await updateTemplate(activeTemplate.id, {
        name: draftName.trim(),
        category: draftCategory,
        subject: draftSubject.trim(),
        content: draftContent,
      });
      toast.success('模板修改已保存');
      setInlineEditing(false);
    } catch (caught) {
      toast.error('保存失败', { description: toErrorMessage(caught, '请检查输入后重试') });
    }
  }, [activeTemplate, draftName, draftCategory, draftSubject, draftContent, updateTemplate]);

  const openCreate = React.useCallback(() => {
    setEditTarget(null);
    setDialogOpen(true);
  }, []);

  const openEdit = React.useCallback((template: LetterTemplate) => {
    setEditTarget(template);
    setDialogOpen(true);
  }, []);

  const handleDuplicate = React.useCallback(
    async (template: LetterTemplate) => {
      try {
        const copy = await duplicateTemplate(template.id);
        if (copy) {
          setSelectedId(copy.id);
          toast.success('模板已复制', { description: copy.name });
        }
      } catch (caught) {
        toast.error('复制失败', { description: caught instanceof Error ? caught.message : String(caught) });
      }
    },
    [duplicateTemplate],
  );

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteTemplate(deleteTarget.id);
      toast.success('模板已删除', { description: deleteTarget.name });
      setDeleteTarget(null);
      setInlineEditing(false);
    } catch (caught) {
      toast.error('删除失败', { description: caught instanceof Error ? caught.message : String(caught) });
    }
  }, [deleteTarget, deleteTemplate]);

  const handleVariableAction = React.useCallback(
    async (token: string) => {
      if (inlineEditing && inlineEditorRef.current) {
        inlineEditorRef.current.insertAtCursor(token);
        toast.success(`已插入变量 ${token}`);
        return;
      }
      const ok = await copyToClipboard(token);
      if (ok) toast.success(`已复制变量 ${token}`, { description: '可在主题或正文中直接粘贴' });
    },
    [inlineEditing],
  );

  const activePlainBody = React.useMemo(() => {
    if (!activeTemplate) return '';
    return htmlToPlainText(activeTemplate.content).trim();
  }, [activeTemplate]);

  const activeTokenCount = React.useMemo(() => {
    if (!activeTemplate) return 0;
    const matches = `${activeTemplate.subject} ${activePlainBody}`.match(/\{\{[a-zA-Z0-9_]+\}\}/g);
    return matches ? new Set(matches).size : 0;
  }, [activeTemplate, activePlainBody]);

  const activePerfEntry = React.useMemo(() => {
    if (!activeTemplate || !performance) return null;
    return performance.templates.find((entry) => entry.templateId === activeTemplate.id) ?? null;
  }, [activeTemplate, performance]);

  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const brandSignatureName = activeProject?.companyName || company?.name || activeProject?.name || '';
  const brandSignatureSub = activeProject?.website || company?.website || '';

  return (
    <div className="workspace-page">
      <PageHeader
        title="模板中心"
        description={
          items.length > 0 ? (
            <>
              按外贸销售场景组织、预览、编辑并持续迭代模板，共{' '}
              <span className="font-semibold text-foreground tabular-nums">{items.length}</span> 个模板
              {hasFilters ? `，当前筛选显示 ${templates.length} 个` : ''}
            </>
          ) : (
            '按外贸销售场景组织、预览、编辑并持续迭代开发信模板，支持客户与项目变量一键代入'
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
            <Button type="button" size="sm" onClick={openCreate}>
              <FilePlus2 className="h-4 w-4" aria-hidden />
              新建模板
            </Button>
          </>
        }
      />

      {/* Quick Category Underline Tabs */}
      <nav aria-label="模板分类切换" className="flex flex-wrap items-center gap-5 border-b border-border">
        {TEMPLATE_CATEGORY_FILTER_OPTIONS.map((option) => {
          const count = categoryCounts[option.value] ?? 0;
          const isActive = category === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilters({ category: option.value as TemplateCategory | 'all' })}
              className={`-mb-px inline-flex h-10 items-center border-b-2 px-1 text-[0.8125rem] font-medium transition-colors ${
                isActive
                  ? 'border-foreground font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.value === 'all' ? '全部' : option.label}
              {count > 0 ? (
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10.5px] tabular-nums ${
                    isActive
                      ? 'border border-border bg-surface font-semibold text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* ---------------------------- 主工作区 ---------------------------- */}

      {loading && items.length === 0 ? (
        <InlineLoader label="正在加载模板…" />
      ) : error && items.length === 0 ? (
        <ErrorState title="模板加载失败" description={error} onRetry={() => void fetchList()} retrying={loading} />
      ) : items.length === 0 ? (
        <EmptyState
          title="还没有开发信模板"
          description="把常用的首次开发、报价跟进、样品跟进存成标准模板，发信时可一键代入客户变量。"
          action={
            <Button type="button" size="sm" onClick={openCreate}>
              <FilePlus2 className="h-4 w-4" aria-hidden />
              新建模板
            </Button>
          }
        />
      ) : (
        <section
          aria-label="开发信模板列表"
          className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_280px] xl:items-stretch"
        >
          {/* 左栏：搜索 + 场景模板目录 */}
          <div className="flex flex-col rounded-xl border border-border bg-card p-3 shadow-xs">
            <div className="mb-2.5 flex items-center gap-2">
              <SearchInput
                value={keyword}
                onChange={(value) => setFilters({ keyword: value })}
                placeholder="搜索模板名称…"
                className="w-full"
                aria-label="搜索模板"
              />
            </div>

            {templates.length === 0 ? (
              <div className="py-8">
                <NoResultState
                  title="无匹配模板"
                  description="换个关键词或清空筛选"
                  action={
                    <Button type="button" size="sm" variant="outline" onClick={resetFilters}>
                      清空筛选
                    </Button>
                  }
                />
              </div>
            ) : (
              <ul className="max-h-[620px] space-y-1.5 overflow-y-auto pr-0.5">
                {templates.map((item) => {
                  const active = activeTemplate?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(item.id);
                          setInlineEditing(false);
                        }}
                        className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                          active
                            ? 'border-foreground/75 bg-surface/90 shadow-xs'
                            : 'border-border/60 bg-card hover:border-border hover:bg-surface/50'
                        }`}
                      >
                        <span
                          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                            active
                              ? 'border-foreground bg-foreground text-background'
                              : 'border-border/80 bg-surface text-muted-foreground group-hover:text-foreground'
                          }`}
                        >
                          <Mail className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[0.8125rem] font-semibold text-foreground">{item.name}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {TEMPLATE_CATEGORY_LABEL[item.category]} · {formatRelative(item.updatedAt)}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 中栏：模板预览 / 行内编辑 Studio */}
          <div className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs">
            {activeTemplate ? (
              <>
                {/* Studio 顶栏 */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 pb-4">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-foreground">
                      <Mail className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-bold tracking-tight text-foreground">
                          {activeTemplate.name}
                        </h2>
                        <span className="inline-flex items-center rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-foreground">
                          {TEMPLATE_CATEGORY_LABEL[activeTemplate.category]}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {inlineEditing ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={mutating}
                          onClick={() => setInlineEditing(false)}
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                          返回预览
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          loading={mutating}
                          disabled={mutating}
                          onClick={() => void saveInlineEdit()}
                        >
                          <Save className="h-3.5 w-3.5" aria-hidden />
                          保存修改
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={mutating}
                          onClick={() => startInlineEdit(activeTemplate)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                          行内编辑
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={mutating}
                          onClick={() => void handleDuplicate(activeTemplate)}
                        >
                          <Copy className="h-3.5 w-3.5" aria-hidden />
                          复制
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={mutating}
                          onClick={() => openEdit(activeTemplate)}
                        >
                          弹窗编辑
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="删除模板"
                          disabled={mutating}
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setDeleteTarget(activeTemplate)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Studio 主体 */}
                {inlineEditing ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-foreground">
                          模板名称 <span className="text-destructive">*</span>
                        </label>
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          placeholder="例如：样品包寄送邀请"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-foreground">模板分类</label>
                        <Select
                          value={draftCategory}
                          onValueChange={(val) => setDraftCategory(val as TemplateCategory)}
                        >
                          <SelectTrigger aria-label="编辑模板分类">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TEMPLATE_CATEGORY_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-foreground">
                        邮件主题 <span className="text-destructive">*</span>
                      </label>
                      <Input
                        value={draftSubject}
                        onChange={(e) => setDraftSubject(e.target.value)}
                        placeholder="可包含 {{company}} 等变量"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-foreground">
                        邮件正文 <span className="text-destructive">*</span>
                      </label>
                      <LetterEditor
                        ref={inlineEditorRef}
                        value={draftContent}
                        onChange={setDraftContent}
                        placeholder="编写开发信模板正文，点击右侧变量可直接插入光标处…"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div>
                      <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                        邮件主题 <span className="text-destructive">*</span>
                      </div>
                      <div className="rounded-lg border border-border bg-surface/50 px-3.5 py-2.5 text-sm font-medium text-foreground">
                        <HighlightedTemplateText text={activeTemplate.subject} />
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          邮件正文 <span className="text-destructive">*</span>
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          变量将在发送时按客户档案自动替换
                        </span>
                      </div>
                      <div className="overflow-hidden rounded-xl border border-border bg-card">
                        <div className="flex items-center justify-between border-b border-border/80 bg-surface/60 px-3.5 py-2 text-[11px] text-muted-foreground">
                          <span>标准商务信函视图 · Inter / Sans</span>
                          <span className="tabular-nums">{activePlainBody.length} 字符</span>
                        </div>
                        <div className="min-h-[260px] space-y-4 p-4 text-[0.875rem] leading-relaxed text-foreground">
                          <div className="whitespace-pre-line break-words">
                            <HighlightedTemplateText text={activePlainBody} />
                          </div>

                          {brandSignatureName ? (
                            <div className="mt-6 flex items-center gap-3 rounded-lg border border-border/70 bg-surface/60 px-3.5 py-2.5">
                              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-xs font-bold text-background">
                                {brandSignatureName.slice(0, 1).toUpperCase()}
                              </span>
                              <div className="min-w-0 border-l border-border pl-3">
                                <p className="truncate text-xs font-semibold text-foreground">{brandSignatureName}</p>
                                {brandSignatureSub ? (
                                  <p className="truncate text-[11px] text-muted-foreground">{brandSignatureSub}</p>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Studio 底部 AI 优化工作条 */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/80 pt-3.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setSuggestTarget(activeTemplate)}
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      AI 优化副本
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 border border-border/70 bg-surface/50 px-2.5 text-xs hover:bg-surface"
                      onClick={() =>
                        openAgentWithPrompt(
                          `请帮我润色外贸开发信模板「${activeTemplate.name}」（主题：${activeTemplate.subject}），保留原有 {{变量}} 占位符不变，使英文表达更地道精炼：\n\n${activePlainBody}`,
                        )
                      }
                    >
                      润色表达
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 border border-border/70 bg-surface/50 px-2.5 text-xs hover:bg-surface"
                      onClick={() =>
                        openAgentWithPrompt(
                          `请帮我把开发信模板「${activeTemplate.name}」调整为更克制、高信任感的现代欧美采购商沟通语气，保留原有 {{变量}} 占位符：\n\n${activePlainBody}`,
                        )
                      }
                    >
                      调整语气
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 border border-border/70 bg-surface/50 px-2.5 text-xs hover:bg-surface"
                      onClick={() =>
                        openAgentWithPrompt(
                          `请基于当前项目产品与对外口径，为模板「${activeTemplate.name}」补充简洁有力的差异化价值点（MOQ / 交期 / 打样支持），保留 {{变量}} 占位符：\n\n${activePlainBody}`,
                        )
                      }
                    >
                      补充卖点
                    </Button>
                  </div>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    上次更新：{formatRelative(activeTemplate.updatedAt)}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          {/* 右栏：模板变量 + 模板信息 + 效果评估 */}
          <aside className="space-y-3.5">
            {/* 1. 模板变量 */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-foreground">模板变量</h3>
                <span className="text-[11px] text-muted-foreground">
                  {inlineEditing ? '点击插入正文' : '点击复制'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                可在邮件主题或正文中插入以下动态占位符：
              </p>
              <div className="mt-2.5 max-h-[212px] space-y-1.5 overflow-y-auto pr-0.5">
                {placeholderDefs.map((def) => (
                  <button
                    key={def.key}
                    type="button"
                    onClick={() => void handleVariableAction(def.token)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-surface/50 px-2.5 py-1.5 text-left transition-colors hover:border-foreground/40 hover:bg-surface"
                  >
                    <code className="font-mono text-[11px] font-semibold text-foreground">{def.token}</code>
                    <span className="truncate text-[11px] text-muted-foreground">{def.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 2. 模板信息 */}
            {activeTemplate ? (
              <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
                <h3 className="text-xs font-semibold text-foreground">模板信息</h3>
                <dl className="mt-2.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Tag className="h-3.5 w-3.5" aria-hidden />
                      模板分类
                    </dt>
                    <dd className="font-medium text-foreground">
                      {TEMPLATE_CATEGORY_LABEL[activeTemplate.category]}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Info className="h-3.5 w-3.5" aria-hidden />
                      引用变量
                    </dt>
                    <dd className="font-medium tabular-nums text-foreground">{activeTokenCount} 个</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      最后更新
                    </dt>
                    <dd className="font-medium tabular-nums text-foreground" title={formatDateTime(activeTemplate.updatedAt)}>
                      {formatRelative(activeTemplate.updatedAt)}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}

            {/* 3. 效果评估 */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs" aria-label="效果评估">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Target className="h-3.5 w-3.5 text-foreground" aria-hidden />
                  <h3 className="text-xs font-semibold text-foreground">效果评估</h3>
                </div>
                <Select
                  value={String(windowDays)}
                  onValueChange={(value) => setWindowDays(Number(value) as 30 | 90 | 180)}
                >
                  <SelectTrigger className="h-7 w-24 text-[11px]" aria-label="统计窗口">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {([30, 90, 180] as const).map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        近 {days} 天
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="mt-3">
                {performanceLoading ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    正在加载效果统计…
                  </p>
                ) : performanceError ? (
                  <div role="alert" className="space-y-2 text-xs text-destructive">
                    <p>{performanceError}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRefreshVersion((value) => value + 1)}
                    >
                      重试
                    </Button>
                  </div>
                ) : activePerfEntry ? (
                  <div className="space-y-2.5">
                    {activePerfEntry.insufficientSample ? (
                      <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 p-2.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">
                        <p className="flex items-center gap-1 font-semibold">
                          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          样本数据偏少
                        </p>
                        <p className="mt-0.5">
                          近 {windowDays} 天发送 {activePerfEntry.metrics.sent} 封（覆盖 {activePerfEntry.sampleSize} 位客户，低于 {performance?.sampleThreshold ?? 10} 位比较阈值），以下数字仅供参考。
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        近 {windowDays} 天发送 {activePerfEntry.metrics.sent} 封 · 覆盖 {activePerfEntry.sampleSize} 位客户
                      </p>
                    )}

                    <div className="grid grid-cols-2 gap-1.5">
                      {STAGES.map(({ key, label }) => {
                        const rate = activePerfEntry.rates[key];
                        return (
                          <div
                            key={key}
                            className="rounded-md border border-border/70 bg-surface/60 px-2.5 py-1.5 text-[11px]"
                          >
                            <span className="text-muted-foreground">{label}</span>
                            <div className="mt-0.5 font-semibold tabular-nums text-foreground">
                              {activePerfEntry.metrics[key]} 位
                              {rate.rate !== null ? ` · ${(rate.rate * 100).toFixed(0)}%` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200/80 bg-amber-50/60 p-3 text-[11px] leading-relaxed text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                    <p className="flex items-center gap-1.5 font-semibold">
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      样本数据不足
                    </p>
                    <p className="mt-1 text-amber-800/90 dark:text-amber-200/80">
                      当前模板在近 {windowDays} 天暂无归因发送样本，建议持续用于开发信跟进后再查看回复率与报价转化指标。
                    </p>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </section>
      )}

      {/* 跨模板全量效果统计折叠抽屉（完整保留归因说明与全部历史模板） */}
      <details className="group rounded-xl border border-border bg-card shadow-xs" aria-label="模板效果">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <div>
            <h2 className="text-[0.8125rem] font-semibold text-foreground">全部模板效果汇总</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              查看当前项目近 {windowDays} 天内所有模板发出后的客户回复、询价与成交动作；样本不足只展示、不比较。
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            近 {windowDays} 天
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
          </span>
        </summary>
        <div className="space-y-3 border-t border-border p-4">
          {performance ? (
            <>
              <p className="text-xs text-muted-foreground">
                {new Date(performance.windowStart).toLocaleDateString()}—
                {new Date(performance.windowEnd).toLocaleDateString()} · 覆盖少于 {performance.sampleThreshold}{' '}
                位客户的模板只展示、不比较
                {performance.unattributed > 0
                  ? ` · 另有 ${performance.unattributed} 封早期邮件没记录用的哪个模板，未计入`
                  : ''}
                。
              </p>
              <p className="rounded-lg border border-border/80 bg-surface/60 p-2.5 text-xs leading-5 text-muted-foreground">
                提醒：这些数字只说明「发信之后客户有没有动作」，不能证明是模板带来的回复或成交；同一个客户可能先后收到过多个模板。
              </p>
              {performance.templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">这段时间还没有用模板发出开发信。</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {performance.templates.map((entry) => (
                    <div
                      key={JSON.stringify([
                        entry.templateId,
                        entry.templateNameSnapshot,
                        entry.templateContentHash,
                      ])}
                      className="space-y-2 rounded-lg border border-border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-xs font-semibold text-foreground">
                          {entry.templateNameSnapshot || '（早期模板，名称未保存）'}
                        </strong>
                        {entry.deleted ? (
                          <span className="rounded bg-surface px-2 py-0.5 text-[11px] text-muted-foreground">
                            模板已删除 · 保留历史
                          </span>
                        ) : null}
                        {entry.insufficientSample ? (
                          <span className="text-[11px] text-amber-700 dark:text-amber-300">样本偏少，仅参考</span>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        发送 {entry.metrics.sent} 封 · 覆盖 {entry.sampleSize} 位客户
                        {entry.insufficientSample
                          ? `（少于 ${performance.sampleThreshold} 位，仅供参考）`
                          : ''}
                      </p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {STAGES.map(({ key, label }) => {
                          const rate = entry.rates[key];
                          return (
                            <p key={key} className="rounded bg-surface/60 px-2 py-1.5 text-[11px] tabular-nums">
                              {label}：{entry.metrics[key]} 位
                              {rate.rate === null ? '' : ` · ${(rate.rate * 100).toFixed(0)}%`}
                            </p>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">暂无汇总数据。</p>
          )}
        </div>
      </details>

      {/* ---------------------------- 弹窗 ---------------------------- */}

      <TemplateSuggestionDialog
        template={suggestTarget}
        onClose={() => setSuggestTarget(null)}
        onCopied={async () => {
          await fetchList();
          setRefreshVersion((value) => value + 1);
        }}
      />

      <TemplateFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
        template={editTarget}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除模板"
        description={
          deleteTarget
            ? `确定要删除模板「${deleteTarget.name}」吗？删除后无法恢复，已用该模板发送过的开发信不受影响。`
            : undefined
        }
        confirmText="删除"
        variant="destructive"
        loading={mutating}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
