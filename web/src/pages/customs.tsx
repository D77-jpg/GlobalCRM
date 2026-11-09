import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, Globe2, Loader2, Search, Ship, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { formatCountry } from '@/lib/country';
import { formatDate, formatMoney } from '@/lib/format';
import { usePageTitle } from '@/hooks/use-ui';
import { ROUTES } from '@/constants';
import type { CustomsCompanyDetail, CustomsCompanySummary, CustomsShipment } from '@/types';

interface CompanyList {
  items: CustomsCompanySummary[];
  total: number;
}

export function CustomsPage(): React.JSX.Element {
  usePageTitle('贸易情报');
  const navigate = useNavigate();
  const [query, setQuery] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [companies, setCompanies] = React.useState<CustomsCompanySummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState<CustomsCompanyDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [convertBusy, setConvertBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (query.trim()) params.set('q', query.trim());
      if (country.trim()) params.set('country', country.trim());
      const data = await apiGet<CompanyList>(`/customs/companies?${params.toString()}`);
      setCompanies(data.items);
      setTotal(data.total);
    } catch (reason) {
      setError(toErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [country, query]);

  React.useEffect(() => { void load(); }, [load]);

  async function openCompany(company: CustomsCompanySummary): Promise<void> {
    setDetailLoading(true);
    setSelected(null);
    try {
      const detail = await apiGet<CustomsCompanyDetail>(`/customs/companies/${company._id}`);
      setSelected(detail);
    } catch (reason) {
      toast.error('公司档案读取失败', { description: toErrorMessage(reason) });
    } finally {
      setDetailLoading(false);
    }
  }

  async function convert(): Promise<void> {
    if (!selected?.company?._id) return;
    setConvertBusy(true);
    try {
      const result = await apiPost<{ created: boolean; prospect: { id?: string; _id?: string } }>(
        `/customs/companies/${selected.company._id}/convert`,
        {},
      );
      toast.success(result.created ? '已加入潜客池' : '这家公司已经在潜客池中');
      setSelected(null);
      navigate(ROUTES.prospecting);
    } catch (reason) {
      toast.error('加入潜客池失败', { description: toErrorMessage(reason) });
    } finally {
      setConvertBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="贸易情报"
        description="按产品和市场发现进口商，查看公司采购画像，并把高匹配公司加入潜客池。"
      />

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_220px_auto]">
          <div>
            <Label htmlFor="customs-query" className="text-xs">公司、产品、HS 或提单号</Label>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="customs-query"
                className="pl-9"
                value={query}
                placeholder="例如 jewellery pouch、420222、Acme"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="customs-country" className="text-xs">进口国家</Label>
            <Input
              id="customs-country"
              className="mt-1"
              value={country}
              placeholder="US / Germany"
              onChange={(event) => setCountry(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Search className="mr-1.5 h-4 w-4" aria-hidden />}
              查询公司
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? <ErrorState description={error} onRetry={() => void load()} /> : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {loading ? '正在读取海关公司...' : `共 ${total.toLocaleString('zh-CN')} 家公司`}
        </p>
        <Badge variant="outline" className="gap-1.5"><Globe2 className="h-3.5 w-3.5" aria-hidden />欧美优先</Badge>
      </div>

      {!loading && !error && companies.length === 0 ? (
        <EmptyState
          icon={<Ship className="h-5 w-5" aria-hidden />}
          title="还没有海关公司"
          description="管理员可以先通过 CSV 或供应商接口导入海关数据。导入后，这里会按公司维度展示采购记录。"
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {companies.map((company) => (
            <CompanyCard key={company._id} company={company} onOpen={() => void openCompany(company)} />
          ))}
        </div>
      )}

      <Dialog open={Boolean(selected) || detailLoading} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{selected?.company.canonicalName ?? '正在读取公司档案'}</DialogTitle>
            <DialogDescription>海关采购记录、供应商和产品结构</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {detailLoading || !selected ? (
              <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                正在加载公司档案...
              </div>
            ) : (
              <CompanyDetail detail={selected} onConvert={() => void convert()} convertBusy={convertBusy} />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CompanyCard({ company, onOpen }: { company: CustomsCompanySummary; onOpen: () => void }): React.JSX.Element {
  return (
    <Card className="transition-colors hover:border-primary/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button type="button" className="truncate text-left font-semibold hover:underline" onClick={onOpen}>
              {company.canonicalName}
            </button>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{formatCountry(company.country)}</span>
              {company.domain ? <span>· {company.domain}</span> : null}
              <Badge variant="outline">{company.companyType === 'importer' ? '进口商' : company.companyType === 'exporter' ? '出口商' : '公司'}</Badge>
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onOpen} aria-label={`查看 ${company.canonicalName}`}>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md bg-muted/30 p-2"><p className="text-muted-foreground">记录</p><p className="mt-1 font-semibold tabular-nums">{company.shipmentCount.toLocaleString('zh-CN')}</p></div>
          <div className="rounded-md bg-muted/30 p-2"><p className="text-muted-foreground">累计金额</p><p className="mt-1 font-semibold tabular-nums">{formatMoney(company.totalAmountUsd, 'USD')}</p></div>
          <div className="rounded-md bg-muted/30 p-2"><p className="text-muted-foreground">最近记录</p><p className="mt-1 font-semibold">{formatDate(company.lastSeenAt)}</p></div>
        </div>
      </CardContent>
    </Card>
  );
}

function CompanyDetail({ detail, onConvert, convertBusy }: { detail: CustomsCompanyDetail; onConvert: () => void; convertBusy: boolean }): React.JSX.Element {
  const { company, summary } = detail;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Building2 className="h-4 w-4" aria-hidden />
            {formatCountry(company.country)} {company.domain ? `· ${company.domain}` : ''}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Metric label="进口票数" value={String(summary.shipmentCount)} />
            <Metric label="累计金额" value={formatMoney(summary.totalAmountUsd, 'USD')} />
            <Metric label="最近记录" value={formatDate(summary.lastSeenAt)} />
          </div>
        </div>
        <Button onClick={onConvert} disabled={convertBusy}>
          {convertBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <TrendingUp className="mr-1.5 h-4 w-4" aria-hidden />}
          加入潜客池
        </Button>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">最近提单</h3>
        <ShipmentTable shipments={detail.recentShipments.slice(0, 12)} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">主要供应商</h3>
        {detail.topSuppliers.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {detail.topSuppliers.map((supplier) => (
              <div key={supplier._id} className="flex items-center justify-between rounded-md border p-2 text-xs">
                <span className="truncate">{supplier.company?.canonicalName ?? '未知供应商'}</span>
                <span className="ml-2 shrink-0 text-muted-foreground">{supplier.shipments} 票 · {formatMoney(supplier.amountUsd, 'USD')}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">暂无供应商聚合数据。</p>}
      </section>
    </div>
  );
}

function ShipmentTable({ shipments }: { shipments: CustomsShipment[] }): React.JSX.Element {
  if (!shipments.length) return <p className="text-sm text-muted-foreground">暂无提单记录。</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[700px] text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="p-2 font-medium">日期</th>
            <th className="p-2 font-medium">产品</th>
            <th className="p-2 font-medium">HS</th>
            <th className="p-2 font-medium">金额</th>
            <th className="p-2 font-medium">供应商</th>
            <th className="p-2 font-medium">目的港</th>
          </tr>
        </thead>
        <tbody>
          {shipments.map((shipment) => (
            <tr key={shipment._id} className="border-t">
              <td className="whitespace-nowrap p-2">{formatDate(shipment.shipmentDate)}</td>
              <td className="max-w-[220px] truncate p-2" title={shipment.productDescription}>{shipment.productDescription || '未描述'}</td>
              <td className="p-2 font-mono">{shipment.hsCode || '-'}</td>
              <td className="p-2">{formatMoney(shipment.amountUsd, 'USD')}</td>
              <td className="max-w-[160px] truncate p-2">{shipment.exporterNameRaw || '-'}</td>
              <td className="p-2">{shipment.portOfDischarge || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border bg-muted/20 p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );
}
