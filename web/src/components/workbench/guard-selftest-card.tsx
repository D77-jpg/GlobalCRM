import * as React from 'react';
import { Link } from 'react-router-dom';
import { Play, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, toErrorMessage } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GuardSelftestResult } from '@/types';

export function GuardSelftestCard(): React.JSX.Element {
  const [result, setResult] = React.useState<GuardSelftestResult | null>(null);
  const [running, setRunning] = React.useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const res = await apiGet<GuardSelftestResult>('/workbench/guardrails/selftest');
      setResult(res);
      toast.success(`发信规则自检完成：${res.passed}/${res.total} 项通过`);
    } catch (e) {
      toast.error('运行发信规则自检失败', { description: toErrorMessage(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />发信规则自检
          </CardTitle>
          <CardDescription>
            检查禁用词、价格承诺、附件与品牌红线拦截规则是否正常工作（共 24 项内置检查，不消耗 AI 额度）。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/knowledge?view=policies">配置对外口径与红线</Link>
          </Button>
          <Button size="sm" loading={running} onClick={() => void run()}>
            <Play className="h-3.5 w-3.5" />运行规则自检
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!result ? (
          <p className="text-xs text-muted-foreground">修改对外口径或品牌红线后，点击「运行规则自检」即可验证全部拦截规则是否生效。</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-xs">
              <Badge variant={result.failed === 0 ? 'outline' : 'destructive'}>
                {result.failed === 0 ? '全部通过' : `${result.failed} 项未通过`}
              </Badge>
              <span className="tabular-nums text-muted-foreground">通过 {result.passed} / {result.total}</span>
            </div>
            <details className="rounded-md border border-border/70 p-2.5 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                查看详细检查项（{result.results.length} 项）
              </summary>
              <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {result.results.map((r) => (
                  <div key={r.name} className={`rounded-md border px-2.5 py-1.5 text-xs ${r.ok ? 'border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'}`}>
                    <div className="flex items-center justify-between gap-1 font-medium">
                      <span className="truncate">{r.name}</span>
                      <span>{r.ok ? '✓' : '✗'}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{r.got[0]}</p>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
