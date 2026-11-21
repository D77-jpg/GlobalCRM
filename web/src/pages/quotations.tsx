import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Loader2,
  Package,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiDelete, apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { formatDate, formatMoney, roundMoney } from '@/lib/format';
import { customerDetailPath, QUOTATION_STATUS_LABEL } from '@/constants';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-ui';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import type {
  Customer,
  Paginated,
  Product,
  ProductHistoricalQuoteRef,
  Quotation,
  QuotationCurrency,
  QuotationIncoterm,
  QuotationShippingMethod,
  QuotationStatus,
  QuotationSummaryDto,
  QuoteCheckResult,
  RfqDto,
  RfqLineDto,
  WorkbenchConfigDto,
} from '@/types';

const INCOTERMS: QuotationIncoterm[] = ['FOB', 'EXW', 'CIF', 'CFR', 'DDP', 'DDU', 'DAP'];
const SHIPPING_OPTIONS: { value: QuotationShippingMethod; label: string }[] = [
  { value: 'sea', label: '海运 Sea' },
  { value: 'air', label: '空运 Air' },
  { value: 'express', label: '快递 Express' },
  { value: 'rail', label: '铁路 Rail' },
  { value: 'other', label: '其他 Other' },
];
const APPROVAL_LABELS: Record<string, { label: string; tone: 'outline' | 'warning' | 'destructive' | 'secondary' }> = {
  none: { label: '无需审批', tone: 'secondary' },
  pending_approval: { label: '待主管审批', tone: 'warning' },
  approved: { label: '已核准', tone: 'outline' },
  rejected: { label: '审批驳回', tone: 'destructive' },
};

interface DraftItemRow {
  productId?: string;
  sku?: string;
  productName: string;
  model: string;
  colorSpec: string;
  moq: string;
  pricingStatus: 'approved' | 'pending';
  quantity: number;
  unitPrice: number;
}

const EMPTY_ROW = (): DraftItemRow => ({
  productName: '',
  model: '',
  colorSpec: '',
  moq: '',
  pricingStatus: 'approved',
  quantity: 100,
  unitPrice: 0,
});

const EMPTY_RFQ_LINE = (): RfqLineDto => ({
  product: '',
  material: '',
  size: '',
  qty: '300/500/1000',
  logo: '',
  color: '',
  print: '',
  closure: '',
  insert: '',
  packaging: '',
  note: '',
  pricingStatus: 'pending',
});

export function QuotationsPage(): React.JSX.Element {
  usePageTitle('报价与 RFQ 工作台');
  const canApprove = useAuthStore(selectCanManageProjects);
  const [params] = useSearchParams();
  const preselectedCustomerId = params.get('customerId') || '';

  const [tab, setTab] = React.useState<'builder' | 'rfq' | 'list'>('builder');
  const [config, setConfig] = React.useState<WorkbenchConfigDto | null>(null);
  const [summary, setSummary] = React.useState<QuotationSummaryDto | null>(null);
  const [quotations, setQuotations] = React.useState<Quotation[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [rfqs, setRfqs] = React.useState<RfqDto[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  // Builder state
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [customerId, setCustomerId] = React.useState(preselectedCustomerId);
  const [productSearch, setProductSearch] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [currency, setCurrency] = React.useState<QuotationCurrency>('USD');
  const [incoterm, setIncoterm] = React.useState<QuotationIncoterm>('FOB');
  const [shippingMethod, setShippingMethod] = React.useState<QuotationShippingMethod>('sea');
  const [destinationPort, setDestinationPort] = React.useState('');
  const [estimatedFreight, setEstimatedFreight] = React.useState<number>(0);
  const [leadTime, setLeadTime] = React.useState('15–20 days');
  const [paymentTerms, setPaymentTerms] = React.useState('30% deposit, 70% before shipment');
  const [moq, setMoq] = React.useState('100 pcs');
  const [notes, setNotes] = React.useState('');
  const [status, setStatus] = React.useState<QuotationStatus>('draft');
  const [rows, setRows] = React.useState<DraftItemRow[]>([EMPTY_ROW()]);

  // Copilot state
  const [checking, setChecking] = React.useState(false);
  const [quoteCheck, setQuoteCheck] = React.useState<QuoteCheckResult | null>(null);
  const [historyRefs, setHistoryRefs] = React.useState<ProductHistoricalQuoteRef[]>([]);

  // RFQ state
  const [rfqEditingId, setRfqEditingId] = React.useState<string | null>(null);
  const [rfqCustomerId, setRfqCustomerId] = React.useState(preselectedCustomerId);
  const [rfqTitle, setRfqTitle] = React.useState('');
  const [rfqDestination, setRfqDestination] = React.useState('');
  const [rfqIncoterm, setRfqIncoterm] = React.useState('FOB Xiamen');
  const [rfqNotes, setRfqNotes] = React.useState('');
  const [rfqLines, setRfqLines] = React.useState<RfqLineDto[]>([EMPTY_RFQ_LINE()]);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, sum, qList, cList, pList, rList] = await Promise.all([
        apiGet<WorkbenchConfigDto>('/workbench/config'),
        apiGet<QuotationSummaryDto>('/quotations/summary'),
        apiGet<Paginated<Quotation>>('/quotations', { params: { limit: 50 } }),
        apiGet<Paginated<Customer>>('/customers', { params: { limit: 100 } }),
        apiGet<Paginated<Product>>('/products', { params: { status: 'active', limit: 100 } }),
        apiGet<RfqDto[]>('/workbench/rfqs'),
      ]);
      setConfig(cfg);
      setSummary(sum);
      setQuotations(qList.items);
      setCustomers(cList.items);
      setProducts(pList.items);
      setRfqs(rList);
      if (!customerId && cList.items[0]) setCustomerId(cList.items[0].id);
      if (!rfqCustomerId && cList.items[0]) setRfqCustomerId(cList.items[0].id);
    } catch (e) {
      toast.error(toErrorMessage(e, '报价工作台加载失败'));
    } finally {
      setLoading(false);
    }
  }, [customerId, rfqCustomerId]);

  React.useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;

  const filteredProducts = React.useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    return products.filter((p) => [p.sku, p.name, p.category].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 30);
  }, [products, productSearch]);

  const productSubtotal = roundMoney(rows.reduce((sum, r) => sum + roundMoney((Number(r.quantity) || 0) * (Number(r.unitPrice) || 0)), 0));
  const grandTotal = roundMoney(productSubtotal + (Number(estimatedFreight) || 0));

  const addProductToQuote = (prod: Product) => {
    const tier = prod.priceTiers[0];
    const qty = tier?.minQuantity ?? 100;
    const price = tier?.unitPrice ?? 0;
    const newRow: DraftItemRow = {
      productId: prod.id,
      sku: prod.sku,
      productName: prod.name,
      model: prod.specs.slice(0, 2).map((s) => `${s.name}:${s.value}`).join(' / '),
      colorSpec: '',
      moq: prod.moq || tier?.moq || '',
      pricingStatus: 'approved',
      quantity: qty,
      unitPrice: price,
    };
    setRows((prev) => {
      if (prev.length === 1 && !prev[0].productName.trim()) return [newRow];
      return [...prev, newRow];
    });
    if (tier?.currency) setCurrency(tier.currency);
    if (prod.leadTime) setLeadTime(prod.leadTime);
    if (!title.trim()) setTitle(`${prod.name} Quotation`);
    void fetchHistoryForProduct(prod.sku || prod.name);
  };

  const fetchHistoryForProduct = async (q: string) => {
    if (!q.trim()) return;
    try {
      const refs = await apiGet<ProductHistoricalQuoteRef[]>('/quotations/history-by-product', { params: { q } });
      setHistoryRefs(refs);
    } catch {
      // non-fatal
    }
  };

  const updateRowQty = (idx: number, nextQty: number) => {
    setRows((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      let nextPrice = row.unitPrice;
      if (row.productId) {
        const prod = products.find((p) => p.id === row.productId);
        const matchedTier = prod?.priceTiers.find((t) => nextQty >= t.minQuantity && (t.maxQuantity === undefined || nextQty <= t.maxQuantity));
        if (matchedTier) nextPrice = matchedTier.unitPrice;
      }
      return { ...row, quantity: nextQty, unitPrice: nextPrice };
    }));
  };

  const runLiveQuoteCheck = async () => {
    if (!customerId) {
      toast.error('请先选择报价客户');
      return;
    }
    const validItems = rows.filter((r) => r.productName.trim()).map((r) => ({
      name: r.sku || r.productName,
      quantity: Math.max(1, Math.round(Number(r.quantity) || 1)),
      unitPrice: Number(r.unitPrice) || 0,
    }));
    if (validItems.length === 0) {
      toast.error('请先添加至少一行产品');
      return;
    }
    setChecking(true);
    try {
      const [res, hist] = await Promise.all([
        apiPost<QuoteCheckResult>('/agent/quote-checks', { customerId, items: validItems }),
        apiGet<ProductHistoricalQuoteRef[]>('/quotations/history-by-product', { params: { q: validItems[0].name } }),
      ]);
      setQuoteCheck(res);
      setHistoryRefs(hist);
      toast.success('AI 报价体检完成');
    } catch (e) {
      toast.error(toErrorMessage(e, '报价核对失败'));
    } finally {
      setChecking(false);
    }
  };

  const saveQuotation = async () => {
    if (!customerId) { toast.error('请选择客户'); return; }
    if (!title.trim()) { toast.error('请填写报价标题'); return; }
    const cleanItems = rows.filter((r) => r.productName.trim()).map((r) => ({
      ...(r.productId ? { productId: r.productId } : {}),
      ...(r.sku ? { sku: r.sku } : {}),
      productName: r.productName.trim(),
      model: r.model.trim() || undefined,
      colorSpec: r.colorSpec.trim() || undefined,
      moq: r.moq.trim() || undefined,
      pricingStatus: r.pricingStatus,
      quantity: Number(r.quantity) || 1,
      unitPrice: Number(r.unitPrice) || 0,
    }));
    if (cleanItems.length === 0) { toast.error('至少需要一行有效产品'); return; }

    setSaving(true);
    try {
      const payload = {
        customerId,
        title: title.trim(),
        items: cleanItems,
        currency,
        incoterm,
        shippingMethod,
        destinationPort: destinationPort.trim() || undefined,
        estimatedFreight: Number(estimatedFreight) || 0,
        leadTime: leadTime.trim() || undefined,
        paymentTerms: paymentTerms.trim() || undefined,
        moq: moq.trim() || undefined,
        notes: notes.trim() || undefined,
        status,
      };
      let saved: Quotation;
      if (editingId) {
        saved = await apiPut<Quotation>(`/customers/${customerId}/quotations/${editingId}`, payload);
        toast.success(`报价单 ${saved.quotationNo} 已更新`);
      } else {
        saved = await apiPost<Quotation>('/quotations', payload);
        setEditingId(saved.id);
        toast.success(`报价单 ${saved.quotationNo} 已创建`);
      }
      await loadAll();
    } catch (e) {
      toast.error(toErrorMessage(e, '保存报价单失败'));
    } finally {
      setSaving(false);
    }
  };

  const loadQuotationToEditor = (q: Quotation) => {
    setEditingId(q.id);
    setCustomerId(q.customerId);
    setTitle(q.title);
    setCurrency(q.currency);
    setIncoterm(q.incoterm ?? 'FOB');
    setShippingMethod(q.shippingMethod ?? 'sea');
    setDestinationPort(q.destinationPort ?? '');
    setEstimatedFreight(q.estimatedFreight ?? 0);
    setLeadTime(q.leadTime ?? '');
    setPaymentTerms(q.paymentTerms ?? '');
    setMoq(q.moq ?? '');
    setNotes(q.notes ?? '');
    setStatus(q.status);
    setRows(q.items.map((it) => ({
      productId: it.productId,
      sku: it.sku,
      productName: it.productName,
      model: it.model ?? '',
      colorSpec: it.colorSpec ?? '',
      moq: it.moq ?? '',
      pricingStatus: it.pricingStatus ?? 'approved',
      quantity: it.quantity,
      unitPrice: it.unitPrice,
    })));
    setTab('builder');
    if (q.items[0]) void fetchHistoryForProduct(q.items[0].sku || q.items[0].productName);
  };

  const submitApproval = async (id: string) => {
    try {
      await apiPost(`/quotations/${id}/submit-approval`, {});
      toast.success('已提交主管审批');
      await loadAll();
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const reviewApproval = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await apiPost(`/quotations/${id}/review-approval`, { decision });
      toast.success(decision === 'approved' ? '报价单已核准' : '报价单已驳回');
      await loadAll();
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const saveRfq = async () => {
    if (!rfqCustomerId || !rfqTitle.trim()) {
      toast.error('请选择客户并填写 RFQ 标题');
      return;
    }
    const validLines = rfqLines.filter((l) => l.product.trim());
    if (validLines.length === 0) {
      toast.error('请至少填写一行产品规格');
      return;
    }
    setSaving(true);
    try {
      if (rfqEditingId) {
        await apiPut(`/workbench/rfqs/${rfqEditingId}`, {
          title: rfqTitle,
          destination: rfqDestination,
          incoterm: rfqIncoterm,
          notes: rfqNotes,
          lines: validLines,
        });
        toast.success('RFQ 核价单已更新');
      } else {
        await apiPost('/workbench/rfqs', {
          customerId: rfqCustomerId,
          title: rfqTitle,
          destination: rfqDestination,
          incoterm: rfqIncoterm,
          notes: rfqNotes,
          lines: validLines,
        });
        toast.success('RFQ 核价单已创建');
      }
      setRfqEditingId(null);
      setRfqTitle('');
      setRfqLines([EMPTY_RFQ_LINE()]);
      await loadAll();
    } catch (e) {
      toast.error(toErrorMessage(e, 'RFQ 保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const convertRfq = async (rfq: RfqDto) => {
    try {
      const res = await apiPost<{ rfq: RfqDto; quotation: Quotation }>(`/workbench/rfqs/${rfq.id}/convert-quotation`, {});
      toast.success(`已转为报价单 ${res.quotation.quotationNo}`);
      await loadAll();
      loadQuotationToEditor(res.quotation);
    } catch (e) {
      toast.error(toErrorMessage(e, '转换失败'));
    }
  };

  const activeQuotation = editingId ? quotations.find((q) => q.id === editingId) : null;

  return (
    <div className="workspace-page space-y-4">
      <PageHeader
        title="报价与 RFQ 工作台"
        description={config?.pricingMode === 'costing_approved'
          ? '当前项目为「非标定制 · 核算员审批核价」模式：优先在 RFQ 收集多数量档规格并导出核价表，回填批准单价后生成报价单。'
          : '当前项目为「标准目录 · 阶梯价与毛利测算」模式：左侧勾选产品自动带阶梯单价，右侧实时核验毛利率与历史报价。'}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {config?.pricingMode === 'costing_approved' ? '模式：非标 RFQ 核价' : '模式：目录阶梯价'}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => void loadAll()} loading={loading}>
              <RefreshCw className="h-3.5 w-3.5" />刷新
            </Button>
          </div>
        }
      />

      {/* Top 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">草稿待报价</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{summary?.draft ?? 0}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">累计报价单 {summary?.total ?? 0} 份</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">已发送 / 谈判中</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{(summary?.sent ?? 0) + (summary?.negotiating ?? 0)}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">在谈金额 {formatMoney(summary?.activePipelineAmount ?? 0, 'USD')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">待主管审批 / RFQ</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{summary?.pendingApproval ?? 0} <span className="text-sm font-normal text-muted-foreground">/ {rfqs.length} RFQ</span></p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">支持非标多档核价与内部核准</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">已成交报价额</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
              {formatMoney(summary?.acceptedAmount ?? 0, 'USD')}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">成交 {summary?.accepted ?? 0} 份</p>
          </CardContent>
        </Card>
      </div>

      {/* Mode Tabs */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border">
        {([
          ['builder', '创建 / 编辑外贸报价单'],
          ['rfq', `非标定制 RFQ 核价表 (${rfqs.length})`],
          ['list', `全部报价单与审批 (${quotations.length})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px inline-flex h-9 items-center border-b-2 px-3 text-xs font-medium transition-colors ${
              tab === key ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* TAB 1: Standard 3-Column Quotation Builder */}
      {tab === 'builder' ? (
        <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_21rem]">
          {/* Left: Customer & Product Picker */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">选择报价客户</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger><SelectValue placeholder="请选择客户" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.company ? `${c.name} · ${c.company}` : c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedCustomer ? (
                  <div className="space-y-1 rounded-md bg-muted/40 p-2.5">
                    <p className="font-semibold">{selectedCustomer.name}</p>
                    {selectedCustomer.company ? <p className="text-muted-foreground">{selectedCustomer.company}</p> : null}
                    <p className="text-muted-foreground">国家：{selectedCustomer.country || '未填'}</p>
                    <Link to={customerDetailPath(selectedCustomer.id)} className="inline-block pt-1 text-primary hover:underline">
                      查看客户档案 →
                    </Link>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm"><Package className="h-4 w-4 text-primary" />从产品库一键加入</CardTitle>
                <CardDescription className="text-xs">点击产品自动按阶梯价、MOQ 与交期填入明细</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="搜索 SKU / 名称…" className="h-8 text-xs" />
                <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                  {filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addProductToQuote(p)}
                      className="flex w-full items-center gap-2 rounded-md border border-border p-2 text-left text-xs transition-colors hover:border-primary hover:bg-muted/40"
                    >
                      {p.imageUrl ? (
                        <img src={p.imageUrl} alt={p.name} className="h-9 w-9 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <Package className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.name}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {p.sku}{p.priceTiers[0] ? ` · ${p.priceTiers[0].currency} ${p.priceTiers[0].unitPrice}` : ''}
                        </p>
                      </div>
                      <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
                    </button>
                  ))}
                  {filteredProducts.length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">暂无匹配产品</p> : null}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Middle: Foreign-Trade Quotation Editor */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-1.5 text-base">
                    <ReceiptText className="h-4 w-4 text-primary" />
                    {activeQuotation ? `编辑报价单 · ${activeQuotation.quotationNo}` : '新建外贸报价单'}
                  </CardTitle>
                  <CardDescription className="text-xs">支持 Incoterms、目的港、预估运费、待核价行标记与一键 PDF 导出</CardDescription>
                </div>
                {editingId ? (
                  <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setTitle(''); setRows([EMPTY_ROW()]); }}>
                    新建空白单
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Label>报价标题</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 Custom Velvet Pouches FOB Xiamen Quotation" className="mt-1" />
                </div>
                <div>
                  <Label>报价状态</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as QuotationStatus)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(QUOTATION_STATUS_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <Label>币种</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as QuotationCurrency)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['USD', 'EUR', 'GBP', 'CNY'] as const).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>贸易条款 Incoterm</Label>
                  <Select value={incoterm} onValueChange={(v) => setIncoterm(v as QuotationIncoterm)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INCOTERMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>运输方式</Label>
                  <Select value={shippingMethod} onValueChange={(v) => setShippingMethod(v as QuotationShippingMethod)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SHIPPING_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>目的港 / 目的地</Label>
                  <Input value={destinationPort} onChange={(e) => setDestinationPort(e.target.value)} placeholder="如 Los Angeles (LAX)" className="mt-1" />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label>预估运费 ({currency})</Label>
                  <Input type="number" min={0} step="0.01" value={estimatedFreight} onChange={(e) => setEstimatedFreight(Number(e.target.value) || 0)} className="mt-1" />
                </div>
                <div>
                  <Label>预计交期</Label>
                  <Input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} placeholder="15–20 days" className="mt-1" />
                </div>
                <div>
                  <Label>付款条款</Label>
                  <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="30% deposit, 70% before shipment" className="mt-1" />
                </div>
              </div>

              {/* Line Items Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">商品报价明细（{rows.length} 行）</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRows((prev) => [...prev, EMPTY_ROW()])}>
                    <Plus className="h-3 w-3" />添加行
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted/50 text-[11px] text-muted-foreground">
                      <tr>
                        <th className="p-2">产品名称 / 规格</th>
                        <th className="w-24 p-2">数量</th>
                        <th className="w-24 p-2">单价 ({currency})</th>
                        <th className="w-24 p-2">核价状态</th>
                        <th className="w-24 p-2 text-right">小计</th>
                        <th className="w-9 p-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((r, idx) => (
                        <tr key={idx}>
                          <td className="space-y-1 p-1.5">
                            <Input value={r.productName} onChange={(e) => setRows((p) => p.map((x, i) => i === idx ? { ...x, productName: e.target.value } : x))} placeholder="产品名称" className="h-7 text-xs" />
                            <Input value={r.model} onChange={(e) => setRows((p) => p.map((x, i) => i === idx ? { ...x, model: e.target.value } : x))} placeholder="规格/材质/颜色（选填）" className="h-6 text-[11px]" />
                          </td>
                          <td className="p-1.5">
                            <Input type="number" min={1} value={r.quantity} onChange={(e) => updateRowQty(idx, Number(e.target.value) || 0)} className="h-7 text-xs" />
                          </td>
                          <td className="p-1.5">
                            <Input type="number" min={0} step="0.01" value={r.unitPrice} onChange={(e) => setRows((p) => p.map((x, i) => i === idx ? { ...x, unitPrice: Number(e.target.value) || 0 } : x))} className="h-7 text-xs" />
                          </td>
                          <td className="p-1.5">
                            <Select value={r.pricingStatus} onValueChange={(v) => setRows((p) => p.map((x, i) => i === idx ? { ...x, pricingStatus: v as 'approved' | 'pending' } : x))}>
                              <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="approved">已批准</SelectItem>
                                <SelectItem value="pending">待核价</SelectItem>
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="p-1.5 text-right font-medium tabular-nums">
                            {formatMoney(roundMoney((Number(r.quantity) || 0) * (Number(r.unitPrice) || 0)), currency)}
                          </td>
                          <td className="p-1.5 text-center">
                            {rows.length > 1 ? (
                              <button type="button" onClick={() => setRows((p) => p.filter((_, i) => i !== idx))} className="text-muted-foreground hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
                <div>
                  <Label>报价备注</Label>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="如样品费说明、大货交期起算点、包装说明…" className="mt-1 text-xs" />
                </div>
                <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex justify-between text-muted-foreground">
                    <span>产品小计</span>
                    <span className="tabular-nums">{formatMoney(productSubtotal, currency)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>预估运费</span>
                    <span className="tabular-nums">{formatMoney(Number(estimatedFreight) || 0, currency)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1.5 text-sm font-bold">
                    <span>报价总额 ({incoterm})</span>
                    <span className="tabular-nums text-primary">{formatMoney(grandTotal, currency)}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button loading={saving} onClick={() => void saveQuotation()}>
                  <CheckCircle2 className="h-4 w-4" />{editingId ? '保存更新' : '保存报价单'}
                </Button>
                {editingId ? (
                  <>
                    <Button variant="outline" onClick={() => void downloadFile(`/quotations/${editingId}/pdf`, `${activeQuotation?.quotationNo || 'quotation'}.pdf`)}>
                      <FileText className="h-4 w-4" />导出 PDF 报价单
                    </Button>
                    <Button variant="outline" onClick={() => void submitApproval(editingId)}>
                      <ShieldCheck className="h-4 w-4" />提交内部审批
                    </Button>
                    {canApprove && activeQuotation?.approvalStatus === 'pending_approval' ? (
                      <>
                        <Button size="sm" variant="outline" className="border-emerald-400 text-emerald-700" onClick={() => void reviewApproval(editingId, 'approved')}>核准</Button>
                        <Button size="sm" variant="outline" className="border-destructive text-destructive" onClick={() => void reviewApproval(editingId, 'rejected')}>驳回</Button>
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Right: AI Pricing Copilot */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    <Sparkles className="h-4 w-4 text-primary" />AI 报价体检副驾驶
                  </CardTitle>
                  <Button size="sm" variant="outline" className="h-7 text-xs" loading={checking} onClick={() => void runLiveQuoteCheck()}>
                    <Calculator className="h-3 w-3" />实时体检
                  </Button>
                </div>
                <CardDescription className="text-xs">核对目录阶梯价、MOQ、预计毛利率与历史底价</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                {config?.pricingMode === 'costing_approved' ? (
                  <div className="rounded-md border border-amber-300/60 bg-amber-50/50 p-2.5 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    当前为「非标定制 · 核算员核价」模式：价格请以核算员批准行为准；含“待核价”行时，AI 邮件护栏会自动禁止写全单总价。
                  </div>
                ) : null}

                {!quoteCheck ? (
                  <p className="text-muted-foreground">添加产品并点击「实时体检」，查看目录价偏差、毛利率预警和风险提示。</p>
                ) : (
                  <div className="space-y-2">
                    <div className="rounded-md bg-muted/50 p-2 font-medium">
                      {quoteCheck.summary.message}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        (通过 {quoteCheck.summary.matched} · 提醒 {quoteCheck.summary.warnings} · 阻断 {quoteCheck.summary.blockers})
                      </span>
                    </div>
                    {quoteCheck.items.map((it, idx) => (
                      <div key={idx} className="space-y-1 rounded-md border border-border p-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate font-semibold">{it.requestedName}</span>
                          <Badge variant={it.status === 'matched' ? 'outline' : it.status === 'below_catalog' || it.status === 'price_mismatch' ? 'destructive' : 'warning'} className="text-[10px]">
                            {it.status}
                          </Badge>
                        </div>
                        {it.margin ? (
                          <p className={`text-[11px] font-medium ${it.margin.belowTarget ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300'}`}>
                            预计毛利率：{it.margin.marginPct}%（目标 ≥ {it.margin.targetMarginPct}% · 成本 {it.margin.unitCost}）
                          </p>
                        ) : null}
                        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                          {it.messages.map((m, mi) => <li key={mi}>· {m}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <History className="h-4 w-4 text-primary" />同款历史报价参考
                </CardTitle>
                <CardDescription className="text-xs">本项目历史报价单记录（防乱报底价）</CardDescription>
              </CardHeader>
              <CardContent className="text-xs">
                {historyRefs.length === 0 ? (
                  <p className="text-muted-foreground">点击左侧产品或运行体检后，自动展示同款历史报价。</p>
                ) : (
                  <div className="divide-y divide-border">
                    {historyRefs.map((ref, i) => (
                      <div key={`${ref.quotationId}-${i}`} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{ref.customerName}{ref.customerCountry ? ` (${ref.customerCountry})` : ''}</p>
                          <p className="text-[11px] text-muted-foreground">{formatDate(ref.createdAt)} · {ref.quantity} pcs</p>
                        </div>
                        <span className="shrink-0 font-semibold tabular-nums">{ref.currency} {ref.unitPrice}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {/* TAB 2: Custom RFQ Costing Workbench */}
      {tab === 'rfq' ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{rfqEditingId ? '编辑非标 RFQ 核价单' : '新建非标定制 RFQ 核价单'}</CardTitle>
              <CardDescription className="text-xs">
                支持多数量档（如 300/500/1000）并行核价，自动校验小尺寸烫金、食品接触、美国纸袋反倾销税与纸袋+礼盒包装系统联动。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <Label>客户</Label>
                  <Select value={rfqCustomerId} onValueChange={setRfqCustomerId}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="选择客户" /></SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.company || c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>RFQ 标题</Label>
                  <Input value={rfqTitle} onChange={(e) => setRfqTitle(e.target.value)} placeholder="如 Velvet Pouch + Magnetic Box" className="mt-1" />
                </div>
                <div>
                  <Label>目的地（自动检反倾销）</Label>
                  <Input value={rfqDestination} onChange={(e) => setRfqDestination(e.target.value)} placeholder="如 USA / Los Angeles" className="mt-1" />
                </div>
                <div>
                  <Label>贸易条款</Label>
                  <Input value={rfqIncoterm} onChange={(e) => setRfqIncoterm(e.target.value)} placeholder="FOB Xiamen" className="mt-1" />
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-[11px] text-muted-foreground">
                    <tr>
                      <th className="p-2">产品/结构</th>
                      <th className="p-2">材质</th>
                      <th className="p-2">尺寸</th>
                      <th className="p-2">数量档</th>
                      <th className="p-2">Logo工艺</th>
                      <th className="p-2">颜色(PMS)</th>
                      <th className="p-2">核算单价</th>
                      <th className="p-2">状态</th>
                      <th className="w-8 p-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rfqLines.map((line, idx) => (
                      <tr key={idx}>
                        <td className="p-1"><Input value={line.product} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, product: e.target.value } : x))} placeholder="Velvet pouch" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input value={line.material || ''} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, material: e.target.value } : x))} placeholder="Velvet" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input value={line.size || ''} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, size: e.target.value } : x))} placeholder="10x12 cm" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input value={line.qty} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, qty: e.target.value } : x))} placeholder="300/500/1000" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input value={line.logo || ''} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, logo: e.target.value } : x))} placeholder="Gold foil" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input value={line.color || ''} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, color: e.target.value } : x))} placeholder="Black / PMS" className="h-7 text-xs" /></td>
                        <td className="p-1"><Input type="number" min={0} step="0.01" value={line.approvedUnitPrice ?? ''} onChange={(e) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, approvedUnitPrice: e.target.value ? Number(e.target.value) : undefined } : x))} placeholder="核算填" className="h-7 w-20 text-xs" /></td>
                        <td className="p-1">
                          <Select value={line.pricingStatus ?? 'pending'} onValueChange={(v) => setRfqLines((p) => p.map((x, i) => i === idx ? { ...x, pricingStatus: v as 'pending' | 'approved' } : x))}>
                            <SelectTrigger className="h-7 w-20 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">待核</SelectItem>
                              <SelectItem value="approved">已批</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-1 text-center">
                          {rfqLines.length > 1 ? (
                            <button type="button" onClick={() => setRfqLines((p) => p.filter((_, i) => i !== idx))} className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setRfqLines((p) => [...p, EMPTY_RFQ_LINE()])}>
                  <Plus className="h-3.5 w-3.5" />添加规格行
                </Button>
                <Button size="sm" loading={saving} onClick={() => void saveRfq()}>
                  <CheckCircle2 className="h-3.5 w-3.5" />{rfqEditingId ? '保存 RFQ 修改' : '保存 RFQ 核价单'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">已有 RFQ 核价单（{rfqs.length}）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs">
              {rfqs.length === 0 ? <p className="text-muted-foreground">暂无 RFQ 核价单</p> : rfqs.map((r) => (
                <div key={r.id} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{r.rfqNo} · {r.title}</p>
                      <p className="text-[11px] text-muted-foreground">{r.customer?.company || r.customer?.name} · {r.destination || '未定目的地'}</p>
                    </div>
                    <Badge variant={r.evaluation.ready ? 'outline' : 'warning'} className="shrink-0 text-[10px]">{r.status}</Badge>
                  </div>
                  <p className="text-[11px] font-medium text-foreground/90">{r.evaluation.statusText}</p>
                  {r.evaluation.issues.length > 0 ? (
                    <ul className="space-y-0.5 rounded bg-amber-50/70 p-2 text-[11px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                      {r.evaluation.issues.slice(0, 4).map((iss, i) => (
                        <li key={i} className="flex items-start gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{iss}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => {
                      setRfqEditingId(r.id);
                      setRfqCustomerId(r.customerId);
                      setRfqTitle(r.title);
                      setRfqDestination(r.destination);
                      setRfqIncoterm(r.incoterm);
                      setRfqNotes(r.notes);
                      setRfqLines(r.lines);
                    }}>编辑</Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void downloadFile(`/workbench/rfqs/${r.id}/costing-xlsx`, `${r.rfqNo}-costing.xlsx`)}>
                      <FileSpreadsheet className="h-3 w-3" />导核价表
                    </Button>
                    <Button size="sm" className="h-7 text-[11px]" onClick={() => void convertRfq(r)}>
                      <Download className="h-3 w-3" />转报价单
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto h-7 px-1.5 text-destructive" onClick={() => void apiDelete(`/workbench/rfqs/${r.id}`).then(() => loadAll())}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* TAB 3: All Quotations & Approval Queue */}
      {tab === 'list' ? (
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
            ) : quotations.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">暂无报价单</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="p-3">报价单号 / 标题</th>
                      <th className="p-3">客户</th>
                      <th className="p-3">条款 / 目的港</th>
                      <th className="p-3 text-right">金额</th>
                      <th className="p-3">状态 / 审批</th>
                      <th className="p-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {quotations.map((q) => {
                      const ap = APPROVAL_LABELS[q.approvalStatus ?? 'none'] ?? APPROVAL_LABELS.none;
                      return (
                        <tr key={q.id} className="hover:bg-muted/30">
                          <td className="p-3">
                            <p className="font-mono font-semibold">{q.quotationNo}</p>
                            <p className="text-muted-foreground">{q.title}</p>
                          </td>
                          <td className="p-3">
                            {q.customer ? (
                              <Link to={customerDetailPath(q.customerId)} className="font-medium hover:text-primary hover:underline">
                                {q.customer.company || q.customer.name}
                              </Link>
                            ) : q.customerId}
                          </td>
                          <td className="p-3 text-muted-foreground">
                            {q.incoterm || '—'}{q.destinationPort ? ` · ${q.destinationPort}` : ''}
                          </td>
                          <td className="p-3 text-right font-semibold tabular-nums">
                            {formatMoney(q.grandTotal ?? q.totalAmount, q.currency)}
                          </td>
                          <td className="p-3">
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="outline" className="text-[10px]">{QUOTATION_STATUS_LABEL[q.status]}</Badge>
                              {q.approvalStatus && q.approvalStatus !== 'none' ? (
                                <Badge variant={ap.tone} className="text-[10px]">{ap.label}</Badge>
                              ) : null}
                            </div>
                          </td>
                          <td className="p-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => loadQuotationToEditor(q)}>编辑</Button>
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void downloadFile(`/quotations/${q.id}/pdf`, `${q.quotationNo}.pdf`)}>PDF</Button>
                              {canApprove && q.approvalStatus === 'pending_approval' ? (
                                <>
                                  <Button size="sm" className="h-7 text-[11px]" onClick={() => void reviewApproval(q.id, 'approved')}>核准</Button>
                                  <Button size="sm" variant="outline" className="h-7 text-[11px] text-destructive" onClick={() => void reviewApproval(q.id, 'rejected')}>驳回</Button>
                                </>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
