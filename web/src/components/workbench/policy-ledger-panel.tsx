import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type {
  GuardSelftestResult,
  ProjectGuardrailRedline,
  ProjectPolicyCategory,
  ProjectPolicyDto,
  WorkbenchConfigDto,
} from '@/types';

const CATEGORY_LABELS: Record<ProjectPolicyCategory, string> = {
  moq: '起订量 MOQ',
  pricing: '价格与报价',
  samples: '样品政策',
  lead_time: '打样与大货交期',
  payment: '付款条款',
  shipping: '运输与贸易条款',
  material: '材质与工艺',
  quality: '质检与公差',
  compliance: '合规与认证',
  company: '公司与工厂',
  other: '其他',
};

export function PolicyLedgerPanel({ canManage }: { canManage: boolean }): React.JSX.Element {
  const [policies, setPolicies] = React.useState<ProjectPolicyDto[]>([]);
  const [config, setConfig] = React.useState<WorkbenchConfigDto | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [filterMode, setFilterMode] = React.useState<'all' | 'unconfirmed' | 'internal'>('all');
  const [selftest, setSelftest] = React.useState<GuardSelftestResult | null>(null);
  const [runningSelftest, setRunningSelftest] = React.useState(false);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProjectPolicyDto | null>(null);
  const [form, setForm] = React.useState({
    code: '',
    topic: '',
    category: 'other' as ProjectPolicyCategory,
    scope: '',
    valueZh: '',
    valueEn: '',
    external: true,
    confirmed: true,
    conflictNote: '',
    source: '',
    ownerRole: 'Management',
  });

  const [newRuleText, setNewRuleText] = React.useState('');
  const [newRedline, setNewRedline] = React.useState({ pattern: '', message: '', severity: 'bad' as 'bad' | 'warn' });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [polRows, cfg] = await Promise.all([
        apiGet<ProjectPolicyDto[]>('/workbench/policies'),
        apiGet<WorkbenchConfigDto>('/workbench/config'),
      ]);
      setPolicies(polRows);
      setConfig(cfg);
    } catch (e) {
      toast.error(toErrorMessage(e, '对外口径加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const unconfirmedCount = policies.filter((p) => !p.confirmed).length;

  const visiblePolicies = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return policies.filter((p) => {
      if (filterMode === 'unconfirmed' && p.confirmed) return false;
      if (filterMode === 'internal' && p.external) return false;
      if (!q) return true;
      return [p.code, p.topic, p.valueZh, p.valueEn, p.scope, p.conflictNote].join(' ').toLowerCase().includes(q);
    });
  }, [policies, filterMode, search]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      code: '',
      topic: '',
      category: 'other',
      scope: '',
      valueZh: '',
      valueEn: '',
      external: true,
      confirmed: true,
      conflictNote: '',
      source: '',
      ownerRole: 'Management',
    });
    setDialogOpen(true);
  };

  const openEdit = (p: ProjectPolicyDto) => {
    setEditing(p);
    setForm({
      code: p.code,
      topic: p.topic,
      category: p.category,
      scope: p.scope,
      valueZh: p.valueZh,
      valueEn: p.valueEn,
      external: p.external,
      confirmed: p.confirmed,
      conflictNote: p.conflictNote,
      source: p.source,
      ownerRole: p.ownerRole || 'Management',
    });
    setDialogOpen(true);
  };

  const savePolicy = async () => {
    if (!form.topic.trim() || !form.valueZh.trim()) {
      toast.error('请填写主题和中文内部口径');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await apiPut(`/workbench/policies/${editing.id}`, {
          topic: form.topic,
          category: form.category,
          scope: form.scope,
          valueZh: form.valueZh,
          valueEn: form.valueEn,
          external: form.external,
          confirmed: form.confirmed,
          conflictNote: form.conflictNote,
          source: form.source,
          ownerRole: form.ownerRole,
        });
        toast.success('口径已更新');
      } else {
        if (!form.code.trim()) {
          toast.error('请填写口径编号（如 P-MOQ）');
          return;
        }
        await apiPost('/workbench/policies', form);
        toast.success('口径已创建');
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast.error(toErrorMessage(e, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const toggleExternal = async (p: ProjectPolicyDto, next: boolean) => {
    try {
      const updated = await apiPut<ProjectPolicyDto>(`/workbench/policies/${p.id}`, { external: next });
      setPolicies((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      toast.success(next ? `「${p.topic}」已设为可对外引用` : `「${p.topic}」已设为仅内部（AI 不再外泄数字）`);
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const confirmPolicy = async (p: ProjectPolicyDto) => {
    try {
      const updated = await apiPost<ProjectPolicyDto>(`/workbench/policies/${p.id}/confirm`, {});
      setPolicies((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      toast.success(`「${p.topic}」已拍板确认`);
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const removePolicy = async (p: ProjectPolicyDto) => {
    try {
      await apiDelete(`/workbench/policies/${p.id}`);
      setPolicies((prev) => prev.filter((x) => x.id !== p.id));
      toast.success('已删除口径');
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const seedPreset = async (preset: 'genesis' | 'general') => {
    setBusy(true);
    try {
      const res = await apiPost<{ policiesInserted: number; policiesSkipped: number; redlinesAdded: number }>(
        '/workbench/policies/seed-preset',
        { preset },
      );
      toast.success(`已导入 ${res.policiesInserted} 条口径、${res.redlinesAdded} 条红线（跳过已有 ${res.policiesSkipped} 条）`);
      await load();
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const updatePricingMode = async (pricingMode: 'catalog_tiered' | 'costing_approved') => {
    setBusy(true);
    try {
      const updated = await apiPut<WorkbenchConfigDto>('/workbench/config', { pricingMode });
      setConfig(updated);
      toast.success(pricingMode === 'costing_approved' ? '已切换为「非标定制 · 核算员审批核价」模式' : '已切换为「标准目录 · 阶梯价毛利测算」模式');
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addWritingRule = async () => {
    if (!config || !newRuleText.trim()) return;
    setBusy(true);
    try {
      const updated = await apiPut<WorkbenchConfigDto>('/workbench/config', {
        teamWritingRules: [
          ...config.teamWritingRules,
          { id: `rule-${Date.now()}`, text: newRuleText.trim(), enabled: true, source: '人工录入' },
        ],
      });
      setConfig(updated);
      setNewRuleText('');
      toast.success('团队写作规则已保存');
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const removeWritingRule = async (id: string) => {
    if (!config) return;
    const updated = await apiPut<WorkbenchConfigDto>('/workbench/config', {
      teamWritingRules: config.teamWritingRules.filter((r) => r.id !== id),
    });
    setConfig(updated);
  };

  const addRedline = async () => {
    if (!config || !newRedline.pattern.trim() || !newRedline.message.trim()) return;
    setBusy(true);
    try {
      const next: ProjectGuardrailRedline[] = [
        ...config.guardrailRedlines,
        {
          id: `rl-${Date.now()}`,
          pattern: newRedline.pattern.trim(),
          message: newRedline.message.trim(),
          severity: newRedline.severity,
          enabled: true,
        },
      ];
      const updated = await apiPut<WorkbenchConfigDto>('/workbench/config', { guardrailRedlines: next });
      setConfig(updated);
      setNewRedline({ pattern: '', message: '', severity: 'bad' });
      toast.success('红线规则已添加');
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const removeRedline = async (id: string) => {
    if (!config) return;
    const updated = await apiPut<WorkbenchConfigDto>('/workbench/config', {
      guardrailRedlines: config.guardrailRedlines.filter((r) => r.id !== id),
    });
    setConfig(updated);
  };

  const runSelftest = async () => {
    setRunningSelftest(true);
    try {
      const res = await apiGet<GuardSelftestResult>('/workbench/guardrails/selftest');
      setSelftest(res);
      toast.success(`护栏自检完成：${res.passed}/${res.total} 通过`);
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setRunningSelftest(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />正在加载项目对外口径与红线配置…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top toolbar & project pricing mode */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">结构化对外口径表（{policies.length} 条）</CardTitle>
                <CardDescription>
                  AI 与知识库秒回只引用「可对外 = 是」的条目；数字必须来源于此表或本案已批准报价单。
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
                {canManage ? (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void seedPreset('genesis')}>
                      <Download className="h-3.5 w-3.5" />导入 Genesis V6 预置
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void seedPreset('general')}>
                      导入通用预置
                    </Button>
                    <Button size="sm" onClick={openCreate}><Plus className="h-3.5 w-3.5" />新增口径</Button>
                  </>
                ) : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索口径编号、主题、中英文措辞…"
                className="max-w-xs"
              />
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
                <button type="button" onClick={() => setFilterMode('all')} className={`rounded px-2.5 py-1 ${filterMode === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  全部 ({policies.length})
                </button>
                <button type="button" onClick={() => setFilterMode('unconfirmed')} className={`rounded px-2.5 py-1 ${filterMode === 'unconfirmed' ? 'bg-destructive text-destructive-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  待拍板 ({unconfirmedCount})
                </button>
                <button type="button" onClick={() => setFilterMode('internal')} className={`rounded px-2.5 py-1 ${filterMode === 'internal' ? 'bg-amber-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                  仅内部 ({policies.filter((p) => !p.external).length})
                </button>
              </div>
            </div>

            {visiblePolicies.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                暂无口径记录。管理员可点击右上角「导入 Genesis V6 预置」或「新增口径」。
              </div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {visiblePolicies.map((p) => (
                  <div key={p.id} className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between ${!p.external ? 'bg-muted/30' : ''}`}>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="font-mono text-[11px]">{p.code}</Badge>
                        <span className="text-sm font-semibold">{p.topic}</span>
                        <Badge variant="secondary" className="text-[10px]">{CATEGORY_LABELS[p.category]}</Badge>
                        {!p.confirmed ? (
                          <Badge variant="destructive" className="text-[10px]">待老板拍板</Badge>
                        ) : (
                          <Badge variant="outline" className="border-emerald-300 text-[10px] text-emerald-700 dark:text-emerald-300">已确认</Badge>
                        )}
                        {!p.external ? <Badge variant="warning" className="text-[10px]">仅内部</Badge> : null}
                      </div>
                      <p className="text-xs leading-relaxed text-foreground/90">{p.valueZh}</p>
                      {p.valueEn ? (
                        <p className="rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">EN: {p.valueEn}</p>
                      ) : null}
                      {p.conflictNote ? (
                        <p className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3 shrink-0" />冲突/旧口径提醒：{p.conflictNote}
                        </p>
                      ) : null}
                    </div>
                    {canManage ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch checked={p.external} onCheckedChange={(v) => void toggleExternal(p, v)} />
                          可对外
                        </label>
                        {!p.confirmed ? (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void confirmPolicy(p)}>
                            <CheckCircle2 className="h-3 w-3" />拍板
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(p)}>编辑</Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => void removePolicy(p)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right rail: Pricing mode + Guardrail Selftest + Writing Rules */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">项目报价核价模式</CardTitle>
              <CardDescription className="text-xs">决定「报价与 RFQ 工作台」默认视图与金额护栏策略</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Select
                disabled={!canManage || busy}
                value={config?.pricingMode ?? 'catalog_tiered'}
                onValueChange={(v) => void updatePricingMode(v as 'catalog_tiered' | 'costing_approved')}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="catalog_tiered">标准目录阶梯价（实时毛利测算）</SelectItem>
                  <SelectItem value="costing_approved">非标定制 RFQ（核算员审批核价）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {config?.pricingMode === 'costing_approved'
                  ? '适用于 Genesis 定制包装等非标业务：价格仅由核算员回填批准行，AI 严禁自行算价或估算毛利。'
                  : '适用于标准 SKU / 器材类目：支持产品目录自动匹配阶梯单价并实时测算毛利率与历史价对照。'}
              </p>
            </CardContent>
          </Card>

          {canManage ? (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    <ShieldCheck className="h-4 w-4 text-primary" />发信规则自检（管理员）
                  </CardTitle>
                  <Button size="sm" variant="outline" className="h-7 text-xs" loading={runningSelftest} onClick={() => void runSelftest()}>
                    <Play className="h-3 w-3" />运行自检
                  </Button>
                </div>
                <CardDescription className="text-xs">快速验证当前项目禁用红线与对外口径规则是否生效</CardDescription>
              </CardHeader>
              <CardContent>
                {!selftest ? (
                  <p className="text-xs text-muted-foreground">点击「运行自检」检测当前项目规则配置。</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-2 text-xs">
                      <span className="font-medium">通过率：{selftest.passed} / {selftest.total}</span>
                      <Badge variant={selftest.failed === 0 ? 'outline' : 'destructive'}>
                        {selftest.failed === 0 ? '全部通过' : `${selftest.failed} 项未通过`}
                      </Badge>
                    </div>
                    <details className="text-[11px]">
                      <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">查看明细（{selftest.results.length} 项）</summary>
                      <div className="mt-1.5 max-h-56 space-y-1 overflow-y-auto pr-1">
                        {selftest.results.map((r) => (
                          <div key={r.name} className={`rounded border px-2 py-1 ${r.ok ? 'border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'}`}>
                            <div className="flex items-center justify-between gap-1 font-medium">
                              <span className="truncate">{r.name}</span>
                              <span>{r.ok ? '✓' : '✗'}</span>
                            </div>
                            <p className="truncate text-muted-foreground">{r.got[0]}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">团队写作规则（{config?.teamWritingRules.length ?? 0}）</CardTitle>
              <CardDescription className="text-xs">支持终稿修改自动反哺，每次起草自动注入</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {canManage ? (
                <div className="flex gap-1.5">
                  <Input value={newRuleText} onChange={(e) => setNewRuleText(e.target.value)} placeholder="例如：首轮回复最多问 2 个问题…" className="h-8 text-xs" />
                  <Button size="sm" className="h-8" disabled={busy || !newRuleText.trim()} onClick={() => void addWritingRule()}>添加</Button>
                </div>
              ) : null}
              <ul className="space-y-1.5 text-xs">
                {(config?.teamWritingRules ?? []).map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2 rounded border border-border px-2 py-1.5">
                    <span className="leading-relaxed">{r.text}</span>
                    {canManage ? (
                      <button type="button" onClick={() => void removeWritingRule(r.id)} className="shrink-0 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
                {(config?.teamWritingRules.length ?? 0) === 0 ? (
                  <li className="text-muted-foreground">暂无自定义写作规则</li>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Redlines Management */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <ShieldAlert className="h-4 w-4 text-destructive" />品牌作废口径与红线拦截规则（{config?.guardrailRedlines.length ?? 0} 条）
          </CardTitle>
          <CardDescription className="text-xs">
            红色（必须改）触发后自动让 AI 修正一次并阻断直接放行；黄色（提醒）供业务员发前复核。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {canManage ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto]">
              <Input value={newRedline.pattern} onChange={(e) => setNewRedline((s) => ({ ...s, pattern: e.target.value }))} placeholder="正则模式（如 BSCI[- ]certified）" className="h-8 font-mono text-xs" />
              <Input value={newRedline.message} onChange={(e) => setNewRedline((s) => ({ ...s, message: e.target.value }))} placeholder="拦截原因与正确写法提示" className="h-8 text-xs" />
              <Select value={newRedline.severity} onValueChange={(v) => setNewRedline((s) => ({ ...s, severity: v as 'bad' | 'warn' }))}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bad">红线（必须改）</SelectItem>
                  <SelectItem value="warn">提醒（黄色）</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8" disabled={busy || !newRedline.pattern.trim() || !newRedline.message.trim()} onClick={() => void addRedline()}>添加红线</Button>
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {(config?.guardrailRedlines ?? []).map((rule) => (
              <div key={rule.id} className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-xs">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={rule.severity === 'bad' ? 'destructive' : 'warning'} className="text-[10px]">
                      {rule.severity === 'bad' ? '严禁使用' : '发前提醒'}
                    </Badge>
                    <p className="font-medium text-foreground">{rule.message}</p>
                  </div>
                  {canManage ? (
                    <code className="block truncate rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{rule.pattern}</code>
                  ) : null}
                </div>
                {canManage ? (
                  <button type="button" aria-label="删除红线" onClick={() => void removeRedline(rule.id)} className="shrink-0 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit Policy Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑口径 · ${editing.code}` : '新增对外口径'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>口径编号</Label>
                <Input disabled={Boolean(editing)} value={form.code} onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} placeholder="如 P-MOQ" className="mt-1 font-mono" />
              </div>
              <div>
                <Label>分类</Label>
                <Select value={form.category} onValueChange={(v) => setForm((s) => ({ ...s, category: v as ProjectPolicyCategory }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([k, lbl]) => <SelectItem key={k} value={k}>{lbl}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>主题</Label>
                <Input value={form.topic} onChange={(e) => setForm((s) => ({ ...s, topic: e.target.value }))} placeholder="如 起订量" className="mt-1" />
              </div>
              <div>
                <Label>适用场景</Label>
                <Input value={form.scope} onChange={(e) => setForm((s) => ({ ...s, scope: e.target.value }))} placeholder="如 客户问起订量时" className="mt-1" />
              </div>
            </div>
            <div>
              <Label>中文内部口径（必填）</Label>
              <Textarea value={form.valueZh} onChange={(e) => setForm((s) => ({ ...s, valueZh: e.target.value }))} rows={2} className="mt-1" />
            </div>
            <div>
              <Label>英文标准对外措辞</Label>
              <Textarea value={form.valueEn} onChange={(e) => setForm((s) => ({ ...s, valueEn: e.target.value }))} rows={2} className="mt-1" placeholder="留空表示仅内部使用，AI 不会引用数字" />
            </div>
            <div>
              <Label>历史冲突 / 作废口径备注</Label>
              <Input value={form.conflictNote} onChange={(e) => setForm((s) => ({ ...s, conflictNote: e.target.value }))} placeholder="如 旧版 500 件已作废" className="mt-1" />
            </div>
            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={form.external} onCheckedChange={(v) => setForm((s) => ({ ...s, external: v }))} />允许对外引用
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={form.confirmed} onCheckedChange={(v) => setForm((s) => ({ ...s, confirmed: v }))} />老板已拍板确认
              </label>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button loading={busy} onClick={() => void savePolicy()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
