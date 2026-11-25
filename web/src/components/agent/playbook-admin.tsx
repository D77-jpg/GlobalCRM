import * as React from 'react';
import { Braces, CheckCircle2, Download, FileUp, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiDelete, apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { createClientId } from '@/lib/utils';
import { useProjectStore } from '@/store/project.store';
import type { ProjectApprovedOffer, ProjectIndustryRule } from '@/types';

interface Card {
  id: string; kind?: 'segment' | 'preference'; name: string; signals: string; products: string;
  logic: string; avoid: string; cta: string; prepare: string; check: string; subjects: string[]; keywords?: string[];
}
interface PlaybookState {
  version: number; source: 'builtin' | 'imported'; segments: Card[]; preferences: Card[]; updatedAt?: string | Date | null;
  projectKey?: string; projectLabel?: string;
  brandRelease?: string; canRollback?: boolean;
}

interface PackagePreview {
  projectName: string;
  expectedVersion: number;
  release: string;
  brandKey: string;
  signatureTitle: string | null;
  cardCount: number;
  diff?: { addedCards: number; updatedCards: number; removedCards: number };
}

function CardPreview({ title, cards }: { title: string; cards: Card[] }): React.JSX.Element | null {
  if (!cards.length) return null;
  return <details className="rounded-lg border" open>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-medium">
      <span>{title}</span><span className="text-xs font-normal text-muted-foreground">{cards.length} 张</span>
    </summary>
    <div className="max-h-[360px] divide-y overflow-y-auto border-t">
      {cards.map((card) => <article key={card.id} className="grid gap-1.5 p-3 text-xs sm:grid-cols-[8rem_1fr]">
        <div><Badge variant="outline" className="font-mono">{card.id}</Badge><p className="mt-1 font-medium text-foreground">{card.name}</p></div>
        <div className="space-y-1 text-muted-foreground">
          <p><span className="text-foreground/70">信号：</span>{card.signals || '—'} · <span className="text-foreground/70">产品：</span>{card.products || '—'}</p>
          <p><span className="text-foreground/70">逻辑：</span>{card.logic || '—'}</p>
          <p><span className="text-foreground/70">CTA：</span>{card.cta || '—'}</p>
        </div>
      </article>)}
    </div>
  </details>;
}

const example: Card[] = [
  {
    id: 'CUSTOM-I01', kind: 'segment', name: '项目专属细分客户', signals: 'customer website signal', products: 'product category',
    logic: '只写由客户事实支持、且项目已批准的价值逻辑', avoid: '不写未批准的价格、MOQ、认证或交期',
    cta: 'Would a short spec sheet help you compare options?', prepare: '规格表、实物样或项目案例', check: '内部注意事项，不进入客户正文', subjects: ['A relevant subject for [Brand]'], keywords: ['keyword-from-customer-site'],
  },
  {
    id: 'CUSTOM-P01', kind: 'preference', name: '项目专属采购偏好', signals: 'quality / total cost / lead time', products: '',
    logic: '用客户已表达的标准排序，不猜预算', avoid: '不把偏好写成承诺', cta: '与客户当前评估标准对应的低负担下一步',
    prepare: '可按偏好比较的资料', check: '', subjects: [], keywords: [],
  },
];

export function PlaybookAdmin(): React.JSX.Element {
  const [state, setState] = React.useState<PlaybookState | null>(null);
  const [text, setText] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [preview, setPreview] = React.useState<PackagePreview | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiGet<PlaybookState>('/agent/playbooks');
      setState(data);
      setText(JSON.stringify([...data.segments.map((card) => ({ ...card, kind: 'segment' })), ...data.preferences.map((card) => ({ ...card, kind: 'preference' }))], null, 2));
    } catch (reason) { setError(toErrorMessage(reason, '行业卡加载失败')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function exportCurrentPackage() {
    setSaving(true); setError('');
    try {
      const pkg = await apiGet<Record<string, unknown>>('/agent/playbooks/brand-package/export');
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `brand-package-${state?.projectKey ?? 'project'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('当前项目品牌包已导出');
    } catch (reason) {
      setError(toErrorMessage(reason, '导出品牌包失败'));
    } finally {
      setSaving(false);
    }
  }

  function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setText(reader.result);
        setPreview(null);
        toast.info(`已载入文件 ${file.name}，请点击「校验并导入」预览差异`);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  async function save() {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const parsed = JSON.parse(text || '[]');
      if (!Array.isArray(parsed)) {
        if (!preview) {
          setPreview(await apiPost<PackagePreview>('/agent/playbooks/brand-package/preview', parsed));
          return;
        }
        await apiPut('/agent/playbooks/brand-package', { bundle: parsed, expectedVersion: preview.expectedVersion });
        setPreview(null);
        await useProjectStore.getState().initialize(true);
        toast.success('品牌包已应用到当前项目，签名与话术已立即生效');
        await load();
        return;
      }
      const rows = parsed as Card[];
      const cards = rows.map((card) => ({ ...card, kind: card.kind ?? 'segment', subjects: card.subjects ?? [], keywords: card.keywords ?? [] }));
      await apiPut('/agent/playbooks', { cards });
      toast.success('行业卡已导入；下一封开发信会使用该项目的卡片');
      await load();
    } catch (reason) { setError(toErrorMessage(reason, '行业卡导入失败')); }
    finally { setSaving(false); }
  }

  async function rollback() {
    if (saving || !state) return;
    setSaving(true); setError('');
    try {
      await apiPost('/agent/playbooks/brand-package/rollback', { expectedVersion: state.version });
      setPreview(null);
      await useProjectStore.getState().initialize(true);
      toast.success('已恢复上一版本，项目配置已同步');
      await load();
    } catch (reason) { setError(toErrorMessage(reason, '品牌包回退失败')); }
    finally { setSaving(false); }
  }

  async function clear() {
    if (saving || !window.confirm('清除本项目已导入的行业卡？清除后会回退到内置卡片。')) return;
    setSaving(true); setError('');
    try { await apiDelete('/agent/playbooks'); toast.success('已回退到内置卡片'); await load(); }
    catch (reason) { setError(toErrorMessage(reason, '清除失败')); }
    finally { setSaving(false); }
  }

  return <div className="space-y-4 p-4">
    <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFileUpload} />
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Braces className="h-5 w-5 text-primary" />行业卡与品牌包</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">行业卡与品牌包只影响写作策略和签名模板，不作为事实证据。支持导出/导入私有品牌包，变更即时同步到发信编辑器。</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => { setPreview(null); void load(); }} disabled={loading || saving}><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新</Button>
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={saving}><FileUp className="h-4 w-4" />载入 JSON 文件</Button>
        <Button variant="outline" size="sm" onClick={() => void exportCurrentPackage()} disabled={loading || saving}><Download className="h-4 w-4" />导出品牌包</Button>
        {state?.canRollback && <Button variant="outline" size="sm" onClick={() => void rollback()} disabled={saving}>恢复上一版本</Button>}
        {state?.source === 'imported' && !state.brandRelease && <Button variant="outline" size="sm" onClick={() => void clear()} disabled={saving}><Trash2 className="h-4 w-4" />回退内置</Button>}
        <Button size="sm" onClick={() => void save()} disabled={saving || !text.trim()}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{preview ? '确认应用品牌包' : '校验并导入'}</Button>
      </div>
    </header>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {preview && <p role="status" className="rounded-md border bg-muted/20 p-3 text-sm">
      目标项目 {preview.projectName} · {preview.brandKey} · 版本 {preview.release} · 共 {preview.cardCount} 张卡
      {preview.diff ? `（新增 ${preview.diff.addedCards} / 更新 ${preview.diff.updatedCards} / 移除 ${preview.diff.removedCards}）` : ''}
      {preview.signatureTitle ? ` · ${preview.signatureTitle}` : ''}
    </p>}
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
      <Badge variant={state?.source === 'imported' ? 'developed' : 'secondary'}>{state?.source === 'imported' ? '本项目已导入' : '使用通用/内置卡片'}</Badge>
      <span className="text-xs text-muted-foreground">{state?.projectLabel ? `${state.projectLabel} · ` : ''}版本 {state?.version ?? 0} · 行业卡 {state?.segments.length ?? 0} · 偏好卡 {state?.preferences.length ?? 0}{state?.updatedAt ? ` · ${formatDateTime(state.updatedAt)}` : ''}</span>
      <span className="ml-auto text-xs text-muted-foreground">只导入策略文本，不导入示例邮件正文；卡片中的数字不会被当作已确认事实。</span>
    </div>
    {!loading && state && (state.segments.length > 0 || state.preferences.length > 0) && <div className="grid gap-3 lg:grid-cols-2"><CardPreview title="行业卡预览" cards={state.segments} /><CardPreview title="偏好卡预览" cards={state.preferences} /></div>}
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">品牌包或卡片 JSON（segment / preference）</p><Button variant="ghost" size="sm" onClick={() => setText(JSON.stringify(example, null, 2))}><Braces className="h-4 w-4" />载入格式示例</Button></div>
      <Textarea aria-label="品牌包或卡片 JSON" className="min-h-[440px] font-mono text-xs" value={text} onChange={(event) => { setText(event.target.value); setPreview(null); }} disabled={loading || saving} placeholder="粘贴版本化品牌包，或包含 id、kind、name 的卡片数组。" />
      <p className="mt-2 text-xs text-muted-foreground">每个项目独立存储。导入后不会修改知识库事实、报价或已生成草稿；重新生成开发信时才生效。上方预览展示当前实际生效的卡片，JSON 可查看全部字段。</p>
    </div>
    {!loading && state?.source === 'builtin' && <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground"><CheckCircle2 className="h-4 w-4" />{state.segments.length || state.preferences.length ? '当前项目正在使用兼容卡片；可导出并作为独立私有品牌包维护。' : '当前项目没有内置卡片；可载入私有品牌包 JSON 导入本项目。'}</div>}
    <ProjectOfferAndRuleEditor />
  </div>;
}

const OFFER_CATEGORIES: { value: ProjectApprovedOffer['category']; label: string }[] = [
  { value: 'spec_sheet', label: '规格对比表' },
  { value: 'drawing', label: '结构示意/刀版' },
  { value: 'swatch', label: '色卡/面料卡' },
  { value: 'sample', label: '实物样品' },
  { value: 'quote_range', label: '参考价区间' },
  { value: 'other', label: '其他小提议' },
];

function ProjectOfferAndRuleEditor(): React.JSX.Element | null {
  const project = useProjectStore((s) => s.activeProject);
  const [offers, setOffers] = React.useState<ProjectApprovedOffer[]>([]);
  const [rules, setRules] = React.useState<ProjectIndustryRule[]>([]);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setOffers(project?.brandProfile?.approvedOffers ?? []);
    setRules(project?.brandProfile?.industryRules ?? []);
  }, [project?.id, project?.brandProfile?.approvedOffers, project?.brandProfile?.industryRules]);

  if (!project) return null;

  async function persistPolicy() {
    if (!project) return;
    setSaving(true);
    try {
      const cleanedOffers = offers
        .map((o) => ({ ...o, label: o.label.trim(), actionText: o.actionText.trim(), conditions: o.conditions?.trim() || undefined }))
        .filter((o) => o.label && o.actionText);
      const cleanedRules = rules
        .map((r) => ({
          ...r,
          code: r.code.trim(),
          name: r.name.trim(),
          keywords: r.keywords.map((k) => k.trim()).filter(Boolean),
          requiredPattern: r.requiredPattern?.trim() || undefined,
          excludedPattern: r.excludedPattern?.trim() || undefined,
        }))
        .filter((r) => r.code && r.name);
      await apiPut(`/projects/${project.id}`, {
        brandProfile: {
          ...(project.brandProfile ?? {}),
          approvedOffers: cleanedOffers,
          industryRules: cleanedRules,
        },
      });
      await useProjectStore.getState().initialize(true);
      toast.success('项目级授权小提议与行业判断规则已保存');
    } catch (reason) {
      toast.error('保存失败', { description: toErrorMessage(reason, '请检查字段格式') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-semibold">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
          项目级小提议授权与行业判断规则
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          已配置 {offers.length} 项小提议 · {rules.length} 条行业规则
        </span>
      </summary>
      <div className="space-y-4 border-t p-3 text-xs">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-foreground">逐项授权沟通小提议（发信前自动检查免费/寄样/运费权限）</p>
              <p className="text-muted-foreground">未授权「免费 / 运费」或显式关闭「寄样」时，发信前会自动拦截含对应承诺的草稿。</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOffers((prev) => [...prev, {
                id: `offer-${createClientId().slice(0, 8)}`,
                label: '1 页规格对比表',
                actionText: 'Share a 1-page specification comparison sheet',
                category: 'spec_sheet',
                requiresEvidence: false,
                allowsFree: false,
                allowsSample: false,
                allowsShipping: false,
                enabled: true,
              }])}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              新增授权项
            </Button>
          </div>
          {offers.length === 0 ? (
            <p className="rounded-md border border-dashed p-2.5 text-muted-foreground">暂未配置项目级逐项授权（默认禁止免费/寄样/包运费承诺）。</p>
          ) : (
            <div className="space-y-2">
              {offers.map((offer, idx) => (
                <div key={offer.id} className="space-y-2 rounded-md border bg-muted/15 p-2.5">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      value={offer.label}
                      placeholder="名称（如：寄色卡）"
                      className="h-8 text-xs"
                      onChange={(e) => setOffers((prev) => prev.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))}
                    />
                    <select
                      aria-label="提议类别"
                      value={offer.category}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      onChange={(e) => setOffers((prev) => prev.map((x, i) => i === idx ? { ...x, category: e.target.value as ProjectApprovedOffer['category'] } : x))}
                    >
                      {OFFER_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    <Input
                      value={offer.conditions ?? ''}
                      placeholder="适用条件（如：运费到付）"
                      className="h-8 text-xs"
                      onChange={(e) => setOffers((prev) => prev.map((x, i) => i === idx ? { ...x, conditions: e.target.value } : x))}
                    />
                  </div>
                  <Input
                    value={offer.actionText}
                    placeholder="英文/中文动作描述（供模型参考）"
                    className="h-8 text-xs"
                    onChange={(e) => setOffers((prev) => prev.map((x, i) => i === idx ? { ...x, actionText: e.target.value } : x))}
                  />
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="inline-flex items-center gap-1.5"><Switch checked={offer.enabled} onCheckedChange={(v) => setOffers((p) => p.map((x, i) => i === idx ? { ...x, enabled: v } : x))} />启用</label>
                    <label className="inline-flex items-center gap-1.5"><Switch checked={offer.allowsFree} onCheckedChange={(v) => setOffers((p) => p.map((x, i) => i === idx ? { ...x, allowsFree: v } : x))} />允许提「免费」</label>
                    <label className="inline-flex items-center gap-1.5"><Switch checked={offer.allowsSample} onCheckedChange={(v) => setOffers((p) => p.map((x, i) => i === idx ? { ...x, allowsSample: v } : x))} />允许提「寄样」</label>
                    <label className="inline-flex items-center gap-1.5"><Switch checked={offer.allowsShipping} onCheckedChange={(v) => setOffers((p) => p.map((x, i) => i === idx ? { ...x, allowsShipping: v } : x))} />允许提「运费」</label>
                    <label className="inline-flex items-center gap-1.5"><Switch checked={offer.requiresEvidence} onCheckedChange={(v) => setOffers((p) => p.map((x, i) => i === idx ? { ...x, requiresEvidence: v } : x))} />需知识库佐证</label>
                    <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 px-2 text-destructive" onClick={() => setOffers((p) => p.filter((_, i) => i !== idx))}>删除</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-foreground">项目级行业判断规则（适配任意自定义品类）</p>
              <p className="text-muted-foreground">按卡片编码绑定行业关键词规则，帮助系统准确选择切入角度。</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRules((prev) => [...prev, { code: 'CUSTOM-01', name: '自定义行业规则', keywords: [], priority: 5 }])}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              新增行业规则
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="rounded-md border border-dashed p-2.5 text-muted-foreground">暂未配置自定义行业规则（沿用当前品牌包/内置卡片匹配规则）。</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule, idx) => (
                <div key={`${rule.code}-${idx}`} className="grid gap-2 rounded-md border bg-muted/15 p-2.5 sm:grid-cols-[7rem_9rem_1fr_auto]">
                  <Input value={rule.code} placeholder="卡片编码" className="h-8 font-mono text-xs" onChange={(e) => setRules((p) => p.map((x, i) => i === idx ? { ...x, code: e.target.value } : x))} />
                  <Input value={rule.name} placeholder="规则名称" className="h-8 text-xs" onChange={(e) => setRules((p) => p.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))} />
                  <Input
                    value={rule.keywords.join(', ')}
                    placeholder="命中关键词（逗号分隔，如 diagnostic, ivd, medical）"
                    className="h-8 text-xs"
                    onChange={(e) => setRules((p) => p.map((x, i) => i === idx ? { ...x, keywords: e.target.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean) } : x))}
                  />
                  <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-destructive" onClick={() => setRules((p) => p.filter((_, i) => i !== idx))}>删除</Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t pt-3">
          <Button type="button" size="sm" disabled={saving} onClick={() => void persistPolicy()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            保存授权与行业规则
          </Button>
        </div>
      </div>
    </details>
  );
}
