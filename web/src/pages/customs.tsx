import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BellRing, Building2, Globe2, Loader2, Search, Ship, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiGet, apiPatch, apiPost, toErrorMessage } from '@/lib/api';
import { formatCountry } from '@/lib/country';
import { formatDate, formatMoney } from '@/lib/format';
import { usePageTitle } from '@/hooks/use-ui';
import { useAuthStore, selectIsAdmin } from '@/store/auth.store';
import { ROUTES } from '@/constants';
import type { CustomsCompanyDetail, CustomsCompanySummary, CustomsShipment } from '@/types';

interface CompanyList {
  items: CustomsCompanySummary[];
  total: number;
}

interface CustomsAlert {
  _id: string;
  type: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string | Date;
}

interface AlertList {
  items: CustomsAlert[];
  total: number;
}

interface CustomsSourceOption {
  id: string;
  name: string;
  provider: string;
  kind: string;
  status: string;
}

export function CustomsPage(): React.JSX.Element {
  usePageTitle('贸易情报');
  const navigate = useNavigate();
  const isAdmin = useAuthStore(selectIsAdmin);
  const [query, setQuery] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [companies, setCompanies] = React.useState<CustomsCompanySummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState<CustomsCompanyDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [convertBusy, setConvertBusy] = React.useState(false);
  const [alerts, setAlerts] = React.useState<CustomsAlert[]>([]);
  const [importOpen, setImportOpen] = React.useState(false);
  const [sources, setSources] = React.useState<CustomsSourceOption[]>([]);
  const [sourceId, setSourceId] = React.useState('');
  const [importText, setImportText] = React.useState('');
  const [importBusy, setImportBusy] = React.useState(false);

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

  React.useEffect(() => {
    void apiGet<AlertList>('/customs/alerts?status=unread&page=1&limit=5')
      .then((result) => setAlerts(result.items))
      .catch(() => { /* 提醒是辅助信息，不阻断主页面 */ });
  }, []);

  async function markAlertRead(alertId: string): Promise<void> {
    try {
      await apiPatch(`/customs/alerts/${alertId}`, { status: 'read' });
      setAlerts((current) => current.filter((alert) => alert._id !== alertId));
    } catch (reason) {
      toast.error('提醒状态更新失败', { description: toErrorMessage(reason) });
    }
  }

  async function openCompany(company: CustomsCompanySummary): Promise<void> {
    setDetailLoading(true);
    setSelected(null);
    try {
      const detail = await apiGet<CustomsCompanyDetail>(`/customs/companies/${company._id}`);
      const score = await apiGet<{ score: number; reasons: Array<{ label: string; value: string | number }>; calculatedAt?: string }>(`/customs/companies/${company._id}/score`);
      setSelected({ ...detail, score });
    } catch (reason) {
      toast.error('公司档案读取失败', { description: toErrorMessage(reason) });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openImport(): Promise<void> {
    setImportOpen(true);
    try {
      const result = await apiGet<CustomsSourceOption[]>('/customs/sources');
      setSources(result);
      setSourceId((current) => current || result[0]?.id || '');
    } catch (reason) {
      toast.error('数据源读取失败', { description: toErrorMessage(reason) });
    }
  }

  async function createCsvSource(): Promise<void> {
    try {
      const source = await apiPost<CustomsSourceOption>('/customs/sources', {
        name: `CSV 导入 ${new Date().toISOString().slice(0, 10)}`,
        provider: `csv-${Date.now()}`,
        kind: 'csv',
        coverageCountries: ['US'],
      });
      setSources((current) => [source, ...current]);
      setSourceId(source.id);
      toast.success('CSV 数据源已创建');
    } catch (reason) {
      toast.error('数据源创建失败', { description: toErrorMessage(reason) });
    }
  }

  async function submitImport(): Promise<void> {
    if (!sourceId) {
      toast.error('请先选择或创建数据源');
      return;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(importText);
    } catch {
      toast.error('导入内容不是有效 JSON');
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      toast.error('导入内容必须是至少包含一条记录的数组');
      return;
    }
    setImportBusy(true);
    try {
      const result = await apiPost<{ written: number; skipped: number; errors: Array<{ message: string }> }>('/customs/import', { sourceId, rows });
      toast.success(`导入完成：写入 ${result.written} 条，跳过 ${result.skipped} 条`, {
        description: result.errors.length ? `有 ${result.errors.length} 条失败，请检查格式` : undefined,
      });
      setImportOpen(false);
      setImportText('');
      await load();
    } catch (reason) {
      toast.error('导入失败', { description: toErrorMessage(reason) });
    } finally {
      setImportBusy(false);
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
        actions={isAdmin ? <Button size="sm" variant="outline" onClick={() => void openImport()}>导入海关数据</Button> : undefined}
      />

      {alerts.length ? (
        <Card className="border-amber-200/70 bg-amber-50/30 dark:border-amber-400/20 dark:bg-amber-400/5">
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold"><BellRing className="h-4 w-4 text-amber-600" aria-hidden />贸易提醒</p>
              <Badge variant="outline">{alerts.length} 条未读</Badge>
            </div>
            {alerts.map((alert) => (
              <div key={alert._id} className="flex items-start justify-between gap-3 rounded-md bg-background/70 p-2 text-xs">
                <div className="min-w-0">
                  <p className="font-medium">{alert.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground">{alert.summary}</p>
                </div>
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void markAlertRead(alert._id)}>标为已读</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

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

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>导入海关数据</DialogTitle>
            <DialogDescription>粘贴供应商导出的 JSON 数组。字段可包含 importerName、importerCountry、exporterName、hsCode、productDescription、amountUsd 和 shipmentDate。</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label>数据源</Label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 min-w-[220px] rounded-md border bg-background px-3 text-sm"
                  value={sourceId}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  <option value="">选择数据源</option>
                  {sources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.provider}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={() => void createCsvSource()}>新建 CSV 数据源</Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customs-import-json">JSON 数据</Label>
              <Textarea
                id="customs-import-json"
                className="min-h-56 font-mono text-xs"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'[\n  {"importerName":"Acme","importerCountry":"US","hsCode":"420222","amountUsd":12000,"shipmentDate":"2026-11-01"}\n]'}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportOpen(false)} disabled={importBusy}>取消</Button>
            <Button type="button" onClick={() => void submitImport()} disabled={importBusy}>
              {importBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
              开始导入
            </Button>
          </DialogFooter>
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
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Metric label="进口票数" value={String(summary.shipmentCount)} />
            <Metric label="累计金额" value={formatMoney(summary.totalAmountUsd, 'USD')} />
            <Metric label="最近记录" value={formatDate(summary.lastSeenAt)} />
            <Metric label="匹配评分" value={detail.score ? `${detail.score.score}/100` : '暂无'} />
          </div>
          {detail.score?.reasons?.length ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              评分依据：{detail.score.reasons.map((reason) => `${reason.label} ${reason.value}`).join(' · ')}
            </p>
          ) : null}
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
