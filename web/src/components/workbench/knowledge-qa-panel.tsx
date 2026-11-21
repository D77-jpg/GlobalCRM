import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  FolderTree,
  Loader2,
  Package,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ROUTES } from '@/constants';
import type { ProjectKnowledge } from '@/types/knowledge';
import type { KnowledgeQaResult } from '@/types';
import { AgentMessageContent } from '@/components/agent/agent-message-content';

const TREE_CATEGORIES = [
  { key: 'all', label: '全部资料' },
  { key: 'product', label: '产品资料与工艺' },
  { key: 'trade', label: '报价政策与 MOQ' },
  { key: 'compliance', label: '出口合规与认证' },
  { key: 'company', label: '工厂与公司实力' },
  { key: 'sales_rules', label: '销售话术与红线' },
  { key: 'faq', label: '历史经验与 FAQ' },
  { key: 'reference', label: '外贸术语与参考' },
] as const;

interface ChatTurn {
  id: string;
  question: string;
  result: KnowledgeQaResult;
}

export function KnowledgeQaPanel({ admin }: { admin: boolean }): React.JSX.Element {
  const [docs, setDocs] = React.useState<ProjectKnowledge[]>([]);
  const [activeCat, setActiveCat] = React.useState<string>('all');
  const [question, setQuestion] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = React.useState<string>('');
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const loadDocs = React.useCallback(async () => {
    try {
      const rows = await apiGet<ProjectKnowledge[]>('/agent/knowledge');
      setDocs(rows.filter((r) => !r.archived && r.approvedVersion > 0));
    } catch {
      // non-fatal
    }
  }, []);

  React.useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  const catCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const d of docs) {
      const rev = d.revisions.find((r) => r.version === d.approvedVersion) ?? d.revisions[0];
      const cat = rev?.category || 'reference';
      map.set(cat, (map.get(cat) ?? 0) + 1);
    }
    return map;
  }, [docs]);

  const visibleDocs = React.useMemo(() => {
    if (activeCat === 'all') return docs;
    return docs.filter((d) => {
      const rev = d.revisions.find((r) => r.version === d.approvedVersion) ?? d.revisions[0];
      return (rev?.category || 'reference') === activeCat;
    });
  }, [docs, activeCat]);

  const activeTurn = turns.find((t) => t.id === selectedTurnId) ?? turns[turns.length - 1] ?? null;

  const ask = async (textOverride?: string) => {
    const q = (textOverride ?? question).trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const res = await apiPost<KnowledgeQaResult>('/workbench/knowledge-qa', { question: q });
      const id = `qa-${Date.now()}`;
      setTurns((prev) => [...prev, { id, question: q, result: res }]);
      setSelectedTurnId(id);
      if (!textOverride) setQuestion('');
    } catch (e) {
      toast.error(toErrorMessage(e, '知识问答失败'));
    } finally {
      setAsking(false);
    }
  };

  const handleImportFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setImporting(true);
    try {
      const first = fileList[0];
      if (fileList.length === 1 && first.name.toLowerCase().endsWith('.zip')) {
        const buf = await first.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        const zipBase64 = btoa(binary);
        const res = await apiPost<{ imported: number; skipped: number }>('/workbench/knowledge-import-markdown', {
          zipBase64,
          sourceLabel: `Obsidian ZIP (${first.name})`,
        });
        toast.success(`已导入 ${res.imported} 篇 Markdown 草稿（跳过 ${res.skipped} 篇），请在「资料管理」审核发布`);
      } else {
        const files: { path: string; content: string }[] = [];
        for (const f of Array.from(fileList)) {
          if (!f.name.toLowerCase().endsWith('.md')) continue;
          const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
          files.push({ path: rel, content: await f.text() });
        }
        if (files.length === 0) {
          toast.error('请选择 .md 文件或 Obsidian .zip 压缩包');
          return;
        }
        const res = await apiPost<{ imported: number; skipped: number }>('/workbench/knowledge-import-markdown', {
          files,
          sourceLabel: 'Markdown 批量导入',
        });
        toast.success(`已导入 ${res.imported} 篇 Markdown 草稿（跳过 ${res.skipped} 篇），请审核发布`);
      }
      await loadDocs();
    } catch (e) {
      toast.error(toErrorMessage(e, '导入失败'));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="grid min-h-[540px] overflow-hidden rounded-lg border border-border bg-card xl:h-[calc(100dvh-13rem)] xl:grid-cols-[16.5rem_minmax(0,1fr)_21rem]">
      {/* Left: Category tree */}
      <aside className="flex min-w-0 flex-col border-b border-border xl:border-b-0 xl:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <FolderTree className="h-3.5 w-3.5 text-primary" />知识库目录树
          </span>
          {admin ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.zip"
                multiple
                className="hidden"
                onChange={(e) => void handleImportFiles(e.target.files)}
              />
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" loading={importing} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-3 w-3" />导入 MD/ZIP
              </Button>
            </>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5 text-xs">
            {TREE_CATEGORIES.map((cat) => {
              const count = cat.key === 'all' ? docs.length : (catCounts.get(cat.key) ?? 0);
              const active = activeCat === cat.key;
              return (
                <li key={cat.key}>
                  <button
                    type="button"
                    onClick={() => setActiveCat(cat.key)}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-primary text-primary-foreground font-medium' : 'text-foreground/85 hover:bg-muted'
                    }`}
                  >
                    <span className="truncate">{cat.label}</span>
                    <span className={`tabular-nums text-[11px] ${active ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {visibleDocs.length > 0 ? (
            <div className="mt-3 border-t border-border pt-2.5">
              <p className="mb-1.5 px-2 text-[11px] font-medium text-muted-foreground">当前分类文档（点标题提问）</p>
              <ul className="space-y-1 text-xs">
                {visibleDocs.slice(0, 15).map((d) => {
                  const rev = d.revisions.find((r) => r.version === d.approvedVersion) ?? d.revisions[0];
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => void ask(`请总结「${rev?.title ?? '该资料'}」里的关键规格、MOQ、交期和对外口径注意事项`)}
                        className="block w-full truncate rounded px-2 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={rev?.title}
                      >
                        · {rev?.title || '未命名资料'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </aside>

      {/* Center: AI Q&A conversation */}
      <section className="flex min-w-0 flex-col overflow-hidden border-b border-border xl:border-b-0 xl:border-r">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">AI 知识库与口径助手</span>
          </div>
          <span className="text-[11px] text-muted-foreground">仅引用已审核资料、对外口径表与产品目录</span>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {turns.length === 0 ? (
            <div className="mx-auto max-w-lg space-y-4 py-8 text-center">
              <p className="text-sm font-medium">直接用自然语言查产品规格、起订量、交期、付款或出口合规口径</p>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  '我们定制产品的标准 MOQ、打样和大货交期分别是多少？',
                  '出口美国市场有哪些合规或反倾销税注意事项？',
                  '客户要求免费寄定制样品时，标准回复口径是什么？',
                  '我们有哪些证书？回复客户时怎么准确表述？',
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void ask(q)}
                    className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/85 hover:border-primary hover:bg-muted"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <div
                key={turn.id}
                onClick={() => setSelectedTurnId(turn.id)}
                className={`space-y-3 rounded-lg border p-3.5 transition-colors ${activeTurn?.id === turn.id ? 'border-primary/50 bg-muted/20' : 'border-border'}`}
              >
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
                    {turn.question}
                  </div>
                </div>
                <div className="space-y-2.5 rounded-lg border border-border bg-background p-3 text-sm">
                  <AgentMessageContent content={turn.result.answer} />
                  {(turn.result.matchedDocs.length > 0 || turn.result.matchedPolicies.length > 0) ? (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2">
                      <span className="text-[11px] text-muted-foreground">信息来源：</span>
                      {turn.result.matchedPolicies.map((p) => (
                        <Badge key={p.code} variant="outline" className="text-[10px]">口径 {p.code} · {p.topic}</Badge>
                      ))}
                      {turn.result.matchedDocs.slice(0, 3).map((d) => (
                        <Badge key={d.id} variant="secondary" className="text-[10px]">{d.title}</Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
                {turn.result.suggestedQuestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {turn.result.suggestedQuestions.map((sq) => (
                      <button
                        key={sq}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void ask(sq); }}
                        className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                      >
                        {sq}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void ask(); }}
          className="flex items-center gap-2 border-t border-border p-3"
        >
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="向知识库提问（如：MOQ、打样周期、工艺、出口美国合规…）"
            className="flex-1"
          />
          <Button type="submit" disabled={asking || !question.trim()}>
            {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}提问
          </Button>
        </form>
      </section>

      {/* Right: Retrieval hits + Linked Product Card + Confidence Checklist */}
      <aside className="flex min-w-0 flex-col overflow-y-auto p-3.5 space-y-4">
        <div>
          <h3 className="text-xs font-semibold">知识检索命中</h3>
          {!activeTurn ? (
            <p className="mt-1.5 text-xs text-muted-foreground">提问后这里会展示命中资料的相关性与关联产品参数卡。</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {activeTurn.result.matchedDocs.map((d) => (
                <div key={d.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{d.title}</span>
                    <Badge variant={d.relevance === 'high' ? 'outline' : 'secondary'} className="shrink-0 text-[10px]">
                      {d.relevance === 'high' ? '高度相关' : '相关'} {d.score}%
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{d.excerpt}</p>
                </div>
              ))}
              {activeTurn.result.matchedDocs.length === 0 ? (
                <p className="text-xs text-muted-foreground">本次主要由对外口径或产品目录命中</p>
              ) : null}
            </div>
          )}
        </div>

        {/* Linked Product Cards */}
        <div>
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1 text-xs font-semibold">
              <Package className="h-3.5 w-3.5 text-primary" />关联产品关键信息
            </h3>
            <Link to={ROUTES.products} className="text-[11px] text-primary hover:underline">查看产品库</Link>
          </div>
          {!activeTurn || activeTurn.result.matchedProducts.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">提问包含产品名或 SKU 时自动联动产品规格与阶梯价。</p>
          ) : (
            <div className="mt-2 space-y-2.5">
              {activeTurn.result.matchedProducts.map((prod) => (
                <div key={prod.id} className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5 text-xs">
                  <div className="flex items-start gap-2.5">
                    {prod.imageUrl ? (
                      <img src={prod.imageUrl} alt={prod.name} className="h-12 w-12 shrink-0 rounded-md border border-border object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                        <Package className="h-5 w-5" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{prod.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{prod.sku}{prod.category ? ` · ${prod.category}` : ''}</p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-1.5 text-[11px]">
                    <div className="rounded bg-background px-2 py-1">
                      <dt className="text-muted-foreground">MOQ</dt>
                      <dd className="font-medium">{prod.moq || '待核'}</dd>
                    </div>
                    <div className="rounded bg-background px-2 py-1">
                      <dt className="text-muted-foreground">交期</dt>
                      <dd className="font-medium">{prod.leadTime || '待核'}</dd>
                    </div>
                  </dl>
                  {prod.priceTiers.length > 0 ? (
                    <div className="space-y-0.5 border-t border-border pt-1.5 text-[11px]">
                      {prod.priceTiers.slice(0, 3).map((t, i) => (
                        <div key={i} className="flex justify-between">
                          <span className="text-muted-foreground">{t.minQuantity}{t.maxQuantity ? `–${t.maxQuantity}` : '+'} pcs</span>
                          <span className="font-medium tabular-nums">{t.currency} {t.unitPrice}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Grounded Confidence Checklist */}
        {activeTurn ? (
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />回答依据核验
            </h3>
            <ul className="mt-2 space-y-1.5 text-[11px]">
              {activeTurn.result.confidenceChecks.map((ck) => (
                <li key={ck.label} className="flex items-center gap-1.5">
                  <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${ck.passed ? 'text-emerald-600' : 'text-muted-foreground/40'}`} />
                  <span className={ck.passed ? 'text-foreground' : 'text-muted-foreground'}>{ck.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
