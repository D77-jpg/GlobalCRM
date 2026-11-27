import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileText,
  Loader2,
  Plus,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPatch, apiPost, toErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ROUTES } from '@/constants';
import type {
  CommitmentGrade,
  Customer,
  CustomerWorkbenchItemDto,
  GuardCheckItem,
  WorkbenchItemKind,
  WorkbenchOwnerRole,
} from '@/types';

const SAMPLE_STATUS_LABELS = {
  none: '未申请样品',
  requested: '已询样品',
  making: '打样制作中',
  sent: '样品已寄出',
  approved: '样品已确认',
} as const;

export interface CustomerWorkbenchSidebarProps {
  customer: Customer;
  onPatchCustomer: (patch: { intentScore?: number; sampleStatus?: Customer['sampleStatus'] }) => Promise<void>;
}

export function CustomerWorkbenchSidebar({
  customer,
  onPatchCustomer,
}: CustomerWorkbenchSidebarProps): React.JSX.Element {
  const [items, setItems] = React.useState<CustomerWorkbenchItemDto[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [newKind, setNewKind] = React.useState<WorkbenchItemKind>('open_question');
  const [newTitle, setNewTitle] = React.useState('');
  const [newOwner, setNewOwner] = React.useState<WorkbenchOwnerRole>('Sales');
  const [newGrade, setNewGrade] = React.useState<CommitmentGrade>('B');
  const [saving, setSaving] = React.useState(false);

  const [resultDraft, setResultDraft] = React.useState<Record<string, string>>({});
  const [updateDraftDialog, setUpdateDraftDialog] = React.useState<{ body: string; zh: string; guards: GuardCheckItem[] } | null>(null);
  const [draftingItemId, setDraftingItemId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiGet<CustomerWorkbenchItemDto[]>('/workbench/items', { params: { customerId: customer.id } });
      setItems(rows);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [customer.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openQuestions = items.filter((i) => i.kind === 'open_question' && i.status !== 'dismissed');
  const unresolvedCount = openQuestions.filter((i) => i.status !== 'resolved').length;
  const commitments = items.filter((i) => i.kind === 'commitment' && i.status !== 'dismissed');
  const internalTasks = items.filter((i) => i.kind === 'internal_task' && i.status !== 'dismissed');

  // Compute deterministic fallback intent score if not manually set
  const computedIntentScore = React.useMemo(() => {
    if (typeof customer.intentScore === 'number') return customer.intentScore;
    const baseMap: Record<string, number> = {
      pending: 20, contacted: 35, replied: 55, interested: 72, quoting: 80, negotiating: 88, won: 100, lost: 5,
    };
    let s = baseMap[customer.status] ?? 30;
    if (customer.priority === 'high') s += 10;
    if (customer.expectedQuantity) s += 5;
    if (customer.targetPrice) s += 5;
    return Math.min(100, s);
  }, [customer]);

  const addItem = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      await apiPost('/workbench/items', {
        customerId: customer.id,
        kind: newKind,
        title: newTitle.trim(),
        ownerRole: newOwner,
        ...(newKind === 'commitment' ? { grade: newGrade } : {}),
      });
      setNewTitle('');
      toast.success('已添加到客户作战清单');
      await load();
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleResolve = async (item: CustomerWorkbenchItemDto) => {
    const nextStatus = item.status === 'resolved' ? 'open' : 'resolved';
    try {
      const updated = await apiPatch<CustomerWorkbenchItemDto>(`/workbench/items/${item.id}`, { status: nextStatus });
      setItems((prev) => prev.map((x) => (x.id === item.id ? updated : x)));
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const saveResultAndDraftUpdate = async (item: CustomerWorkbenchItemDto) => {
    const note = (resultDraft[item.id] ?? item.resultNote ?? '').trim();
    if (!note) {
      toast.error('请先填写内部核实结果');
      return;
    }
    setDraftingItemId(item.id);
    try {
      const updated = await apiPatch<CustomerWorkbenchItemDto>(`/workbench/items/${item.id}`, { resultNote: note });
      setItems((prev) => prev.map((x) => (x.id === item.id ? updated : x)));
      const res = await apiPost<{ body: string; zh: string; guards: GuardCheckItem[] }>(`/workbench/items/${item.id}/draft-update`, {});
      setUpdateDraftDialog(res);
    } catch (e) {
      toast.error(toErrorMessage(e, '起草买家更新失败'));
    } finally {
      setDraftingItemId(null);
    }
  };

  const removeItem = async (id: string) => {
    try {
      await apiDelete(`/workbench/items/${id}`);
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const ringStroke = 2 * Math.PI * 26;
  const ringOffset = ringStroke * (1 - computedIntentScore / 100);

  return (
    <aside className="space-y-4">
      {/* Intent Score + Sample Status + Quick Quote */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />客户 360° 意向与商机摘要
          </CardTitle>
          <CardDescription className="text-xs">实时追踪成交意向、打样进度与未决事项</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <div className="flex items-center gap-4">
            <div className="relative flex h-[76px] w-[76px] shrink-0 items-center justify-center">
              <svg className="h-[76px] w-[76px] -rotate-90" viewBox="0 0 64 64" aria-hidden>
                <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeWidth="5.5" className="text-muted" />
                <circle
                  cx="32"
                  cy="32"
                  r="26"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="5.5"
                  strokeDasharray={ringStroke}
                  strokeDashoffset={ringOffset}
                  strokeLinecap="round"
                  className={computedIntentScore >= 75 ? 'text-foreground' : computedIntentScore >= 45 ? 'text-amberx' : 'text-muted-foreground'}
                />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-base font-bold leading-none tabular-nums text-foreground">{computedIntentScore}</span>
                <span className="mt-0.5 text-[9.5px] font-medium text-muted-foreground">健康度</span>
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {computedIntentScore >= 75 ? '高意向客户' : computedIntentScore >= 45 ? '中等跟进中' : '早期线索'}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={computedIntentScore}
                  onBlur={(e) => {
                    const v = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                    if (v !== customer.intentScore) void onPatchCustomer({ intentScore: v });
                  }}
                  className="h-6 w-16 px-1.5 text-right text-xs"
                  title="手动校准 0–100 意向分"
                />
              </div>
              <Select
                value={customer.sampleStatus ?? 'none'}
                onValueChange={(v) => void onPatchCustomer({ sampleStatus: v as Customer['sampleStatus'] })}
              >
                <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SAMPLE_STATUS_LABELS).map(([k, lbl]) => (
                    <SelectItem key={k} value={k}>{lbl}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5 rounded-md bg-muted/40 p-2 text-[11px]">
            <div>
              <span className="text-muted-foreground">预计数量：</span>
              <span className="font-medium">{customer.expectedQuantity || '待确认'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">目标价：</span>
              <span className="font-medium">{customer.targetPrice || '待确认'}</span>
            </div>
          </div>

          <Button variant="outline" size="sm" className="w-full text-xs" asChild>
            <Link to={`${ROUTES.quotations}?customerId=${customer.id}`}>
              <ReceiptText className="h-3.5 w-3.5" />进入报价 / RFQ 工作台
            </Link>
          </Button>
        </CardContent>
      </Card>

      {/* Open Questions + Commitments + Internal Tasks */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <AlertCircle className="h-4 w-4 text-destructive" />未解决问题清单
            </CardTitle>
            <Badge variant={unresolvedCount > 0 ? 'destructive' : 'outline'} className="text-[10px]">
              {unresolvedCount} 待解决
            </Badge>
          </div>
          <CardDescription className="text-xs">防止外贸沟通漏答买家关键工艺/交期/MOQ 问题</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {/* Quick Add */}
          <div className="space-y-1.5 rounded-md border border-border bg-muted/20 p-2">
            <div className="grid grid-cols-2 gap-1.5">
              <Select value={newKind} onValueChange={(v) => setNewKind(v as WorkbenchItemKind)}>
                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open_question">未解决问题</SelectItem>
                  <SelectItem value="commitment">对外承诺事项</SelectItem>
                  <SelectItem value="internal_task">跨部门核实待办</SelectItem>
                </SelectContent>
              </Select>
              <Select value={newOwner} onValueChange={(v) => setNewOwner(v as WorkbenchOwnerRole)}>
                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {([
                    ['Sales', '销售'],
                    ['Costing', '核算'],
                    ['Engineering', '工程'],
                    ['QC', '质检'],
                    ['Logistics', '物流'],
                    ['Customs', '关务'],
                    ['Management', '管理层'],
                  ] as const).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newKind === 'commitment' ? (
              <Select value={newGrade} onValueChange={(v) => setNewGrade(v as CommitmentGrade)}>
                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">已确认事项（可直接答复）</SelectItem>
                  <SelectItem value="B">可告知下一步（已授权）</SelectItem>
                  <SelectItem value="C">需内部核实后再回复</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <div className="flex gap-1.5">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="输入待确认问题、承诺或核实事项…"
                className="h-7 text-xs"
              />
              <Button size="sm" className="h-7 px-2" loading={saving} onClick={() => void addItem()}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-1.5 py-4 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />加载清单…
            </div>
          ) : (
            <>
              {/* Open Questions List */}
              <div className="space-y-1.5">
                {openQuestions.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">暂无未解决问题</p>
                ) : (
                  openQuestions.map((item) => (
                    <div key={item.id} className="space-y-1.5 rounded-md border border-border p-2">
                      <div className="flex items-start gap-2">
                        <button type="button" onClick={() => void toggleResolve(item)} className="mt-0.5 shrink-0">
                          <CheckCircle2 className={`h-4 w-4 ${item.status === 'resolved' ? 'text-emerald-600' : 'text-muted-foreground/40 hover:text-primary'}`} />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className={item.status === 'resolved' ? 'line-through text-muted-foreground' : 'font-medium'}>{item.title}</p>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            <Badge variant="outline" className="px-1 py-0 text-[9px]">
                              {({ Sales: '销售', Costing: '核算', Engineering: '工程', QC: '质检', Logistics: '物流', Customs: '关务', Management: '管理层' } as Record<string, string>)[item.ownerRole] ?? item.ownerRole}
                            </Badge>
                            {item.handling ? (
                              <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                                {({ CHECKING: '待内部核实', ASKED: '待客户确认', ANSWERED: '已回复', DEFERRED: '后续跟进' } as Record<string, string>)[item.handling] ?? item.handling}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <button type="button" onClick={() => void removeItem(item.id)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {item.status !== 'resolved' ? (
                        <div className="flex gap-1 pl-6">
                          <Input
                            value={resultDraft[item.id] ?? item.resultNote ?? ''}
                            onChange={(e) => setResultDraft((p) => ({ ...p, [item.id]: e.target.value }))}
                            placeholder="填入内部核实结果…"
                            className="h-6 text-[11px]"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 shrink-0 px-2 text-[10px]"
                            loading={draftingItemId === item.id}
                            onClick={() => void saveResultAndDraftUpdate(item)}
                          >
                            起草更新
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              {/* Commitments & Internal Tasks */}
              {commitments.length > 0 ? (
                <div className="space-y-1.5 border-t border-border pt-2.5">
                  <p className="flex items-center gap-1 font-semibold">
                    <ShieldCheck className="h-3.5 w-3.5 text-primary" />对外承诺台账 ({commitments.length})
                  </p>
                  {commitments.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-[11px]">
                      <Badge variant={c.grade === 'C' ? 'warning' : 'outline'} className="shrink-0 px-1 py-0 text-[9px]">{c.grade || 'B'}级</Badge>
                      <span className={`min-w-0 flex-1 ${c.status === 'resolved' ? 'line-through text-muted-foreground' : ''}`}>{c.title}</span>
                      <button type="button" onClick={() => void toggleResolve(c)} className="text-muted-foreground hover:text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {internalTasks.length > 0 ? (
                <div className="space-y-1.5 border-t border-border pt-2.5">
                  <p className="flex items-center gap-1 font-semibold">
                    <ClipboardList className="h-3.5 w-3.5 text-amber-600" />跨部门核实待办 ({internalTasks.length})
                  </p>
                  {internalTasks.map((t) => (
                    <div key={t.id} className="space-y-1 rounded border border-border p-2 text-[11px]">
                      <div className="flex items-center justify-between gap-1">
                        <span className={t.status === 'resolved' ? 'line-through text-muted-foreground' : 'font-medium'}>{t.title}</span>
                        <Badge variant="outline" className="text-[9px]">
                          {({ Sales: '销售', Costing: '核算', Engineering: '工程', QC: '质检', Logistics: '物流', Customs: '关务', Management: '管理层' } as Record<string, string>)[t.ownerRole] ?? t.ownerRole}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        <Input
                          value={resultDraft[t.id] ?? t.resultNote ?? ''}
                          onChange={(e) => setResultDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                          placeholder="回填核算/工程结果…"
                          className="h-6 text-[11px]"
                        />
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" loading={draftingItemId === t.id} onClick={() => void saveResultAndDraftUpdate(t)}>
                          起草更新
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Buyer Update Draft Preview Dialog */}
      <Dialog open={Boolean(updateDraftDialog)} onOpenChange={(open) => { if (!open) setUpdateDraftDialog(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-primary" />基于内部核实结果的买家更新草稿
            </DialogTitle>
          </DialogHeader>
          {updateDraftDialog ? (
            <DialogBody className="space-y-3 text-xs">
              <div>
                <p className="mb-1 font-semibold">英文正文（可复制或粘贴至邮件回复）</p>
                <Textarea readOnly value={updateDraftDialog.body} rows={7} className="text-xs" />
              </div>
              <div className="rounded-md bg-muted/50 p-2.5">
                <p className="mb-1 font-semibold">中文核对</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{updateDraftDialog.zh}</p>
              </div>
              <div className="space-y-1">
                {updateDraftDialog.guards.map((g, idx) => (
                  <p key={idx} className={g.severity === 'bad' ? 'text-destructive' : g.severity === 'warn' ? 'text-amber-700' : 'text-emerald-700'}>
                    [{g.severity === 'bad' ? '需修改' : g.severity === 'warn' ? '提醒' : '通过'}] {g.message}
                  </p>
                ))}
              </div>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateDraftDialog(null)}>关闭</Button>
            <Button onClick={() => {
              if (!updateDraftDialog) return;
              void navigator.clipboard.writeText(updateDraftDialog.body)
                .then(() => toast.success('已复制买家更新草稿'))
                .catch(() => toast.error('复制失败，请手动选中文本复制'));
            }}>
              <Copy className="h-3.5 w-3.5" />复制英文草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
