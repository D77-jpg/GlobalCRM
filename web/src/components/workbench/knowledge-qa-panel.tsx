import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeDollarSign,
  BookOpen,
  Building2,
  CheckCircle2,
  ChevronRight,
  FolderTree,
  HelpCircle,
  Layers,
  Loader2,
  MessageSquareQuote,
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
  { key: 'all', label: '全部资料', icon: Layers, accent: 'text-indigo-600 dark:text-indigo-400' },
  { key: 'product', label: '产品资料与工艺', icon: Package, accent: 'text-sky-600 dark:text-sky-400' },
  { key: 'trade', label: '报价政策与 MOQ', icon: BadgeDollarSign, accent: 'text-amber-600 dark:text-amber-400' },
  { key: 'compliance', label: '出口合规与认证', icon: ShieldCheck, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'company', label: '工厂与公司实力', icon: Building2, accent: 'text-violet-600 dark:text-violet-400' },
  { key: 'sales_rules', label: '销售话术与红线', icon: MessageSquareQuote, accent: 'text-rose-600 dark:text-rose-400' },
  { key: 'faq', label: '历史经验与 FAQ', icon: HelpCircle, accent: 'text-teal-600 dark:text-teal-400' },
  { key: 'reference', label: '外贸术语与参考', icon: BookOpen, accent: 'text-slate-500 dark:text-slate-400' },
] as const;

const QUICK_SCENARIOS_BY_CAT: Record<string, Array<{ title: string; subtitle: string; prompt: string }>> = {
  all: [
    { title: 'MOQ、打样与大货交期', subtitle: '买家询盘最常问的基础商务口径', prompt: '我们定制产品的标准 MOQ、打样费用及大货交期分别是多少？回复客户时怎么准确表述？' },
    { title: '按客户行业推荐款式', subtitle: '珠宝、美妆、礼品等场景快速选型', prompt: '不同行业（如珠宝、美妆、时尚礼品）的买家适合主推哪几类产品与材质搭配？' },
    { title: '付款方式与贸易条款', subtitle: '定金比例、尾款及 FOB/DDP 规范', prompt: '我们标准的付款方式、定金尾款比例和贸易条款（FOB/CIF/DDP）口径是什么？' },
    { title: '对外红线与禁承诺项', subtitle: '发信和报价前必查的合规边界', prompt: '汇总本项目对外沟通红线、绝对不能随意承诺的事项及合规注意事项。' },
    { title: '免费寄样与压价应对', subtitle: '高频买家异议的标准专业回复', prompt: '遇到客户要求免费寄定制样品或压低起订量时，标准回复口径和替代方案是什么？' },
  ],
  product: [
    { title: '主推品类与核心工艺清单', subtitle: '材质、烫金、丝印与环保选项', prompt: '列出当前已发布资料中的主推产品品类、常用材质和定制 Logo 工艺选项。' },
    { title: '珠宝与美妆包装搭配建议', subtitle: '提升客单价的整套组合方案', prompt: '针对珠宝首饰和美妆护肤买家，有哪些推荐的包装结构、内托与组合方案？' },
    { title: '尺寸与结构定制注意事项', subtitle: '打样前需要客户确认的参数', prompt: '客户咨询定制尺寸、内托结构或特殊材质时，业务员需要提前核对哪些关键参数？' },
  ],
  trade: [
    { title: '起订量与阶梯价规则', subtitle: '小批量试单与大货数量档位', prompt: '整理不同品类的起订量（MOQ）、小批量试单政策以及阶梯报价核对口径。' },
    { title: '打样周期与大货排产交期', subtitle: '旺季交期缓冲与物流方式说明', prompt: '打样周期、打样费退还条件和大货交期的标准对外回复口径是什么？' },
    { title: '付款条件与报价有效期', subtitle: 'T/T 比例、币种与有效期规范', prompt: '标准付款方式、接受币种以及正式报价单有效期的口径要求是什么？' },
  ],
  compliance: [
    { title: '出口欧美市场合规与税费', subtitle: '反倾销税、环保包装与清关提示', prompt: '出口美国、欧洲等重点市场有哪些合规、环保认证或关税/反倾销注意事项？' },
    { title: '已有证书的准确表述方式', subtitle: '避免夸大认证范围引起纠纷', prompt: '我们具备哪些工厂或材料认证（如 FSC、BSCI、ISO 等）？对外邮件中应如何严谨表述？' },
  ],
  company: [
    { title: '工厂产能与核心优势话术', subtitle: '开发信与新客破冰背书要点', prompt: '提炼最适合写进首封开发信的公司实力、自有工厂产能、品控与品牌服务经验要点。' },
    { title: '验厂、视频看厂与寄样流程', subtitle: '增强海外大买家信任的标准流程', prompt: '海外大客户希望视频看厂、审核工厂资质或确认品控流程时，我们有哪些可展示依据？' },
  ],
  sales_rules: [
    { title: '开发信核心撰写规范', subtitle: '结构、长度、语气与禁用词检查', prompt: '总结本项目的核心开发信撰写规范、推荐切入角度以及严禁出现的表述红线。' },
    { title: '报价与交期承诺底线', subtitle: '避免越权承诺的内部审核规则', prompt: '哪些价格、交期、样品或售后条款必须先经内部核准，业务员不能直接对外承诺？' },
  ],
  faq: [
    { title: '高频买家 FAQ 速查', subtitle: '起订量、样品费、Logo 文件格式', prompt: '汇总买家最常问的 5 个问题（MOQ、样品费、Logo 图稿、交期、物流）及标准回答。' },
    { title: '客户资格判断与跟进优先级', subtitle: '识别高潜品牌买家与低质询盘', prompt: '收到新询盘后，如何根据资料中的买家资格核对清单判断客户潜力与回复策略？' },
  ],
  reference: [
    { title: '常用贸易条款与包装术语', subtitle: 'FOB / CIF / DDP 与材质英文表达', prompt: '整理外贸沟通中高频使用的英文包装工艺术语和常用贸易条款说明。' },
  ],
};

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

  const quickScenarios = React.useMemo(
    () => QUICK_SCENARIOS_BY_CAT[activeCat] ?? QUICK_SCENARIOS_BY_CAT.all,
    [activeCat],
  );
  const activeCatLabel = React.useMemo(
    () => TREE_CATEGORIES.find((c) => c.key === activeCat)?.label ?? '全部资料',
    [activeCat],
  );
  const activeCatDocCount = activeCat === 'all' ? docs.length : (catCounts.get(activeCat) ?? 0);

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
    <div className="grid min-h-[540px] overflow-hidden rounded-xl border border-border bg-card shadow-xs xl:h-[calc(100dvh-13rem)] xl:grid-cols-[17.5rem_minmax(0,1fr)_20.5rem]">
      {/* Left: Refined Category Filter + Sales High-Frequency Quick-Query Playbook */}
      <aside className="flex min-w-0 flex-col border-b border-border bg-surface/35 xl:border-b-0 xl:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border/80 bg-card/70 px-3.5 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <FolderTree className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />知识库目录
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <ul className="space-y-0.5 text-xs">
            {TREE_CATEGORIES.map((cat) => {
              const count = cat.key === 'all' ? docs.length : (catCounts.get(cat.key) ?? 0);
              const active = activeCat === cat.key;
              const CatIcon = cat.icon;
              return (
                <li key={cat.key}>
                  <button
                    type="button"
                    onClick={() => setActiveCat(cat.key)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-all ${
                      active
                        ? 'bg-card font-semibold text-foreground shadow-xs ring-1 ring-border'
                        : count === 0
                          ? 'text-muted-foreground/65 hover:bg-card/60 hover:text-foreground'
                          : 'text-foreground/85 hover:bg-card/75 hover:text-foreground'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <CatIcon className={`h-3.5 w-3.5 shrink-0 ${active ? cat.accent : count === 0 ? 'opacity-50' : cat.accent}`} aria-hidden />
                      <span className="truncate">{cat.label}</span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0 font-mono text-[10.5px] tabular-nums ${
                        active
                          ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Sales High-Frequency Quick-Query Playbook (Replaces Truncated Raw Filenames) */}
          <div className="mt-3.5 border-t border-border/75 pt-3">
            <div className="mb-1.5 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold text-foreground">业务高频速查</span>
              <span className="text-[10.5px] text-muted-foreground">一键问口径</span>
            </div>
            <div className="divide-y divide-border/50 px-1">
              {quickScenarios.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  disabled={asking}
                  onClick={() => void ask(item.prompt)}
                  className="group flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-card disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground group-hover:text-indigo-700 dark:group-hover:text-indigo-300">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
                      {item.subtitle}
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
                </button>
              ))}
            </div>
            {activeCatDocCount > 0 ? (
              <div className="mt-2.5 px-2">
                <Link
                  to="/knowledge"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  浏览「{activeCatLabel}」{activeCatDocCount} 篇完整原文 →
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      {/* Center: AI Q&A conversation */}
      <section className="flex min-w-0 flex-col overflow-hidden border-b border-border xl:border-b-0 xl:border-r">
        <div className="flex items-center justify-between border-b border-border/80 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <span className="text-sm font-semibold">AI 知识与口径问答</span>
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
