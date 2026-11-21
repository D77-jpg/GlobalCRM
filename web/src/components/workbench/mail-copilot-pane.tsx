import * as React from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Languages,
  Loader2,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiPost, toErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { GuardCheckItem, LearnedCandidate, MultiChannelDraftResult, ReplyScoreResult } from '@/types';

export interface MailCopilotPaneProps {
  mode?: 'mail' | 'multichannel';
  customerId?: string;
  contactName?: string;
  subject?: string;
  inboundText?: string;
  threadText?: string;
  sourceMailId?: string;
  onApplyReply?: (draft: { subject: string; content: string }) => void;
}

const TONE_OPTIONS = [
  { id: 'concise', label: '简洁' },
  { id: 'professional', label: '专业商务' },
  { id: 'friendly', label: '友好' },
  { id: 'formal', label: '正式' },
] as const;

const SCENARIO_OPTIONS = [
  { id: 'auto', label: '自动判断' },
  { id: 'followup', label: '常规跟进' },
  { id: 'inquiry', label: '询盘报价' },
  { id: 'sample_artwork', label: '样品工艺' },
  { id: 'order_logistics', label: '大货物流' },
  { id: 'complaint', label: '售后客诉' },
  { id: 'acknowledgement', label: '简短确认' },
] as const;

type ReplyScenario = (typeof SCENARIO_OPTIONS)[number]['id'];
type DraftKey = 'B' | 'A' | 'K';

export function MailCopilotPane({
  mode = 'mail',
  customerId,
  contactName,
  subject: initialSubject = '',
  inboundText: initialInbound = '',
  threadText = '',
  sourceMailId,
  onApplyReply,
}: MailCopilotPaneProps): React.JSX.Element {
  const [channel, setChannel] = React.useState<'email' | 'whatsapp' | 'alibaba' | 'trademanager' | 'instagram'>('email');
  const [scenario, setScenario] = React.useState<ReplyScenario>('auto');
  const [pasteSubject, setPasteSubject] = React.useState(initialSubject);
  const [pasteText, setPasteText] = React.useState(initialInbound);
  const [instruction, setInstruction] = React.useState('');
  const [attachments, setAttachments] = React.useState<{ name: string; status: 'read' | 'partial' | 'binary' | 'unread'; text?: string; note?: string }[]>([]);

  const [loading, setLoading] = React.useState(false);
  const [rewriting, setRewriting] = React.useState(false);
  const [learning, setLearning] = React.useState(false);
  const [savingItems, setSavingItems] = React.useState(false);
  const [result, setResult] = React.useState<MultiChannelDraftResult | null>(null);
  const [activeVersion, setActiveVersion] = React.useState<DraftKey>('B');
  const [editedSubject, setEditedSubject] = React.useState('');
  const [editedBody, setEditedBody] = React.useState('');
  const [zhPreview, setZhPreview] = React.useState('');
  const [liveScore, setLiveScore] = React.useState<ReplyScoreResult | null>(null);
  const [learned, setLearned] = React.useState<LearnedCandidate[]>([]);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (mode === 'mail') {
      setPasteSubject(initialSubject);
      setPasteText(initialInbound);
      setResult(null);
      setZhPreview('');
      setLiveScore(null);
      setLearned([]);
    }
  }, [mode, initialSubject, initialInbound, sourceMailId]);

  const effectiveInbound = mode === 'mail' ? initialInbound : pasteText;
  const effectiveSubject = mode === 'mail' ? initialSubject : pasteSubject;

  const switchVersion = React.useCallback((key: DraftKey, res: MultiChannelDraftResult | null = result) => {
    if (!res) return;
    setActiveVersion(key);
    const chosen = res.drafts[key];
    setEditedSubject(chosen.subject);
    setEditedBody(chosen.body);
    setLiveScore(chosen.score);
    setZhPreview('');
  }, [result]);

  // Alt+1 / Alt+2 / Alt+3 quick switch between B / A / K
  React.useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === '1') { e.preventDefault(); switchVersion('B', result); }
      else if (e.key === '2') { e.preventDefault(); switchVersion('A', result); }
      else if (e.key === '3') { e.preventDefault(); switchVersion('K', result); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, switchVersion]);

  const generateDrafts = async () => {
    const body = effectiveInbound.trim();
    if (!body) {
      toast.error('请先选择一封邮件或粘贴买家来信内容');
      return;
    }
    setLoading(true);
    try {
      const res = await apiPost<MultiChannelDraftResult>('/workbench/draft-inquiry', {
        customerId,
        channel: mode === 'mail' ? 'email' : channel,
        scenario,
        subject: effectiveSubject,
        inboundText: body,
        threadText: mode === 'mail' ? threadText : undefined,
        contactName,
        inboundAttachments: attachments.length > 0 ? attachments : undefined,
        instruction: instruction.trim() || undefined,
      });
      setResult(res);
      switchVersion(res.duelWinner, res);
      toast.success(res.usedAi ? '三版回复与护栏审稿已生成' : '已基于对外口径生成确定性知识库草稿');
    } catch (e) {
      toast.error(toErrorMessage(e, '起草失败'));
    } finally {
      setLoading(false);
    }
  };

  const recheckGuardrails = async () => {
    if (!editedBody.trim()) return;
    try {
      const res = await apiPost<{ checks: GuardCheckItem[]; score: ReplyScoreResult }>('/workbench/guardrails/check', {
        subject: editedSubject,
        body: editedBody,
        inboundText: effectiveInbound,
        contactName,
        channel: mode === 'mail' ? 'email' : channel,
        threadSubject: effectiveSubject,
      });
      setLiveScore(res.score);
      toast.success(`护栏复检完成：${res.score.score} 分`);
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const rewriteTone = async (tone: 'concise' | 'professional' | 'friendly' | 'formal') => {
    if (!editedBody.trim()) return;
    setRewriting(true);
    try {
      const res = await apiPost<{ body: string; zh: string; score: ReplyScoreResult }>('/workbench/rewrite', {
        subject: editedSubject,
        body: editedBody,
        tone,
        customerId,
        inboundText: effectiveInbound,
      });
      setEditedBody(res.body);
      setZhPreview(res.zh);
      setLiveScore(res.score);
      toast.success('已按所选语气改写并完成护栏检查');
    } catch (e) {
      toast.error(toErrorMessage(e, '语气改写失败'));
    } finally {
      setRewriting(false);
    }
  };

  const persistWorkbenchItems = async () => {
    if (!customerId || !result) {
      toast.error('当前会话尚未关联客户，无法沉淀待办');
      return;
    }
    setSavingItems(true);
    try {
      let count = 0;
      for (const q of result.analysis.openQuestions) {
        if (q.handling === 'CHECKING' || q.handling === 'ASKED') {
          await apiPost('/workbench/items', {
            customerId,
            kind: 'open_question',
            title: q.zh || q.text,
            quote: q.text,
            handling: q.handling,
            ownerRole: q.ownerRole,
            sourceMailId,
          });
          count += 1;
        }
      }
      for (const c of result.analysis.commitments) {
        await apiPost('/workbench/items', {
          customerId,
          kind: 'commitment',
          title: c.zh || c.quote,
          quote: c.quote,
          grade: c.grade,
          ownerRole: c.ownerRole,
          sourceMailId,
        });
        count += 1;
      }
      toast.success(count > 0 ? `已沉淀 ${count} 条未解决问题与承诺到客户档案` : '本次没有新增待核实事项或承诺');
    } catch (e) {
      toast.error(toErrorMessage(e, '沉淀失败'));
    } finally {
      setSavingItems(false);
    }
  };

  const runLearnFromEdit = async () => {
    if (!result) return;
    const originalAi = result.drafts[activeVersion].body;
    if (originalAi.trim() === editedBody.trim()) {
      toast.info('当前草稿尚未修改，改写后再点即可提炼团队经验');
      return;
    }
    setLearning(true);
    try {
      const res = await apiPost<{ summaryZh: string; candidates: LearnedCandidate[]; adoptedCount: number }>(
        '/workbench/learn-from-edit',
        {
          inboundText: effectiveInbound,
          aiDraft: originalAi,
          finalSent: editedBody,
          autoAdoptWritingRules: true,
        },
      );
      setLearned(res.candidates);
      toast.success(res.adoptedCount > 0 ? `已自动沉淀 ${res.adoptedCount} 条团队写作规则` : res.summaryZh);
    } catch (e) {
      toast.error(toErrorMessage(e));
    } finally {
      setLearning(false);
    }
  };

  const handleAttachFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: typeof attachments = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (['txt', 'csv', 'md', 'json', 'eml', 'htm', 'html'].includes(ext)) {
        const text = (await file.text()).slice(0, 12000);
        next.push({ name: file.name, status: 'read', text, note: '文本已解析' });
      } else if (['png', 'jpg', 'jpeg', 'webp', 'pdf'].includes(ext)) {
        next.push({ name: file.name, status: 'binary', note: '图片/PDF 需视觉模型或人工补录文字，AI 不得假装读过' });
      } else if (['ai', 'eps', 'psd', 'svg', 'dwg', 'step'].includes(ext)) {
        next.push({ name: file.name, status: 'partial', note: '设计源文件已登记，系统不解析内容' });
      } else {
        next.push({ name: file.name, status: 'unread', note: '暂不支持自动解析该格式' });
      }
    }
    setAttachments((prev) => [...prev, ...next].slice(0, 10));
  };

  const copyBody = async () => {
    if (!editedBody.trim()) return;
    await navigator.clipboard.writeText(editedBody);
    toast.success('已复制英文回复正文');
  };

  const checks = liveScore?.checks ?? [];
  const badChecks = checks.filter((c) => c.severity === 'bad');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold">{mode === 'mail' ? 'AI 回复副驾驶（三版 + 护栏）' : '多渠道询盘快贴工作台'}</span>
        </div>
        <Button size="sm" className="h-7 text-xs" loading={loading} onClick={() => void generateDrafts()}>
          {result ? '重新起草' : '生成三版草稿'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {mode === 'multichannel' ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Select value={channel} onValueChange={(v) => setChannel(v as typeof channel)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="alibaba">Alibaba 询盘</SelectItem>
                  <SelectItem value="trademanager">TradeManager</SelectItem>
                  <SelectItem value="instagram">Instagram DM</SelectItem>
                  <SelectItem value="email">Email 邮件</SelectItem>
                </SelectContent>
              </Select>
              <Input value={pasteSubject} onChange={(e) => setPasteSubject(e.target.value)} placeholder="主题（选填）" className="h-8 text-xs" />
            </div>
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              placeholder="粘贴客户发来的 WhatsApp / 阿里 / 邮件原文…"
              className="text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void handleAttachFiles(e.target.files)} />
              <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => fileRef.current?.click()}>
                <Upload className="h-3 w-3" />添加附件（状态分级）
              </Button>
              {attachments.map((a, idx) => (
                <Badge key={idx} variant={a.status === 'read' ? 'outline' : 'warning'} className="text-[10px]">
                  {a.name} · {a.status}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-muted-foreground">场景：</span>
            {SCENARIO_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setScenario(opt.id)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  scenario === opt.id
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="可选指示：如“礼貌催上周报价反馈”或“告知大货下周出货并确认收货地址”"
            className="h-8 text-xs"
          />
        </div>

        {!result ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-muted-foreground">
            <p className="font-medium text-foreground">支持询盘首回、多轮跟进、打样工艺、大货物流与客诉处理</p>
            <p className="mt-1 text-[11px] leading-relaxed">
              一键生成 AI 完整版 · AI 简洁版 · 知识库秒回（Alt+1/2/3 切换），自动结合历史往来并对照对外口径与红线打分。
            </p>
          </div>
        ) : (
          <>
            {result.scamSignals.length > 0 ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-destructive">
                <p className="flex items-center gap-1 font-semibold"><AlertTriangle className="h-3.5 w-3.5" />防钓鱼/低质风险提示</p>
                <ul className="mt-1 list-disc pl-4">
                  {result.scamSignals.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>
            ) : null}

            {!result.usedAi ? (
              <div className="rounded-md border border-amber-300/70 bg-amber-50/70 p-2.5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <p className="flex items-center gap-1 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" />当前已降级为知识库规则兜底（未生成 AI 版）
                </p>
                <p className="mt-0.5 text-[11px] opacity-90">
                  原因：{result.aiFallbackReason || 'AI 模型调用未返回有效 JSON'}。三版卡片暂基于规则底稿打分，可检查「AI 配置」后点重新起草。
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/25 p-2 text-[11px]">
                <p className="font-semibold text-foreground">{result.analysis.intentZh}</p>
                <p className="mt-0.5 text-muted-foreground">{result.analysis.summaryZh}</p>
              </div>
            )}

            {/* 3-Version Tabs */}
            <div className="grid grid-cols-3 gap-1.5">
              {([['B', 'AI 完整', 'Alt+1'], ['A', 'AI 简洁', 'Alt+2'], ['K', '知识库秒回', 'Alt+3']] as const).map(([key, label, hint]) => {
                const sc = result.drafts[key].score;
                const active = activeVersion === key;
                const winner = result.duelWinner === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => switchVersion(key)}
                    className={`rounded-md border px-2 py-1.5 text-left transition-colors ${
                      active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold">{label}</span>
                      <Badge variant={winner ? 'outline' : 'secondary'} className="h-4 px-1 text-[10px] tabular-nums">
                        {sc.score}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}{winner ? ' · 推荐' : ''}</p>
                  </button>
                );
              })}
            </div>

            {/* Tone Switcher */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-muted-foreground">语气改写：</span>
              {TONE_OPTIONS.map((t) => (
                <Button key={t.id} size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={rewriting} onClick={() => void rewriteTone(t.id)}>
                  {t.label}
                </Button>
              ))}
              {rewriting ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
            </div>

            {/* Draft Editor */}
            <div className="space-y-1.5 rounded-lg border border-border p-2.5">
              {editedSubject ? (
                <Input value={editedSubject} onChange={(e) => setEditedSubject(e.target.value)} className="h-7 border-0 border-b border-border px-0 text-xs font-semibold shadow-none" />
              ) : null}
              <Textarea
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                rows={8}
                className="border-0 px-0 text-xs leading-relaxed shadow-none focus-visible:ring-0"
              />
              {zhPreview ? (
                <div className="rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  <p className="mb-1 flex items-center gap-1 font-semibold text-foreground"><Languages className="h-3 w-3" />中文参考翻译</p>
                  <p className="whitespace-pre-wrap">{zhPreview}</p>
                </div>
              ) : null}
            </div>

            {/* Guardrails */}
            <div className="space-y-1.5 rounded-lg border border-border p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 font-semibold">
                  {badChecks.length > 0 ? <ShieldAlert className="h-3.5 w-3.5 text-destructive" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
                  确定性护栏（{liveScore?.score ?? 0} 分 · {liveScore?.words ?? 0} 词）
                </span>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void recheckGuardrails()}>复检</Button>
              </div>
              {liveScore ? (
                <div className="grid grid-cols-5 gap-1 rounded bg-muted/40 px-2 py-1 text-center text-[10px] tabular-nums text-muted-foreground">
                  <div>覆盖 <span className="font-semibold text-foreground">{liveScore.parts.coverage}</span>/35</div>
                  <div>具体 <span className="font-semibold text-foreground">{liveScore.parts.specificity}</span>/15</div>
                  <div>安全 <span className="font-semibold text-foreground">{liveScore.parts.safety}</span>/30</div>
                  <div>写作 <span className="font-semibold text-foreground">{liveScore.parts.writing}</span>/10</div>
                  <div>篇幅 <span className="font-semibold text-foreground">{liveScore.parts.length}</span>/10</div>
                </div>
              ) : null}
              {liveScore && liveScore.reasons.length > 0 ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  扣分说明：{liveScore.reasons.join('；')}
                </p>
              ) : null}
              <ul className="space-y-1">
                {checks.map((ck, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px]">
                    <Badge variant={ck.severity === 'bad' ? 'destructive' : ck.severity === 'warn' ? 'warning' : 'outline'} className="shrink-0 px-1 py-0 text-[9px]">
                      {ck.severity === 'bad' ? '必须改' : ck.severity === 'warn' ? '注意' : '通过'}
                    </Badge>
                    <span className="leading-snug text-foreground/90">{ck.message}</span>
                  </li>
                ))}
              </ul>
              {result.revisedDiff ? (
                <details className="pt-1 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-primary">已自动修正红线 1 轮（查看修改摘要）</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {result.revisedDiff.changesZh.map((c, idx) => <li key={idx}>{c}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>

            {/* Pre-send Last Question Card */}
            <div className="rounded-lg border border-border bg-muted/25 p-2.5">
              <p className="mb-1.5 flex items-center gap-1 font-semibold">
                <ClipboardCheck className="h-3.5 w-3.5 text-primary" />发送前最后一问
              </p>
              <dl className="space-y-1 text-[11px]">
                {result.analysis.preSendChecklist.map((item) => (
                  <div key={item.label} className="flex items-start justify-between gap-2">
                    <dt className="shrink-0 text-muted-foreground">{item.label}</dt>
                    <dd className={`text-right font-medium ${item.severity === 'bad' ? 'text-destructive' : item.severity === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Open questions & Commitments summary */}
            {result.analysis.openQuestions.length > 0 ? (
              <div className="space-y-1.5 rounded-lg border border-border p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">买家诉求与未解决问题（{result.analysis.openQuestions.length}）</span>
                  {customerId ? (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" loading={savingItems} onClick={() => void persistWorkbenchItems()}>
                      <CheckCircle2 className="h-3 w-3" />沉淀到客户档案
                    </Button>
                  ) : null}
                </div>
                <ul className="space-y-1 text-[11px]">
                  {result.analysis.openQuestions.slice(0, 6).map((q, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 border-t border-border/50 pt-1 first:border-0 first:pt-0">
                      <span className="text-foreground/90">{q.zh || q.text}</span>
                      <Badge variant={q.handling === 'CHECKING' ? 'warning' : 'outline'} className="shrink-0 text-[9px]">
                        {q.handling} · {q.ownerRole}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {learned.length > 0 ? (
              <div className="rounded-lg border border-emerald-300/60 bg-emerald-50/40 p-2.5 dark:border-emerald-500/20 dark:bg-emerald-500/5">
                <p className="flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-300">
                  <BookOpen className="h-3.5 w-3.5" />终稿反哺提炼（{learned.length} 条）
                </p>
                <ul className="mt-1 space-y-1 text-[11px]">
                  {learned.map((c, idx) => <li key={idx}>· [{c.type}] {c.text}（{c.why}）</li>)}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Bottom Action Bar */}
      {result ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-muted/20 p-2.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void copyBody()}>
            <Copy className="h-3 w-3" />复制
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" loading={learning} onClick={() => void runLearnFromEdit()}>
            <BookOpen className="h-3 w-3" />终稿学习
          </Button>
          {onApplyReply ? (
            <Button
              size="sm"
              className="ml-auto h-7 text-xs"
              disabled={badChecks.length > 0}
              title={badChecks.length > 0 ? '请先修复红色护栏问题' : undefined}
              onClick={() => onApplyReply({ subject: editedSubject, content: editedBody })}
            >
              <Send className="h-3 w-3" />填入回复审稿
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
