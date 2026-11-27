import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  Play,
  RefreshCw,
  ShieldCheck,
  Timer,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GuardSelftestCard } from '@/components/workbench/guard-selftest-card';
import { DonutChart } from '@/components/common/charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableSkeleton } from '@/components/ui/separator';
import { usePageTitle } from '@/hooks/use-ui';
import { apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { agentFailureLabel, agentRunLabel } from '@/lib/agent-display';
import { formatDateTime, initials } from '@/lib/format';
import type { AgentDiagnostics, AgentEvalRun } from '@/types';

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const tokens = (value: number): string => new Intl.NumberFormat('zh-CN').format(value);
const money = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

function EvaluationCard({ evaluation }: { evaluation: AgentEvalRun }): React.JSX.Element {
  const passed = evaluation.status === 'completed' && evaluation.passedCases === evaluation.totalCases;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>AI 助手自检记录</CardTitle>
          <CardDescription>
            {formatDateTime(evaluation.createdAt)} ·{' '}
            {/mock/i.test(evaluation.model) ? '演示模型' : evaluation.model}
          </CardDescription>
        </div>
        <Badge variant={passed ? 'outline' : evaluation.status === 'failed' ? 'destructive' : 'secondary'}>
          {evaluation.status === 'failed'
            ? '没跑完'
            : `${evaluation.passedCases}/${evaluation.totalCases} 项通过`}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-3">
          {evaluation.cases.map((item) => (
            <div key={item.caseId} className="flex min-w-0 items-start gap-2 rounded-lg border border-border/80 bg-surface/40 p-3">
              {item.passed ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.details}</p>
              </div>
            </div>
          ))}
        </div>
        {evaluation.errorCode ? (
          <p className="mt-3 text-xs text-destructive">{agentFailureLabel(evaluation.errorCode)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function AgentDiagnosticsPage(): React.JSX.Element {
  usePageTitle('AI 使用情况');
  const [data, setData] = React.useState<AgentDiagnostics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState('');
  const [metricTab, setMetricTab] = React.useState<'runs' | 'tokens' | 'cost'>('runs');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await apiGet<AgentDiagnostics>('/agent/admin/diagnostics?days=30'));
    } catch (reason) {
      setError(toErrorMessage(reason, 'AI 使用情况加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function runEvaluation() {
    if (running) return;
    setRunning(true);
    try {
      const result = await apiPost<AgentEvalRun>('/agent/admin/evaluations/run', undefined, {
        timeout: 360_000,
      });
      toast.success(`自检完成：${result.passedCases}/${result.totalCases} 项通过`);
      await load();
    } catch (reason) {
      toast.error(toErrorMessage(reason, '自检没能跑完'));
    } finally {
      setRunning(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="workspace-page">
        <PageHeader title="AI 使用情况" />
        <TableSkeleton rows={8} />
      </div>
    );
  }
  if (error && !data) return <ErrorState description={error} onRetry={() => void load()} />;
  if (!data) return <></>;

  const latestEval = data.evaluations[0];
  const totalInjections = data.users.reduce((sum, u) => sum + u.injectionSignals, 0);
  const totalApprovals = data.users.reduce(
    (sum, u) => sum + u.approvals.approved + u.approvals.rejected + u.approvals.pending,
    0,
  );
  const overallSuccessRate =
    data.totals.runs > 0
      ? Math.round(((data.totals.runs - data.totals.failed) / data.totals.runs) * 100)
      : 100;

  const rankedUsers = [...data.users]
    .sort((a, b) =>
      metricTab === 'runs'
        ? b.runs - a.runs
        : metricTab === 'tokens'
          ? b.totalTokens - a.totalTokens
          : b.estimatedCostUsd - a.estimatedCostUsd,
    )
    .slice(0, 6);
  const maxMetric = Math.max(
    1,
    ...rankedUsers.map((u) =>
      metricTab === 'runs' ? u.runs : metricTab === 'tokens' ? u.totalTokens : u.estimatedCostUsd,
    ),
  );

  return (
    <div className="workspace-page">
      <PageHeader
        title="AI 运行与使用情况"
        description={`近 ${data.periodDays} 天 AI 助手调用量、Token 用量、异常记录与安全护栏自检概览。`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
              刷新
            </Button>
            <Button size="sm" onClick={() => void runEvaluation()} disabled={running}>
              {running ? (
                <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              自检一下
            </Button>
          </>
        }
      />

      {/* Unified AI Observability Telemetry Strip */}
      <div className="os-telemetry-strip">
        <div className="grid divide-y divide-border/70 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">AI 调用次数</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">{tokens(data.totals.runs)}</p>
              <p className="text-[11px] text-muted-foreground">{data.totals.failed} 次失败 · 成功率 {overallSuccessRate}%</p>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">Token 用量</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">{tokens(data.totals.totalTokens)}</p>
              <p className="text-[11px] text-muted-foreground">单人日上限 {tokens(data.limits.dailyTokensPerUser)}</p>
            </div>
            <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">估算花费</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">{money(data.totals.estimatedCostUsd)}</p>
              <p className="text-[11px] text-muted-foreground">{data.pricing.configured ? '按配置单价估算' : '未配置模型单价'}</p>
            </div>
            <Coins className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">安全自检通过率</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums text-foreground">
                {latestEval ? `${latestEval.passedCases} / ${latestEval.totalCases}` : '尚未运行'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {latestEval ? `得分 ${percent(latestEval.score)}` : `共 ${data.dataset.cases} 项护栏测试`}
              </p>
            </div>
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          </div>
        </div>
      </div>

      {/* 中部三栏可观测面板（对比排行 + 占比分布 + 运行诊断与安全事件） */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_316px] xl:items-stretch">
        <Card className="flex flex-col p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="section-title">成员用量对比</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">近 {data.periodDays} 天按成员聚合排行</p>
            </div>
            <div className="os-segmented text-xs">
              {(
                [
                  ['runs', '调用次数'],
                  ['tokens', 'Token 用量'],
                  ['cost', '估算花费'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMetricTab(key)}
                  className={`os-segmented-item text-[11px] ${
                    metricTab === key ? 'os-segmented-item-active' : ''
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {rankedUsers.length > 0 ? (
            <div className="mt-4 flex-1 space-y-3">
              {rankedUsers.map((u) => {
                const rawVal =
                  metricTab === 'runs'
                    ? u.runs
                    : metricTab === 'tokens'
                      ? u.totalTokens
                      : u.estimatedCostUsd;
                const displayVal =
                  metricTab === 'runs'
                    ? `${tokens(u.runs)} 次`
                    : metricTab === 'tokens'
                      ? tokens(u.totalTokens)
                      : money(u.estimatedCostUsd);
                const widthPct = Math.max(4, Math.round((rawVal / maxMetric) * 100));
                return (
                  <div key={u.userId} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-medium text-foreground">
                        {u.displayName || u.username}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">{displayVal}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full rounded-full bg-foreground transition-all duration-300"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center py-10 text-xs text-muted-foreground">
              近 {data.periodDays} 天暂无成员调用记录
            </div>
          )}
        </Card>

        <Card className="flex flex-col p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="section-title">成员调用占比（Top 5）</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">按最近 {data.periodDays} 天调用次数汇总</p>
            </div>
            <Badge variant="outline" className="tabular-nums">
              共 {tokens(data.totals.runs)} 次
            </Badge>
          </div>
          <div className="flex flex-1 items-center">
            {data.users.length > 0 ? (
              <DonutChart
                slices={data.users.slice(0, 5).map((u) => ({
                  label: u.displayName || u.username,
                  value: u.runs,
                }))}
                centerValue={tokens(data.totals.runs)}
                centerLabel="总调用次数"
              />
            ) : (
              <p className="w-full py-10 text-center text-xs text-muted-foreground">暂无调用分布数据</p>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">运行诊断</h2>
              <Badge variant="outline" className="text-[11px]">
                {data.totals.failed === 0 ? '运行平稳' : `${data.totals.failed} 次异常`}
              </Badge>
            </div>
            <dl className="mt-3 divide-y divide-border/70 text-xs">
              <div className="flex items-center justify-between py-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  整体成功率
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">{overallSuccessRate}%</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  每日请求配额
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">
                  {data.limits.dailyRunsPerUser} 次/人
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  人工审批记录
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">{totalApprovals} 次</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  护栏基准用例
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">{data.dataset.cases} 项</dd>
              </div>
            </dl>
          </Card>

          <Card className="flex-1 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">异常与安全事件</h2>
              <span className="text-[11px] text-muted-foreground">近 {data.periodDays} 天</span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border/80 bg-surface/60 px-3.5 py-3">
              <div>
                <p className="text-2xl font-bold tabular-nums text-foreground">
                  {totalInjections + data.recentFailures.length}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  可疑指令 {totalInjections} · 运行失败 {data.recentFailures.length}
                </p>
              </div>
              <ShieldCheck className="h-6 w-6 text-muted-foreground" aria-hidden />
            </div>
          </Card>
        </div>
      </div>

      {/* 成员使用明细表 */}
      <Card>
        <CardHeader>
          <CardTitle>成员使用情况</CardTitle>
          <CardDescription>额度按「每人每天」计算，每天北京时间早上 8 点自动重置。</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">成员</TableHead>
                <TableHead>使用情况</TableHead>
                <TableHead>Token · 花费</TableHead>
                <TableHead>工具成功率</TableHead>
                <TableHead>需确认操作</TableHead>
                <TableHead>安全信号</TableHead>
                <TableHead className="pr-4">今日已用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.users.map((user) => (
                <TableRow key={user.userId}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2.5">
                      <span className="avatar-bubble inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/80 text-xs font-semibold">
                        {initials(user.displayName || user.username)}
                      </span>
                      <div>
                        <p className="font-medium text-foreground">{user.displayName || user.username}</p>
                        <p className="text-xs text-muted-foreground">
                          {{
                            admin: '系统管理员',
                            project_admin: '项目管理员',
                            viewer: '只读',
                            user: '销售',
                          }[user.role] ?? '销售'}{' '}
                          · {user.status === 'active' ? '启用' : '停用'}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <p className="tabular-nums font-medium">{user.runs} 次 · {percent(user.successRate)}</p>
                    <p className="text-xs text-muted-foreground">
                      平均 {(user.averageDurationMs / 1000).toFixed(1)} 秒
                    </p>
                  </TableCell>
                  <TableCell>
                    <p className="tabular-nums font-medium">{tokens(user.totalTokens)}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{money(user.estimatedCostUsd)}</p>
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">
                      {user.toolCalls} 次 · {percent(user.toolSuccessRate)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <p className="tabular-nums">
                      批准 {user.approvals.approved} · 拒绝 {user.approvals.rejected}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      待审 {user.approvals.pending} · 免审 {user.approvals.notRequired}
                    </p>
                  </TableCell>
                  <TableCell>
                    <p className="tabular-nums">可疑指令 {user.injectionSignals}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">超长截断 {user.truncatedRuns}</p>
                  </TableCell>
                  <TableCell className="pr-4">
                    <p className="tabular-nums">
                      {user.today.requests}/{data.limits.dailyRunsPerUser} 次
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {tokens(user.today.tokens + user.today.reservedTokens)} Token
                    </p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid items-stretch gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col space-y-4">
          {data.evaluations.length ? (
            data.evaluations.map((evaluation) => (
              <EvaluationCard key={evaluation.id} evaluation={evaluation} />
            ))
          ) : (
            <Card className="flex flex-1 flex-col">
              <CardHeader>
                <CardTitle>AI 助手自检记录</CardTitle>
                <CardDescription>
                  点击右上角「自检一下」可校验工具调用、权限护栏与模型响应链路。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 items-center justify-center py-6 text-center text-sm text-muted-foreground">
                还没跑过自检。
              </CardContent>
            </Card>
          )}
        </div>
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>没做完或出错的</CardTitle>
            <CardDescription>
              看看哪些处理没做完、卡在哪一步；这里不会显示客户邮件正文和密钥。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-2">
            {data.recentFailures.length ? (
              data.recentFailures.map((failure) => (
                <div key={failure.id} className="flex items-start gap-2 rounded-lg border border-border/80 bg-surface/40 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">{agentFailureLabel(failure.errorCode)}</p>
                    <p className="text-xs text-muted-foreground">
                      {agentRunLabel(failure.kind)} · {formatDateTime(failure.createdAt)}
                    </p>
                  </div>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                    <Timer className="h-3.5 w-3.5" aria-hidden />
                    {failure.durationMs} ms
                  </span>
                </div>
              ))
            ) : (
              <p className="flex h-full items-center justify-center py-6 text-center text-sm text-muted-foreground">
                这段时间都跑得很顺，没有出错记录。
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <GuardSelftestCard />
    </div>
  );
}
