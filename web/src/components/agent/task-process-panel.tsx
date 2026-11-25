import { Check, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';

// The task detail answers one question: what did the agent actually do, with what
// evidence, and did it verify the result? Every number here comes from the step
// record (server/services/agent/task.service.ts: stepMetrics), never from a guess.
export type TaskStepMetrics = { bytes?: number; sources?: number; chars?: number; facts?: number; issues?: number;
  topics?: number; questions?: number; rules?: number; missing?: number; conflicts?: number; gaps?: number;
  tokens?: number; checks?: number; verifyMode?: string };
export type TaskWorkflowStep = { key: string; label: string; epoch: number; state: 'running' | 'completed' | 'failed';
  durationMs?: number; partial?: boolean; reused: number; tool?: string; startedAt?: string; metrics?: TaskStepMetrics };
export type TaskProcess = { workflow?: TaskWorkflowStep[]; workflowEpoch?: number; workflowCalls?: number;
  workflowActiveMs?: number; budgetCharged?: number; tokenBudget?: number; status: string };

const seconds = (ms?: number) => (ms === undefined ? '—' : ms < 100 ? '<0.1 秒' : (ms / 1000).toFixed(1) + ' 秒');
const num = (value?: number) => (value === undefined ? '—' : value.toLocaleString('en-US'));
const verifyLabels: Record<string, string> = { semantic: '自动核对', deterministic: '规则核对', unavailable: '未完成' };

function stepChips(step: TaskWorkflowStep): string[] {
  const m = step.metrics ?? {};
  const chips: string[] = [];
  if (step.key === 'read_context') chips.push('读取资料 ' + num(m.sources) + ' 份');
  if (step.key === 'extract_requirements') chips.push('识别问题 ' + num(m.questions) + ' 个');
  if (step.key === 'load_rules') chips.push('业务规则 ' + num(m.rules) + ' 条');
  if (step.key.startsWith('retrieve_')) chips.push('匹配资料 ' + num(m.sources) + ' 条');
  if (step.key === 'assess_evidence' && ((m.missing ?? 0) > 0 || (m.conflicts ?? 0) > 0)) {
    if ((m.missing ?? 0) > 0) chips.push('待补充 ' + num(m.missing) + ' 项');
    if ((m.conflicts ?? 0) > 0) chips.push('待确认差异 ' + num(m.conflicts) + ' 项');
  }
  if (step.key === 'generate_email') chips.push('引用依据 ' + num(m.facts) + ' 条');
  if (step.key === 'audit_claims') chips.push('核对方式：' + (verifyLabels[m.verifyMode ?? ''] ?? '—'), '核对 ' + num(m.checks) + ' 处');
  if (step.key === 'research_customer' && step.tool) chips.push('已读取客户官网');
  return chips;
}

export function TaskProcessPanel({ task }: { task: TaskProcess }) {
  const epoch = task.workflowEpoch ?? 0;
  const steps = (task.workflow ?? []).filter(step => step.epoch === epoch);
  if (!steps.length) return null;
  const retrieval = steps.filter(step => step.key === 'retrieve_0').at(-1);
  const audit = steps.filter(step => step.key === 'audit_claims').at(-1);
  const done = steps.filter(step => step.state === 'completed').length;
  const slowest = Math.max(1, ...steps.map(step => step.durationMs ?? 0));
  const failed = steps.some(step => step.state === 'failed');
  const verified = audit?.metrics?.verifyMode === 'semantic';
  const unavailable = audit?.metrics?.verifyMode === 'unavailable';
  const partial = Boolean(audit?.partial) && verified;

  return (
    <section aria-label="处理进度" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">处理进度</h4>
        <span className="text-xs text-muted-foreground">已完成 {done}/{steps.length} 步</span>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {[
          ['总耗时', seconds(task.workflowActiveMs), ''],
          ['参考资料', retrieval ? num(retrieval.metrics?.sources) + ' 条' : '—', ''],
          ['内容核对', unavailable ? '待确认' : partial ? '部分通过' : verified ? '已通过' : '—', audit?.metrics?.checks !== undefined ? '共 ' + num(audit.metrics.checks) + ' 处' : ''],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-md border bg-background px-3 py-2">
            <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
            <dd className={'text-sm font-semibold leading-5 ' + (unavailable || partial ? 'text-amber-700 dark:text-amber-400' : '')}>{value}</dd>
            {hint ? <dd className="text-[11px] leading-4 text-muted-foreground">{hint}</dd> : null}
          </div>
        ))}
      </dl>
      {unavailable ? (
        <p role="status" className="flex min-w-0 items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 break-words text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">本次自动核对暂未完成，发送前请先人工确认正文中的数字和承诺。</span>
        </p>
      ) : verified ? (
        <p role="status" className="flex min-w-0 items-start gap-2 text-xs leading-5 break-words text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          <span className="min-w-0 break-words">{partial ? '部分内容需要确认，发送前请人工过目。' : '正文已逐句对照资料核对通过。'}</span>
        </p>
      ) : null}
      <ol className="space-y-2">
        {steps.map(step => {
          const chips = stepChips(step);
          const width = Math.max(2, Math.round(((step.durationMs ?? 0) / slowest) * 100));
          return (
            <li key={step.key + step.startedAt} className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm leading-6">
                {step.state === 'completed' ? <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                  : step.state === 'running' && task.status === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
                    : <span className="h-3 w-3 shrink-0 rounded-full border" aria-hidden />}
                <span className="min-w-0 break-words">{step.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{seconds(step.durationMs)}</span>
                {step.state === 'failed' ? <span className="text-[11px] text-destructive">未完成</span> : null}
                {step.key === 'audit_claims' && step.partial && !unavailable ? <span className="text-[11px] text-amber-700 dark:text-amber-400">待确认</span> : null}
              </div>
              <div className="ml-6 mt-0.5 h-1 w-full max-w-64 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className={'h-full rounded-full ' + (step.state === 'failed' ? 'bg-destructive/60' : step.state === 'running' ? 'bg-primary/60' : 'bg-emerald-600/60')} style={{ width: width + '%' }} />
              </div>
              {chips.length > 0 && <p className="ml-6 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">{chips.map(chip => <span key={chip}>{chip}</span>)}</p>}
            </li>
          );
        })}
      </ol>
      {failed || epoch > 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{failed ? '部分步骤未完成' : ''}{failed && epoch > 0 ? ' · ' : ''}{epoch > 0 ? '资料更新后已重新核对' : ''}</p>
      ) : null}
    </section>
  );
}
