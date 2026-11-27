import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Archive, ArrowRight, CheckCircle2, DollarSign, Download, FileSpreadsheet, Layers3, Loader2, PackageOpen, Pencil, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { DataPagination } from '@/components/common/data-pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiDelete, apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/hooks/use-ui';
import { PRODUCT_IMPORT_TEMPLATE_URL, parseProductWorkbook } from '@/lib/product-excel';
import { useAuthStore, selectIsAdmin } from '@/store/auth.store';
import { useProjectStore } from '@/store/project.store';
import type { Product, ProductImportResult, ProductPriceTier, ProductSpec } from '@/types';

type SpecDraft = { code: string; name: string; value: string; unit: string };
type TierDraft = {
  minQuantity: string; maxQuantity: string; unitPrice: string;
  currency: ProductPriceTier['currency']; moq: string; leadTime: string;
};
type Draft = {
  id?: string; sku: string; name: string; category: string; description: string;
  status: 'active' | 'archived'; moq: string; leadTime: string; notes: string;
  specs: SpecDraft[]; priceTiers: TierDraft[];
};

function emptySpec(): SpecDraft { return { code: '', name: '', value: '', unit: '' }; }
function emptyTier(): TierDraft { return { minQuantity: '', maxQuantity: '', unitPrice: '', currency: 'USD', moq: '', leadTime: '' }; }
function makeEmptyDraft(): Draft {
  return {
    sku: '', name: '', category: '', description: '', status: 'active', moq: '', leadTime: '', notes: '',
    specs: [emptySpec()], priceTiers: [emptyTier()],
  };
}

function draftSpecs(rows: SpecDraft[]): ProductSpec[] {
  const filled = rows.filter((row) => row.code.trim() || row.name.trim() || row.value.trim() || row.unit.trim());
  return filled.map((row, index) => {
    const code = row.code.trim();
    const name = row.name.trim();
    const value = row.value.trim();
    if (!code) throw new Error(`规格第 ${index + 1} 行：请填写规格编码`);
    if (!name) throw new Error(`规格第 ${index + 1} 行：请填写规格名称`);
    if (!value) throw new Error(`规格第 ${index + 1} 行：请填写规格值`);
    return { code, name, value, unit: row.unit.trim() || undefined };
  });
}

function draftTiers(rows: TierDraft[]): ProductPriceTier[] {
  const filled = rows.filter((row) => row.minQuantity.trim() || row.maxQuantity.trim() || row.unitPrice.trim() || row.moq.trim() || row.leadTime.trim());
  const tiers = filled.map((row, index) => {
    const minQuantity = Number(row.minQuantity);
    const unitPrice = Number(row.unitPrice);
    if (!Number.isInteger(minQuantity) || minQuantity <= 0) throw new Error(`价格档第 ${index + 1} 行：起订数量必须是大于 0 的整数`);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error(`价格档第 ${index + 1} 行：单价必须大于 0`);
    const maxQuantity = row.maxQuantity.trim() ? Number(row.maxQuantity) : undefined;
    if (maxQuantity !== undefined && (!Number.isInteger(maxQuantity) || maxQuantity <= 0 || maxQuantity < minQuantity)) {
      throw new Error(`价格档第 ${index + 1} 行：最高数量必须为空或大于等于起订数量`);
    }
    return {
      minQuantity, maxQuantity, unitPrice,
      currency: row.currency,
      moq: row.moq.trim() || undefined,
      leadTime: row.leadTime.trim() || undefined,
    };
  });
  tiers.sort((left, right) => left.minQuantity - right.minQuantity);
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    if (previous.maxQuantity === undefined || tiers[index].minQuantity <= previous.maxQuantity) {
      throw new Error('价格档必须按数量升序，且区间不能重叠；上一档请填写最高数量');
    }
  }
  return tiers;
}



function priceSummary(product: Product): string {
  if (!product.priceTiers.length) return '未维护价格';
  return product.priceTiers.map((tier) => `${tier.minQuantity}${tier.maxQuantity ? `–${tier.maxQuantity}` : '+'} @ ${tier.currency} ${tier.unitPrice}`).join(' · ');
}

export function ProductsPage(): React.JSX.Element {
  usePageTitle('产品价格');
  const isAdmin = useAuthStore(selectIsAdmin);
  const project = useProjectStore((state) => state.activeProject);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [total, setTotal] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<'all' | 'active' | 'archived'>('all');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [editing, setEditing] = React.useState<Draft | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importFile, setImportFile] = React.useState<File | null>(null);
  const [importError, setImportError] = React.useState('');
  const importFileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '200', status });
      if (search.trim()) params.set('search', search.trim());
      const data = await apiGet<{ items: Product[]; total: number }>(`/products?${params.toString()}`);
      setProducts(data.items); setTotal(data.total);
    } catch (reason) { setError(toErrorMessage(reason)); }
    finally { setLoading(false); }
  }, [search, status]);

  React.useEffect(() => { void load(); }, [load, project?.id]);

  async function save() {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const body = {
        sku: editing.sku.trim(), name: editing.name.trim(), category: editing.category.trim() || undefined,
        description: editing.description.trim() || undefined, status: editing.status,
        moq: editing.moq.trim() || undefined, leadTime: editing.leadTime.trim() || undefined, notes: editing.notes.trim() || undefined,
        specs: draftSpecs(editing.specs), priceTiers: draftTiers(editing.priceTiers),
      };
      if (!body.sku) throw new Error('请填写 SKU');
      if (!body.name) throw new Error('请填写产品名称');
      if (editing.id) await apiPut(`/products/${editing.id}`, body);
      else await apiPost('/products', body);
      toast.success(editing.id ? '产品已更新' : '产品已创建');
      setEditing(null); await load();
    } catch (reason) { toast.error(toErrorMessage(reason)); }
    finally { setBusy(false); }
  }

  function openProduct(product: Product) {
    setEditing({
      id: product.id, sku: product.sku, name: product.name, category: product.category ?? '',
      description: product.description ?? '', status: product.status, moq: product.moq ?? '',
      leadTime: product.leadTime ?? '', notes: product.notes ?? '',
      specs: product.specs.length ? product.specs.map((spec) => ({
        code: spec.code, name: spec.name, value: spec.value, unit: spec.unit ?? '',
      })) : [emptySpec()],
      priceTiers: product.priceTiers.length ? product.priceTiers.map((tier) => ({
        minQuantity: String(tier.minQuantity),
        maxQuantity: tier.maxQuantity === undefined ? '' : String(tier.maxQuantity),
        unitPrice: String(tier.unitPrice),
        currency: tier.currency,
        moq: tier.moq ?? '',
        leadTime: tier.leadTime ?? '',
      })) : [emptyTier()],
    });
  }

  function patchSpec(index: number, patch: Partial<SpecDraft>) {
    setEditing((current) => current ? {
      ...current,
      specs: current.specs.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    } : current);
  }

  function patchTier(index: number, patch: Partial<TierDraft>) {
    setEditing((current) => current ? {
      ...current,
      priceTiers: current.priceTiers.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    } : current);
  }

  function openImportDialog() {
    setImportFile(null);
    setImportError('');
    if (importFileRef.current) importFileRef.current.value = '';
    setImportOpen(true);
  }

  async function archive(product: Product) {
    if (!isAdmin || busy || product.status === 'archived') return;
    if (!window.confirm(`归档 ${product.sku} ${product.name}？归档后不会出现在报价核对中。`)) return;
    setBusy(true);
    try { await apiDelete(`/products/${product.id}`); toast.success('产品已归档'); await load(); }
    catch (reason) { toast.error(toErrorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function importProducts() {
    if (!importFile || busy) return;
    setBusy(true); setImportError('');
    try {
      const productsInput = await parseProductWorkbook(importFile);
      const result = await apiPost<ProductImportResult>('/products/import', { products: productsInput });
      toast.success(`导入完成：新增 ${result.created}，更新 ${result.updated}`);
      setImportOpen(false); setImportFile(null); await load();
    } catch (reason) {
      const message = toErrorMessage(reason);
      setImportError(message);
      toast.error(message);
    } finally { setBusy(false); }
  }

  const activeCount = products.filter((item) => item.status === 'active').length;
  const archivedCount = products.filter((item) => item.status === 'archived').length;
  const specCount = products.reduce((sum, item) => sum + item.specs.length, 0);
  const tierCount = products.reduce((sum, item) => sum + item.priceTiers.length, 0);

  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedProducts = React.useMemo(
    () => products.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [products, currentPage, pageSize],
  );

  React.useEffect(() => {
    setPage(1);
  }, [search, status, project?.id]);

  React.useEffect(() => {
    if (products.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !products.some((item) => item.id === selectedId)) {
      setSelectedId(pagedProducts[0]?.id ?? products[0]?.id ?? null);
    }
  }, [products, pagedProducts, selectedId]);

  const selectedProduct = React.useMemo(
    () => products.find((item) => item.id === selectedId) ?? pagedProducts[0] ?? products[0] ?? null,
    [products, pagedProducts, selectedId],
  );
  const selectedVisibleSpecs = React.useMemo(
    () => (selectedProduct ? selectedProduct.specs.filter((s) => s.code !== 'PRICE_RANGE') : []),
    [selectedProduct],
  );
  const selectedRefRange = React.useMemo(
    () => selectedProduct?.specs.find((s) => s.code === 'PRICE_RANGE')?.value,
    [selectedProduct],
  );

  return <section className="workspace-page">
    <PageHeader
      title="产品 / 规格 / 价格"
      description="维护统一 SKU、规格和阶梯价，作为询盘报价的内部核对依据；价格目录不会自动变成客户承诺。"
      actions={<>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="刷新产品目录"><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /><span className="hidden sm:inline">刷新</span></Button>
        {isAdmin && <Button asChild variant="outline" size="sm"><a href={PRODUCT_IMPORT_TEMPLATE_URL} download="产品价格导入模板.xlsx"><Download className="h-4 w-4" /><span className="hidden sm:inline">下载模板</span></a></Button>}
        {isAdmin && <Button variant="outline" size="sm" onClick={openImportDialog}><Upload className="h-4 w-4" /><span className="hidden sm:inline">批量导入</span></Button>}
        {isAdmin && <Button size="sm" onClick={() => setEditing(makeEmptyDraft())}><Plus className="h-4 w-4" />新增产品</Button>}
      </>}
    />

    {/* Unified SKU & Tier-Pricing Telemetry Ribbon */}
    <div className="os-telemetry-strip">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center divide-x divide-border/70">
          <div className="flex items-baseline gap-2 pr-4">
            <PackageOpen className="h-3.5 w-3.5 self-center text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">产品总数</span>
            <span className="text-lg font-bold tabular-nums tracking-tight text-foreground">{total}</span>
          </div>
          <div className="flex items-baseline gap-2 px-4">
            <CheckCircle2 className="h-3.5 w-3.5 self-center text-emerald-600" aria-hidden />
            <span className="text-xs text-muted-foreground">已启用 SKU</span>
            <span className="text-lg font-bold tabular-nums tracking-tight text-foreground">{activeCount}</span>
          </div>
          <div className="flex items-baseline gap-2 px-4">
            <Layers3 className="h-3.5 w-3.5 self-center text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">规格参数项</span>
            <span className="text-lg font-bold tabular-nums tracking-tight text-foreground">{specCount}</span>
          </div>
          <div className="flex items-baseline gap-2 pl-4">
            <DollarSign className="h-3.5 w-3.5 self-center text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">阶梯价格档</span>
            <span className="text-lg font-bold tabular-nums tracking-tight text-foreground">{tierCount}</span>
          </div>
        </div>

        <div className="os-segmented" role="tablist" aria-label="产品状态筛选">
          {([
            ['all', `全部 (${products.length})`],
            ['active', `启用 (${activeCount})`],
            ['archived', `已归档 (${archivedCount})`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatus(key)}
              className={`os-segmented-item text-xs ${status === key ? 'os-segmented-item-active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>

    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_328px] xl:items-stretch">
    <div className="panel flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="h-9 pl-8 text-xs" placeholder="搜索 SKU、产品名、规格值…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}><SelectTrigger className="h-9 w-[124px] text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">启用</SelectItem><SelectItem value="archived">已归档</SelectItem></SelectContent></Select>
      </div>
      {error && <div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {loading ? <div className="flex flex-1 items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载产品目录…</div> : products.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface"><PackageOpen className="h-5 w-5 text-muted-foreground" aria-hidden /></span>
        <p className="mt-3 text-sm font-semibold">还没有产品</p>
        <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{isAdmin ? '可以手工新增，或下载 Excel 模板批量导入产品、规格和价格档。' : '请联系项目管理员维护产品目录后再做报价核对。'}</p>
        {isAdmin ? <div className="mt-4 flex flex-wrap justify-center gap-2"><Button size="sm" variant="outline" onClick={openImportDialog}><Upload className="h-3.5 w-3.5" />批量导入</Button><Button size="sm" onClick={() => setEditing(makeEmptyDraft())}><Plus className="h-3.5 w-3.5" />新增产品</Button></div> : null}
      </div> : <>
        <div className="flex-1 overflow-x-auto">
          <table className="w-full min-w-[740px] table-fixed text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-[27%] p-3 font-medium">SKU / 产品</th>
                <th className="w-[23%] p-3 font-medium">关键规格</th>
                <th className="w-[16%] p-3 font-medium">阶梯价 / 参考</th>
                <th className="w-[15%] p-3 font-medium">MOQ / 交期</th>
                <th className="w-[11%] whitespace-nowrap p-3 font-medium">更新时间</th>
                <th className="w-[8%] whitespace-nowrap p-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>{pagedProducts.map((product) => {
              const visibleSpecs = product.specs.filter((s) => s.code !== 'PRICE_RANGE');
              const refRange = product.specs.find((s) => s.code === 'PRICE_RANGE')?.value;
              const isSelected = selectedProduct?.id === product.id;
              return <tr
                key={product.id}
                onClick={() => setSelectedId(product.id)}
                className={`cursor-pointer border-t align-top transition-colors hover:bg-surface/65 ${isSelected ? 'bg-foreground/[0.035]' : ''}`}
              >
                <td className="p-3">
                  <div className="flex items-start gap-2.5">
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-10 w-10 shrink-0 rounded-md border border-border object-cover bg-muted/30"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface font-mono text-[10px] font-semibold text-muted-foreground">
                        {product.sku.slice(0, 4)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold">{product.sku}</span>
                        <Badge variant={product.status === 'active' ? 'developed' : 'secondary'}>{product.status === 'active' ? '启用' : '已归档'}</Badge>
                      </div>
                      <div className="mt-1 break-words text-[13px] font-medium leading-snug">{product.name}</div>
                      {product.category && <div className="mt-0.5 text-xs text-muted-foreground">{product.category}</div>}
                    </div>
                  </div>
                </td>
                <td className="p-3">
                  <div className="space-y-1 overflow-hidden">
                    {visibleSpecs.length ? visibleSpecs.slice(0, 3).map((spec) => (
                      <div
                        key={`${spec.code}-${spec.value}`}
                        title={`${spec.name}: ${spec.value}${spec.unit ? ` ${spec.unit}` : ''}`}
                        className="truncate rounded border border-border/70 bg-muted/25 px-2 py-0.5 text-[11px] leading-5 text-foreground/90"
                      >
                        <span className="font-medium text-muted-foreground">{spec.name}：</span>
                        <span>{spec.value}{spec.unit ? ` ${spec.unit}` : ''}</span>
                      </div>
                    )) : <span className="text-xs text-muted-foreground">未维护</span>}
                    {visibleSpecs.length > 3 && (
                      <div className="text-[11px] text-muted-foreground">+{visibleSpecs.length - 3} 项规格（右侧查看全量）</div>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  <div className="break-words text-xs leading-5">
                    {product.priceTiers.length > 0 ? (
                      priceSummary(product)
                    ) : refRange ? (
                      <div className="space-y-0.5">
                        <div className="font-medium text-foreground">按需核价</div>
                        <div className="text-[11px] text-muted-foreground">{refRange}</div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{priceSummary(product)}</span>
                    )}
                  </div>
                </td>
                <td className="p-3 text-xs leading-5">
                  <div className="break-words font-medium">MOQ: {product.moq || '—'}</div>
                  <div className="mt-0.5 break-words text-[11px] text-muted-foreground">交期: {product.leadTime || '—'}</div>
                </td>
                <td className="whitespace-nowrap p-3 text-[11px] text-muted-foreground tabular-nums">{formatDateTime(product.updatedAt).slice(0, 10)}</td>
                <td className="p-3 text-right" onClick={(event) => event.stopPropagation()}>
                  <div className="flex flex-col items-end gap-1">
                    {isAdmin && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openProduct(product)}><Pencil className="h-3.5 w-3.5" />编辑</Button>}
                    {isAdmin && product.status === 'active' && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void archive(product)}><Archive className="h-3.5 w-3.5" />归档</Button>}
                  </div>
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <DataPagination
          page={currentPage}
          limit={pageSize}
          total={products.length}
          totalPages={totalPages}
          onPageChange={setPage}
          onLimitChange={(next) => { setPageSize(next); setPage(1); }}
          className="mt-auto bg-surface/30"
        />
      </>}
    </div>

    {/* Right-Hand Full-Height Live SKU & Tier-Price Inspector */}
    <aside className="panel flex flex-col overflow-hidden text-xs">
      {selectedProduct ? (
        <>
          <div className="border-b border-border/70 bg-surface/45 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                {selectedProduct.imageUrl ? (
                  <img
                    src={selectedProduct.imageUrl}
                    alt={selectedProduct.name}
                    className="h-11 w-11 shrink-0 rounded-lg border border-border object-cover bg-card"
                  />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card font-mono text-xs font-bold text-foreground">
                    {selectedProduct.sku.slice(0, 4)}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs font-bold text-foreground">{selectedProduct.sku}</span>
                    <Badge variant={selectedProduct.status === 'active' ? 'developed' : 'secondary'}>
                      {selectedProduct.status === 'active' ? '启用' : '已归档'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {selectedProduct.category || '未分类目录项'}
                  </p>
                </div>
              </div>
              {isAdmin ? (
                <Button variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => openProduct(selectedProduct)}>
                  <Pencil className="h-3 w-3" />编辑
                </Button>
              ) : null}
            </div>
            <h2 className="mt-2.5 text-sm font-semibold leading-snug text-foreground">{selectedProduct.name}</h2>
            {selectedProduct.description ? (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{selectedProduct.description}</p>
            ) : null}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* MOQ & Lead Time Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/70 bg-surface/55 p-2.5">
                <span className="text-[11px] text-muted-foreground">标准 MOQ</span>
                <p className="mt-0.5 font-semibold text-foreground">{selectedProduct.moq || '按规格核定'}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-surface/55 p-2.5">
                <span className="text-[11px] text-muted-foreground">标准交期</span>
                <p className="mt-0.5 font-semibold text-foreground">{selectedProduct.leadTime || '按排产核定'}</p>
              </div>
            </div>

            {/* Tier Pricing Matrix */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">阶梯价格与核价区间</span>
                <span className="text-[11px] text-muted-foreground">
                  {selectedProduct.priceTiers.length > 0 ? `${selectedProduct.priceTiers.length} 档` : '工程核价'}
                </span>
              </div>
              {selectedProduct.priceTiers.length > 0 ? (
                <div className="divide-y divide-border/70 rounded-lg border border-border/80 bg-surface/35">
                  {selectedProduct.priceTiers.map((tier, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div>
                        <span className="font-mono font-medium text-foreground">
                          {tier.minQuantity}{tier.maxQuantity ? `–${tier.maxQuantity}` : '+'} pcs
                        </span>
                        {(tier.moq || tier.leadTime) ? (
                          <p className="text-[10px] text-muted-foreground">
                            {[tier.moq && `MOQ ${tier.moq}`, tier.leadTime && `交期 ${tier.leadTime}`].filter(Boolean).join(' · ')}
                          </p>
                        ) : null}
                      </div>
                      <span className="font-mono text-xs font-bold text-foreground">
                        {tier.currency} {tier.unitPrice.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : selectedRefRange ? (
                <div className="rounded-lg border border-border/80 bg-surface/50 p-3">
                  <p className="font-medium text-foreground">按需定制核价（参考区间）</p>
                  <p className="mt-1 leading-relaxed text-muted-foreground">{selectedRefRange}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-3 text-muted-foreground">
                  暂未录入固定阶梯价，可在报价与 RFQ 工作台按客户定制参数核定单价。
                </div>
              )}
            </div>

            {/* Full Unclipped Specification List */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">全量工艺与规格参数</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{selectedVisibleSpecs.length} 项</span>
              </div>
              {selectedVisibleSpecs.length > 0 ? (
                <div className="divide-y divide-border/60 rounded-lg border border-border/70 bg-card">
                  {selectedVisibleSpecs.map((spec) => (
                    <div key={`${spec.code}-${spec.value}`} className="px-3 py-2">
                      <div className="text-[11px] font-medium text-muted-foreground">{spec.name}</div>
                      <div className="mt-0.5 break-words text-xs leading-relaxed text-foreground">
                        {spec.value}{spec.unit ? ` ${spec.unit}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border p-3 text-muted-foreground">暂无细分规格参数。</p>
              )}
            </div>
          </div>

          <div className="mt-auto space-y-2.5 border-t border-border/70 bg-surface/45 p-3.5">
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden />
              <span>价格核对护栏：按数量区间严格匹配，对外承诺以正式审核报价单为准。</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button asChild size="sm" variant="outline" className="w-full text-xs">
                <Link to="/quotations">
                  <ReceiptText className="h-3.5 w-3.5" />报价工作台
                </Link>
              </Button>
              {isAdmin ? (
                <Button size="sm" variant="outline" className="w-full text-xs" onClick={openImportDialog}>
                  <Upload className="h-3.5 w-3.5" />导入价格表
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline" className="w-full text-xs">
                  <Link to="/knowledge">
                    <ArrowRight className="h-3.5 w-3.5" />知识库依据
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col justify-between p-4">
          <div className="space-y-3">
            <h2 className="section-title flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              价格核对规则
            </h2>
            <div className="space-y-2 text-muted-foreground">
              <div className="rounded-lg bg-surface p-2.5">
                <p className="font-semibold text-foreground">阶梯区间严格匹配</p>
                <p className="mt-0.5 leading-relaxed">报价数量落入对应区间时自动带出单价；未覆盖数量区间不会跨档猜测。</p>
              </div>
              <div className="rounded-lg bg-surface p-2.5">
                <p className="font-semibold text-foreground">内部依据 · 人工承诺</p>
                <p className="mt-0.5 leading-relaxed">本目录仅作 AI 回复核验与报价单制单依据，对外报价以正式审核报价单为准。</p>
              </div>
            </div>
          </div>
          <div className="space-y-2 pt-4">
            {isAdmin ? (
              <>
                <Button size="sm" className="w-full justify-between text-xs" onClick={() => setEditing(makeEmptyDraft())}>
                  <span className="inline-flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" />手工新增产品</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" className="w-full justify-between text-xs" onClick={openImportDialog}>
                  <span className="inline-flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" />批量导入价格表</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : null}
            <Button asChild size="sm" variant="outline" className="w-full text-xs">
              <Link to="/quotations">
                <ReceiptText className="h-3.5 w-3.5" />前往报价与 RFQ 工作台
              </Link>
            </Button>
          </div>
        </div>
      )}
    </aside>
    </div>

    <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>{editing?.id ? '编辑产品' : '新增产品'}</DialogTitle><DialogDescription>产品目录是内部报价依据；客户可见价格仍以正式报价单为准。</DialogDescription></DialogHeader>
        <DialogBody className="max-h-[70vh] space-y-4 overflow-y-auto">
          <div className="grid gap-3 sm:grid-cols-2"><div><Label>SKU *</Label><Input className="mt-1" value={editing?.sku ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, sku: event.target.value } : current)} placeholder="例如 GB-POUCH-01" /></div><div><Label>产品名称 *</Label><Input className="mt-1" value={editing?.name ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, name: event.target.value } : current)} /></div><div><Label>分类</Label><Input className="mt-1" value={editing?.category ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, category: event.target.value } : current)} placeholder="例如 首饰袋" /></div><div><Label>状态</Label><Select value={editing?.status ?? 'active'} onValueChange={(value) => setEditing((current) => current ? { ...current, status: value as Draft['status'] } : current)}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">启用</SelectItem><SelectItem value="archived">已归档</SelectItem></SelectContent></Select></div><div><Label>MOQ</Label><Input className="mt-1" value={editing?.moq ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, moq: event.target.value } : current)} placeholder="例如 100 pcs" /></div><div><Label>交期</Label><Input className="mt-1" value={editing?.leadTime ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, leadTime: event.target.value } : current)} placeholder="例如 25–30 days" /></div></div>
          <div><Label>说明</Label><Textarea className="mt-1" rows={2} value={editing?.description ?? ''} onChange={(event) => setEditing((current) => current ? { ...current, description: event.target.value } : current)} /></div>
          <section className="rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><Label>规格字段</Label><p className="text-xs text-muted-foreground">用于回复询盘时引用，不写进知识库事实。没有规格可直接留空。</p></div>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing((current) => current ? { ...current, specs: [...current.specs, emptySpec()] } : current)}><Plus className="h-3.5 w-3.5" />添加规格</Button>
            </div>
            <div className="mt-3 space-y-2">
              {editing?.specs.map((spec, index) => <div key={`spec-${index}`} className="rounded-md border bg-card p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div><Label htmlFor={`spec-code-${index}`} className="text-xs">规格编码 *</Label><Input id={`spec-code-${index}`} className="mt-1" value={spec.code} onChange={(event) => patchSpec(index, { code: event.target.value })} placeholder="例如 MAT" /></div>
                  <div><Label htmlFor={`spec-name-${index}`} className="text-xs">规格名称 *</Label><Input id={`spec-name-${index}`} className="mt-1" value={spec.name} onChange={(event) => patchSpec(index, { name: event.target.value })} placeholder="例如 材质" /></div>
                  <div><Label htmlFor={`spec-value-${index}`} className="text-xs">规格值 *</Label><Input id={`spec-value-${index}`} className="mt-1" value={spec.value} onChange={(event) => patchSpec(index, { value: event.target.value })} placeholder="例如 棉帆布" /></div>
                  <div><Label htmlFor={`spec-unit-${index}`} className="text-xs">单位</Label><Input id={`spec-unit-${index}`} className="mt-1" value={spec.unit} onChange={(event) => patchSpec(index, { unit: event.target.value })} placeholder="例如 cm、g" /></div>
                </div>
                <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setEditing((current) => current ? { ...current, specs: current.specs.filter((_, rowIndex) => rowIndex !== index) } : current)}><Trash2 className="h-3.5 w-3.5" />删除此行</Button></div>
              </div>)}
              {!editing?.specs.length && <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">暂无规格，点击「添加规格」补材质、尺寸等信息。</p>}
            </div>
          </section>
          <section className="rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><Label>阶梯价</Label><p className="text-xs text-muted-foreground">按数量从小到大填写；上一档填最高数量后，下一档从更高数量开始。最高数量留空表示无上限。</p></div>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing((current) => current ? { ...current, priceTiers: [...current.priceTiers, emptyTier()] } : current)}><Plus className="h-3.5 w-3.5" />添加价格档</Button>
            </div>
            <div className="mt-3 space-y-2">
              {editing?.priceTiers.map((tier, index) => <div key={`tier-${index}`} className="rounded-md border bg-card p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">价格档 {index + 1}</span><Button type="button" variant="ghost" size="sm" onClick={() => setEditing((current) => current ? { ...current, priceTiers: current.priceTiers.filter((_, rowIndex) => rowIndex !== index) } : current)}><Trash2 className="h-3.5 w-3.5" />删除</Button></div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <div><Label htmlFor={`tier-min-${index}`} className="text-xs">起订数量 *</Label><Input id={`tier-min-${index}`} className="mt-1" type="number" min="1" step="1" value={tier.minQuantity} onChange={(event) => patchTier(index, { minQuantity: event.target.value })} placeholder="例如 100" /></div>
                  <div><Label htmlFor={`tier-max-${index}`} className="text-xs">最高数量</Label><Input id={`tier-max-${index}`} className="mt-1" type="number" min="1" step="1" value={tier.maxQuantity} onChange={(event) => patchTier(index, { maxQuantity: event.target.value })} placeholder="留空 = 无上限" /></div>
                  <div><Label htmlFor={`tier-price-${index}`} className="text-xs">单价 *</Label><Input id={`tier-price-${index}`} className="mt-1" type="number" min="0" step="0.01" value={tier.unitPrice} onChange={(event) => patchTier(index, { unitPrice: event.target.value })} placeholder="例如 1.20" /></div>
                  <div><Label htmlFor={`tier-currency-${index}`} className="text-xs">币种</Label><Select value={tier.currency} onValueChange={(value) => patchTier(index, { currency: value as TierDraft['currency'] })}><SelectTrigger id={`tier-currency-${index}`} className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="USD">USD</SelectItem><SelectItem value="EUR">EUR</SelectItem><SelectItem value="GBP">GBP</SelectItem><SelectItem value="CNY">CNY</SelectItem></SelectContent></Select></div>
                  <div><Label htmlFor={`tier-moq-${index}`} className="text-xs">该档 MOQ</Label><Input id={`tier-moq-${index}`} className="mt-1" value={tier.moq} onChange={(event) => patchTier(index, { moq: event.target.value })} placeholder="例如 100 pcs" /></div>
                  <div><Label htmlFor={`tier-lead-${index}`} className="text-xs">该档交期</Label><Input id={`tier-lead-${index}`} className="mt-1" value={tier.leadTime} onChange={(event) => patchTier(index, { leadTime: event.target.value })} placeholder="例如 25–30 days" /></div>
                </div>
              </div>)}
              {!editing?.priceTiers.length && <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">暂无价格档，点击「添加价格档」开始填写。</p>}
            </div>
          </section>
        </DialogBody>
        <DialogFooter><Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>取消</Button><Button onClick={() => void save()} disabled={busy || !editing?.sku.trim() || !editing?.name.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={importOpen} onOpenChange={(open) => { setImportOpen(open); if (!open) { setImportFile(null); setImportError(''); } }}>
      <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>批量导入产品目录</DialogTitle><DialogDescription>当前项目：{project?.name ?? '—'}。下载模板填写后导入，按 SKU 覆盖同项目已有产品。</DialogDescription></DialogHeader>
        <DialogBody className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-start gap-2"><FileSpreadsheet className="mt-0.5 h-4 w-4 text-primary" /><div><div className="text-sm font-medium">使用 Excel 模板</div><p className="mt-1 text-xs leading-5 text-muted-foreground">模板包含「产品」「规格」「阶梯价」三个工作表；同一 SKU 可以填多条规格和多个价格档。说明页有填写示例。</p></div></div>
            <Button asChild variant="outline" size="sm" className="mt-3"><a href={PRODUCT_IMPORT_TEMPLATE_URL} download="产品价格导入模板.xlsx"><Download className="h-3.5 w-3.5" />下载 Excel 模板</a></Button>
          </div>
          <div>
            <Label htmlFor="product-import-file">选择填写后的文件</Label>
            <input ref={importFileRef} id="product-import-file" type="file" accept=".xlsx,.xls,.csv,.ods" className="sr-only" onChange={(event) => { const file = event.target.files?.[0] ?? null; setImportFile(file); setImportError(''); }} />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => importFileRef.current?.click()}><Upload className="h-3.5 w-3.5" />选择文件</Button>
              <span className="text-xs text-muted-foreground">{importFile ? `${importFile.name} · ${(importFile.size / 1024).toFixed(1)} KB` : '支持 .xlsx / .xls / .csv / .ods'}</span>
            </div>
          </div>
          {importError && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">{importError}</div>}
        </DialogBody>
        <DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)} disabled={busy}>取消</Button><Button onClick={() => void importProducts()} disabled={busy || !importFile}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}开始导入</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
