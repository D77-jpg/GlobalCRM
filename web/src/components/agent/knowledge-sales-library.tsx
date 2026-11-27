import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileCheck2,
  FolderTree,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { apiGet, toErrorMessage } from '@/lib/api';
import {
  knowledgeEmailPrompt,
  matchesSalesKnowledge,
  salesKnowledge,
  salesMatchExcerpt,
  salesTermDetails,
  salesTermState,
  salesTitle,
  type SalesKnowledge,
} from '@/lib/knowledge-sales';
import { knowledgeCategories, policyTopics, type ProjectKnowledge } from '@/types/knowledge';
import type { Customer } from '@/types/models';
import type { Paginated } from '@/types/api';
import { useProjectStore } from '@/store/project.store';
import { useAuthStore } from '@/store/auth.store';
import { useUiStore } from '@/store/ui.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentMessageContent } from './agent-message-content';

const categories = {
  reference: '参考资料',
  company: '公司与品牌',
  product: '产品与定制',
  trade: '起订量与交易条件',
  compliance: '质量与认证',
  sales_rules: '销售注意事项',
  faq: '常见问题',
};

function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length || !text) return <>{text}</>;
  const pattern = new RegExp(
    '(' + terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi',
  );
  return (
    <>
      {text.split(pattern).map((part, index) =>
        terms.some((term) => part.toLocaleLowerCase() === term.toLocaleLowerCase()) ? (
          <mark
            key={index}
            className="rounded-sm bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-400/30"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
const highlightRegistry = () => (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
const HighlightCtor = () =>
  (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

function paintHits(ranges: Range[], active: number) {
  const registry = highlightRegistry(),
    Ctor = HighlightCtor();
  if (!registry || !Ctor) return;
  registry.delete('kb-hit');
  registry.delete('kb-hit-active');
  if (ranges.length) registry.set('kb-hit', new Ctor(...ranges));
  if (active >= 0 && ranges[active]) registry.set('kb-hit-active', new Ctor(ranges[active]));
}

function collectHits(root: HTMLElement, query: string) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) return [];
  const pattern = new RegExp(
    '(' + terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi',
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const ranges: Range[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  return ranges;
}

function revealHit(range: Range) {
  const node = range.startContainer;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function KnowledgeSalesLibrary({
  admin,
  initialId,
  onManage,
  onImport,
}: {
  admin: boolean;
  initialId?: string;
  onManage: (id?: string) => void;
  onImport: () => void;
}) {
  const project = useProjectStore((s) => s.activeProject);
  const user = useAuthStore((s) => s.user);
  const openAgentWithPrompt = useUiStore((s) => s.openAgentWithPrompt);
  const [rows, setRows] = React.useState<ProjectKnowledge[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [selectedId, setSelectedId] = React.useState(initialId ?? '');
  const [mobileDetail, setMobileDetail] = React.useState(!!initialId);
  const [picker, setPicker] = React.useState<SalesKnowledge | null>(null);
  const [refresh, setRefresh] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void apiGet<ProjectKnowledge[]>('/agent/knowledge')
      .then((value) => {
        if (active) setRows(value);
      })
      .catch((e) => {
        if (active) setError(toErrorMessage(e, '资料暂时未能加载'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  const entries = salesKnowledge(rows);
  const found = entries.filter((item) => matchesSalesKnowledge(item, query, category));
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? [...found].sort(
        (a, b) =>
          Number(b.revision.title.toLocaleLowerCase().includes(needle)) -
          Number(a.revision.title.toLocaleLowerCase().includes(needle)),
      )
    : found;
  const selected = matches.find((item) => item.id === selectedId) ?? matches[0];
  const pending = rows.filter((r) => !r.archived && r.hasDraft).length;
  const choose = (item: SalesKnowledge) => {
    setSelectedId(item.id);
    setMobileDetail(true);
  };
  const search = (text: string) => {
    setQuery(text);
    setMobileDetail(false);
  };

  const contentRef = React.useRef<HTMLDivElement>(null);
  const rangesRef = React.useRef<Range[]>([]);
  const [hitCount, setHitCount] = React.useState(0);
  const [hitIndex, setHitIndex] = React.useState(0);

  React.useEffect(() => {
    const root = contentRef.current,
      text = query.trim();
    if (!root || !text) {
      rangesRef.current = [];
      setHitCount(0);
      setHitIndex(0);
      paintHits([], -1);
      return;
    }
    const ranges = collectHits(root, text);
    rangesRef.current = ranges;
    setHitCount(ranges.length);
    setHitIndex(0);
    paintHits(ranges, ranges.length ? 0 : -1);
    if (ranges.length) revealHit(ranges[0]);
    return () => paintHits([], -1);
  }, [query, selected?.id]);

  const goHit = (delta: number) => {
    const ranges = rangesRef.current;
    if (!ranges.length) return;
    const next = (hitIndex + delta + ranges.length) % ranges.length;
    setHitIndex(next);
    paintHits(ranges, next);
    revealHit(ranges[next]);
  };

  return (
    <div className="knowledge-sales-library flex flex-col xl:min-h-0 xl:flex-1">
      {error ? (
        <div role="alert" className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setRefresh((n) => n + 1)}>
            重新加载
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          正在加载当前项目事实资料库…
        </p>
      ) : entries.length === 0 ? (
        <section aria-label="资料待准备" className="m-6 rounded-xl border border-border bg-surface/45 px-6 py-10">
          <FileCheck2 className="mb-3 h-7 w-7 text-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">还没有审核通过的销售资料</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            {admin && pending
              ? `当前有 ${pending} 份资料待审核。导入后只是草稿，需要核对产品、交易条件和来源，再逐条发布。`
              : '请联系项目管理员录入公司、产品和交易政策，并完成审核发布。'}
            审核前，助手不能把这些资料用于客户邮件。
          </p>
          {admin ? (
            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button size="sm" onClick={onImport}>
                上传文件 <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              {!!pending && (
                <Button variant="outline" size="sm" onClick={() => onManage()}>
                  去审核资料（{pending}）
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              你仍可在客户页使用销售助手；缺少的业务依据会列为待确认。
            </p>
          )}
        </section>
      ) : (
        /* ==================================================================
           3-COLUMN NOTION / LINEAR-GRADE KNOWLEDGE & FACT CITATION STUDIO
           ================================================================== */
        <div className="grid min-h-0 flex-1 xl:grid-cols-[276px_minmax(0,1fr)_272px]">
          {/* COLUMN 1: Integrated Search + Category Facets + Document Tree */}
          <section
            aria-label="已发布资料列表"
            className={
              (mobileDetail ? 'hidden xl:flex' : 'flex') +
              ' min-h-0 min-w-0 flex-col border-b border-border bg-surface/35 xl:border-b-0 xl:border-r'
            }
          >
            <div className="space-y-2.5 border-b border-border/80 p-3.5">
              <div className="flex items-center justify-between">
                <label htmlFor="sales-knowledge-query" className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <FolderTree className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  知识目录树
                </label>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {matches.length}/{entries.length} 篇
                </span>
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <Input
                  id="sales-knowledge-query"
                  className="h-8 bg-card pl-8 text-xs"
                  value={query}
                  onChange={(e) => search(e.target.value)}
                  placeholder="检索产品、工艺、MOQ、条款…"
                />
              </div>

              <nav aria-label="销售资料分类" className="flex flex-wrap gap-1 pt-0.5">
                {[['all', '全部'], ...Object.entries(categories)].map(([key, label]) => {
                  const cnt = key === 'all' ? entries.length : entries.filter((e) => e.revision.category === key).length;
                  if (key !== 'all' && cnt === 0 && category !== key) return null;
                  const activeCat = category === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={activeCat}
                      onClick={() => {
                        setCategory(key);
                        setMobileDetail(false);
                      }}
                      className={
                        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors ' +
                        (activeCat
                          ? 'os-pill-active'
                          : 'border-border/80 bg-card text-muted-foreground hover:text-foreground')
                      }
                    >
                      <span>{label}</span>
                      <span className="font-mono text-[10px] tabular-nums opacity-75">{cnt}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {!matches.length ? (
              <div className="p-6 text-center text-xs">
                <p className="font-medium text-foreground">无匹配文档</p>
                <p className="mt-1 text-muted-foreground">可缩短关键词或重置分类筛选</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 h-7 text-xs"
                  onClick={() => {
                    setQuery('');
                    setCategory('all');
                  }}
                >
                  清除筛选
                </Button>
              </div>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-border/65 overflow-y-auto">
                {matches.map((item) => {
                  const excerpt = query.trim() ? salesMatchExcerpt(item, query) : '';
                  const isCurrent = selected?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={isCurrent ? 'true' : undefined}
                        onClick={() => choose(item)}
                        className={
                          'w-full min-w-0 border-l-2 px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none ' +
                          (isCurrent
                            ? 'border-foreground bg-card shadow-[inset_0_1px_0_hsl(var(--border)/0.4)]'
                            : 'border-transparent hover:bg-card/70')
                        }
                      >
                        <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
                          <span>{knowledgeCategories[item.revision.category ?? 'product']}</span>
                          <span className="font-mono">v{item.revision.version}</span>
                        </div>
                        <span className="mt-0.5 block break-words text-[0.8125rem] font-semibold leading-snug text-foreground">
                          <Highlighted text={salesTitle(item.revision.title)} query={query} />
                        </span>
                        {excerpt ? (
                          <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                            <Highlighted text={excerpt} query={query} />
                          </span>
                        ) : item.revision.products?.length ? (
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {item.revision.products.join(' · ')}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex items-center justify-between border-t border-border/80 bg-card/60 px-3.5 py-2 text-[11px] text-muted-foreground">
              <span role="status">
                {admin && pending > 0 ? (
                  <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onManage()}>
                    {pending} 份草稿待审核 →
                  </button>
                ) : (
                  `${entries.length} 份有效事实依据`
                )}
              </span>
              <button
                type="button"
                onClick={() => setRefresh((n) => n + 1)}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                刷新
              </button>
            </div>
          </section>

          {/* COLUMN 2: Editorial Document Sheet */}
          {selected ? (
            <article
              aria-label="销售资料详情"
              className={(mobileDetail ? 'flex' : 'hidden xl:flex') + ' min-h-0 min-w-0 flex-col bg-card xl:border-r xl:border-border'}
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/80 px-5 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="mr-1 inline-flex items-center gap-1 font-medium text-foreground xl:hidden"
                    onClick={() => setMobileDetail(false)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden />返回目录
                  </button>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-emerald-50/70 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden />
                    已发布依据
                  </span>
                  <span className="text-muted-foreground">
                    {knowledgeCategories[selected.revision.category ?? 'product']} · 第 {selected.revision.version} 版
                  </span>
                  {selected.revision.accessScope === 'admins' ? <Badge variant="outline">仅管理员</Badge> : null}
                </div>

                {query.trim() ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      {hitCount ? `命中 ${hitIndex + 1}/${hitCount}` : '正文未直接命中'}
                    </span>
                    {hitCount > 0 ? (
                      <>
                        <Button variant="outline" size="icon-xs" onClick={() => goHit(-1)} aria-label="上一处命中">
                          <ChevronUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="icon-xs" onClick={() => goHit(1)} aria-label="下一处命中">
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : admin ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onManage(selected.id)}>
                    <Pencil className="h-3 w-3" aria-hidden />修订文档
                  </Button>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div ref={contentRef} className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
                  <h2 className="break-words text-xl font-bold leading-snug tracking-[-0.02em] text-foreground">
                    {salesTitle(selected.revision.title)}
                  </h2>

                  <div className="callout-sage my-4">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                      适用范围与对外边界
                    </div>
                    <p className="mt-1 break-words text-xs leading-relaxed text-foreground/90">
                      {selected.revision.applicability || '具体适用条件需结合客户询盘进一步核对'}
                    </p>
                  </div>

                  {(selected.revision.terms ?? []).length > 0 ? (
                    <section aria-label="交易条件" className="mb-5 rounded-xl border border-border/80 bg-surface/45 p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-foreground">
                        标准商业条款（对外引用须完整保留前提条件）
                      </h3>
                      <div className="mt-2.5 divide-y divide-border/70">
                        {selected.revision.terms!.map((term, i) => (
                          <div key={i} className="py-2.5 first:pt-0 last:pb-0 text-xs leading-relaxed">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <strong className="font-semibold text-foreground">
                                {policyTopics[term.topic]}：{[term.currency, term.value, term.unit].filter(Boolean).join(' ')}
                              </strong>
                              <Badge variant="outline">{salesTermState(term)}</Badge>
                            </div>
                            <p className="mt-1 break-words text-muted-foreground">{term.conditions}</p>
                            {salesTermDetails(term).map((line, n) => (
                              <p key={n} className="break-words text-muted-foreground">
                                {line}
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  <div className="break-words text-sm leading-7">
                    <AgentMessageContent content={selected.revision.content} />
                  </div>
                </div>
              </div>
            </article>
          ) : (
            <div className="hidden items-center justify-center p-10 text-xs text-muted-foreground xl:flex xl:border-r xl:border-border">
              在左侧选择一篇资料即可阅读全文并联动 AI 写信
            </div>
          )}

          {/* COLUMN 3: AI Fact Citation & Metadata Inspector */}
          <aside className="hidden min-h-0 flex-col justify-between overflow-y-auto bg-surface/25 p-4 xl:flex">
            {selected ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    AI 事实引用调度
                  </h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    基于当前已审核文档直接为客户起草邮件或提炼谈判要点，不越权编造承诺。
                  </p>
                  <div className="mt-3 space-y-2">
                    <Button size="sm" className="w-full justify-between text-xs" onClick={() => setPicker(selected)}>
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5" aria-hidden />用这份资料准备开发信
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-start text-xs"
                      onClick={() =>
                        openAgentWithPrompt(
                          `请基于项目已发布知识文档《${salesTitle(selected.revision.title)}》，为我提炼 3 条可直接用于外贸客户沟通的核心卖点与注意事项。`,
                        )
                      }
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />提炼对外沟通卖点
                    </Button>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
                  <h3 className="text-xs font-semibold text-foreground">文档元数据与溯源</h3>
                  <dl className="mt-2.5 divide-y divide-border/65 text-xs">
                    <div className="flex items-start justify-between gap-2 py-2 first:pt-0">
                      <dt className="shrink-0 text-muted-foreground">覆盖产品</dt>
                      <dd className="text-right font-medium text-foreground">
                        {selected.revision.products?.length ? selected.revision.products.join('、') : '项目通用'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-2">
                      <dt className="shrink-0 text-muted-foreground">结构化条款</dt>
                      <dd className="font-mono font-semibold tabular-nums text-foreground">
                        {(selected.revision.terms ?? []).length} 项
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-2 py-2">
                      <dt className="shrink-0 text-muted-foreground">资料来源</dt>
                      <dd className="max-w-[10.5rem] break-words text-right text-muted-foreground">
                        {selected.revision.source || '内部录入'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-2 last:pb-0">
                      <dt className="shrink-0 text-muted-foreground">生效时间</dt>
                      <dd className="tabular-nums text-muted-foreground">
                        {selected.revision.validFrom
                          ? new Date(selected.revision.validFrom).toLocaleDateString('zh-CN')
                          : '长期有效'}
                      </dd>
                    </div>
                  </dl>
                  {admin ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full text-xs"
                      onClick={() => onManage()}
                    >
                      进入资料管理后台
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mt-4 rounded-lg border border-border/75 bg-card/80 p-3 text-[11px] leading-relaxed text-muted-foreground">
              发布后的资料仍需核对目标客户的起订量、交期与定制例外；AI 引用时自动附加口径护栏。
            </div>
          </aside>
        </div>
      )}

      {rows.length >= 500 ? (
        <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          当前展示最近 500 条可访问记录中的有效资料；本页筛选不代表全库搜索。
        </p>
      ) : null}

      {picker && project && user ? (
        <KnowledgeCustomerPicker
          key={picker.id}
          item={picker}
          projectId={project.id}
          userId={user.id}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}

function KnowledgeCustomerPicker({
  item,
  projectId,
  userId,
  onClose,
}: {
  item: SalesKnowledge;
  projectId: string;
  userId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate(),
    prepare = useUiStore((s) => s.prepareKnowledgeEmail);
  const [query, setQuery] = React.useState(''),
    [page, setPage] = React.useState(1),
    [customers, setCustomers] = React.useState<Paginated<Customer> | null>(null),
    [loading, setLoading] = React.useState(true),
    [error, setError] = React.useState(''),
    [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setLoading(true);
    setCustomers(null);
    setError('');
    const timer = setTimeout(() => {
      void apiGet<Paginated<Customer>>('/customers', {
        params: { search: query.trim(), page, limit: 10 },
        signal: abort.signal,
      })
        .then((value) => {
          if (active) setCustomers(value);
        })
        .catch((e) => {
          if (active) setError(toErrorMessage(e, '客户列表暂时未能加载'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, page, retry]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>为哪位客户准备开发信？</DialogTitle>
          <DialogDescription>
            参考资料：{salesTitle(item.revision.title)}。选中后会打开客户页和助手，不会立即生成或发送邮件。
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-2">
            <label htmlFor="knowledge-customer-search" className="text-sm font-medium">
              搜索当前项目的客户
            </label>
            <Input
              id="knowledge-customer-search"
              className="min-h-11"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="客户姓名、公司或邮箱"
            />
          </div>
          {error && (
            <div role="alert" className="my-4 text-sm leading-6 text-destructive">
              {error}
              <Button variant="outline" className="ml-2 min-h-11" onClick={() => setRetry((n) => n + 1)}>
                重试
              </Button>
            </div>
          )}
          {loading && <p role="status" className="py-6 text-sm text-muted-foreground">正在加载可访问客户…</p>}
          {!loading && customers && (
            <>
              <ul className="mt-4 divide-y border-y">
                {customers.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        prepare({ projectId, userId, customerId: c.id, prompt: knowledgeEmailPrompt(item) });
                        onClose();
                        navigate('/customers/' + c.id);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">{c.name}</span>
                        <span className="mt-1 block break-words text-xs leading-6 text-muted-foreground">
                          {c.company || '未填写公司'} · {c.email || '未填写邮箱，发送前需补充'}
                        </span>
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              {!customers.items.length && (
                <p className="py-6 text-sm leading-6 text-muted-foreground">
                  没有匹配的可访问客户，请换个关键词，或先在客户管理中新增客户。
                </p>
              )}
              <div className="mt-4 flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-label="客户上一页"
                  disabled={!customers.hasPrev}
                  onClick={() => setPage((n) => n - 1)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                  上一页
                </Button>
                <span className="text-xs text-muted-foreground">
                  第 {customers.page} / {Math.max(customers.totalPages, 1)} 页
                </span>
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-label="客户下一页"
                  disabled={!customers.hasNext}
                  onClick={() => setPage((n) => n + 1)}
                >
                  下一页
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
