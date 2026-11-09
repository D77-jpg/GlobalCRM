import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BarChart3, Building2, Loader2, Ship } from 'lucide-react';
import { apiDelete, apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';
import { formatCountry } from '@/lib/country';
import type { CustomerCustomsTrade } from '@/types';

export function CustomerTradePanel({ customerId }: { customerId: string }): React.JSX.Element {
  const [data, setData] = React.useState<CustomerCustomsTrade | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [watchBusy, setWatchBusy] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void apiGet<CustomerCustomsTrade>(`/customs/customers/${customerId}/trade`)
      .then((result) => { if (active) setData(result); })
      .catch((reason) => { if (active) setError(toErrorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [customerId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          正在读取贸易动态...
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          贸易动态暂时无法读取：{error}
        </CardContent>
      </Card>
    );
  }

  if (!data?.matched || !data.company) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Ship className="h-4 w-4 text-muted-foreground" aria-hidden />
            贸易动态
          </CardTitle>
          <CardDescription>还没有匹配到海关记录。可以在贸易情报中搜索公司并确认关联。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="sm" variant="outline">
            <Link to="/customs">打开贸易情报</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const watching = Boolean(data.watch?.enabled);

  async function toggleWatch(): Promise<void> {
    setWatchBusy(true);
    try {
      if (watching) {
        const next = await apiDelete<{ enabled?: boolean }>(`/customs/customers/${customerId}/watch`);
        setData((current) => current ? { ...current, watch: next } : current);
        toast.success('已停止监控该客户的贸易变化');
      } else {
        const next = await apiPost<{ enabled?: boolean }>(`/customs/customers/${customerId}/watch`, {});
        setData((current) => current ? { ...current, watch: next } : current);
        toast.success('已开始监控该客户的贸易变化');
      }
    } catch (reason) {
      toast.error('监控状态更新失败', { description: toErrorMessage(reason) });
    } finally {
      setWatchBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" aria-hidden />
            贸易动态
          </CardTitle>
          <CardDescription>
            海关数据匹配：{data.company.canonicalName} · 数据截至 {formatDate(data.summary?.lastSeenAt)}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={watching ? 'secondary' : 'outline'} onClick={() => void toggleWatch()} disabled={watchBusy}>
            {watchBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Ship className="mr-1 h-3.5 w-3.5" aria-hidden />}
            {watching ? '停止监控' : '监控变化'}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/customs">查看完整公司档案 <ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="进口票数" value={String(data.summary?.shipmentCount ?? data.company.shipmentCount)} />
          <Metric label="累计金额" value={formatMoney(data.summary?.totalAmountUsd ?? data.company.totalAmountUsd, 'USD')} />
          <Metric label="最近记录" value={formatDate(data.summary?.lastSeenAt ?? data.company.lastSeenAt)} />
        </div>
        {data.recentShipments?.length ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-2 font-medium">日期</th>
                  <th className="p-2 font-medium">产品</th>
                  <th className="p-2 font-medium">HS</th>
                  <th className="p-2 font-medium">金额</th>
                  <th className="p-2 font-medium">目的港</th>
                </tr>
              </thead>
              <tbody>
                {data.recentShipments.slice(0, 5).map((shipment) => (
                  <tr key={shipment._id} className="border-t">
                    <td className="whitespace-nowrap p-2">{formatDate(shipment.shipmentDate)}</td>
                    <td className="max-w-[240px] truncate p-2" title={shipment.productDescription}>{shipment.productDescription || '未描述'}</td>
                    <td className="p-2 font-mono">{shipment.hsCode || '-'}</td>
                    <td className="p-2">{formatMoney(shipment.amountUsd, 'USD')}</td>
                    <td className="p-2">{shipment.portOfDischarge || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无最近提单记录。</p>
        )}
        {data.company.domain ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" aria-hidden />
            {formatCountry(data.company.country)} · {data.company.domain}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}
