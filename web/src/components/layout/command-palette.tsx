import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, LayoutDashboard, Mail, Package, ReceiptText, Search, ShieldCheck, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { apiGet } from '@/lib/api';
import { customerDetailPath, ROUTES } from '@/constants';
import { useI18n } from '@/i18n';
import type { Customer, Paginated, ProjectPolicyDto, Quotation } from '@/types';

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  sub?: string;
  to: string;
  icon: React.ReactNode;
}

const STATIC_NAV: PaletteItem[] = [
  { id: 'nav-dash', group: '快速跳转', label: '仪表盘 · 业务决策', to: ROUTES.dashboard, icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'nav-cust', group: '快速跳转', label: '客户管理 · 表格 / 漏斗看板', to: ROUTES.customers, icon: <Users className="h-4 w-4" /> },
  { id: 'nav-mail', group: '快速跳转', label: '邮件中心 · 三栏 AI 副驾驶', to: '/mail', icon: <Mail className="h-4 w-4" /> },
  { id: 'nav-quote', group: '快速跳转', label: '报价与 RFQ 工作台', to: ROUTES.quotations, icon: <ReceiptText className="h-4 w-4" /> },
  { id: 'nav-kb', group: '快速跳转', label: '知识库 · AI 问答与对外口径', to: '/knowledge', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'nav-pol', group: '快速跳转', label: '对外口径表与红线护栏', to: '/knowledge?view=policies', icon: <ShieldCheck className="h-4 w-4" /> },
  { id: 'nav-prod', group: '快速跳转', label: '产品与阶梯价格目录', to: ROUTES.products, icon: <Package className="h-4 w-4" /> },
];

export function CommandPalette(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [remoteItems, setRemoteItems] = React.useState<PaletteItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setRemoteItems([]);
      setActiveIndex(0);
      return;
    }
    const q = query.trim();
    if (q.length < 1) {
      setRemoteItems([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const [custRes, quoteRes, polRes] = await Promise.allSettled([
          apiGet<Paginated<Customer>>('/customers', { params: { search: q, limit: 5 } }),
          apiGet<Paginated<Quotation>>('/quotations', { params: { search: q, limit: 4 } }),
          apiGet<ProjectPolicyDto[]>('/workbench/policies', { params: { search: q } }),
        ]);
        if (cancelled) return;
        const next: PaletteItem[] = [];
        if (custRes.status === 'fulfilled') {
          for (const c of custRes.value.items) {
            next.push({
              id: `c-${c.id}`,
              group: '客户',
              label: c.company ? `${c.name} · ${c.company}` : c.name,
              sub: [c.country, c.email].filter(Boolean).join(' · '),
              to: customerDetailPath(c.id),
              icon: <Users className="h-4 w-4 text-primary" />,
            });
          }
        }
        if (quoteRes.status === 'fulfilled') {
          for (const qt of quoteRes.value.items) {
            next.push({
              id: `q-${qt.id}`,
              group: '报价单',
              label: `${qt.quotationNo} · ${qt.title}`,
              sub: `${qt.currency} ${qt.totalAmount}`,
              to: `${ROUTES.quotations}?id=${qt.id}`,
              icon: <ReceiptText className="h-4 w-4 text-amber-600" />,
            });
          }
        }
        if (polRes.status === 'fulfilled') {
          for (const p of polRes.value.slice(0, 4)) {
            next.push({
              id: `p-${p.id}`,
              group: '对外口径',
              label: `[${p.code}] ${p.topic}`,
              sub: p.valueZh.slice(0, 60),
              to: '/knowledge?view=policies',
              icon: <ShieldCheck className="h-4 w-4 text-emerald-600" />,
            });
          }
        }
        setRemoteItems(next);
        setActiveIndex(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const navMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return STATIC_NAV;
    return STATIC_NAV.filter((item) => item.label.toLowerCase().includes(q));
  }, [query]);

  const items = React.useMemo(() => [...remoteItems, ...navMatches], [remoteItems, navMatches]);

  const selectItem = (item: PaletteItem) => {
    setOpen(false);
    navigate(item.to);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">全局命令搜索</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && items[activeIndex]) {
                e.preventDefault();
                selectItem(items[activeIndex]);
              }
            }}
            placeholder={t('workbench.commandPlaceholder')}
            className="h-8 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-2">
          {loading ? <p className="px-3 py-2 text-xs text-muted-foreground">搜索中…</p> : null}
          {!loading && items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">未找到匹配结果</p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((item, idx) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => selectItem(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      idx === activeIndex ? 'bg-muted text-foreground' : 'text-foreground/85 hover:bg-muted/60'
                    }`}
                  >
                    <span className="shrink-0 text-muted-foreground">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.sub ? <span className="block truncate text-xs text-muted-foreground">{item.sub}</span> : null}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px] font-normal">{item.group}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
