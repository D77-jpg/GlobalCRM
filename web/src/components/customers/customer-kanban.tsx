import * as React from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarClock, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountryFlag } from '@/components/common/country-flag';
import {
  CUSTOMER_STATUS_BADGE_CLASS,
  CUSTOMER_STATUS_LABEL,
  customerDetailPath,
} from '@/constants';
import { formatDate, getFollowUpState } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Customer, CustomerStatus } from '@/types';

const KANBAN_COLUMNS: CustomerStatus[] = [
  'pending',
  'contacted',
  'replied',
  'interested',
  'quoting',
  'negotiating',
  'won',
];

export interface CustomerKanbanProps {
  customers: Customer[];
  loading: boolean;
  onStatusChange: (customer: Customer, nextStatus: CustomerStatus) => Promise<void>;
  onCreate: () => void;
}

export function CustomerKanban({
  customers,
  loading,
  onStatusChange,
  onCreate,
}: CustomerKanbanProps): React.JSX.Element {
  const [quickFilter, setQuickFilter] = React.useState<'all' | 'high' | 'overdue'>('all');
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = React.useState<CustomerStatus | null>(null);

  const visible = React.useMemo(() => {
    return customers.filter((c) => {
      if (quickFilter === 'high') {
        return c.priority === 'high' || (typeof c.intentScore === 'number' && c.intentScore >= 70) || ['interested', 'quoting', 'negotiating'].includes(c.status);
      }
      if (quickFilter === 'overdue') {
        return getFollowUpState(c.nextFollowUpAt) === 'overdue';
      }
      return true;
    });
  }, [customers, quickFilter]);

  const byStage = React.useMemo(() => {
    const map = new Map<CustomerStatus, Customer[]>();
    for (const col of KANBAN_COLUMNS) map.set(col, []);
    for (const c of visible) {
      const bucket = map.get(c.status);
      if (bucket) bucket.push(c);
    }
    return map;
  }, [visible]);

  const handleDrop = async (targetStage: CustomerStatus) => {
    setDragOverStage(null);
    if (!draggingId) return;
    const target = customers.find((c) => c.id === draggingId);
    setDraggingId(null);
    if (!target || target.status === targetStage) return;
    await onStatusChange(target, targetStage);
  };

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">快捷筛选：</span>
          {([
            ['all', `全部 (${customers.length})`],
            ['high', '高意向 / 重点'],
            ['overdue', '跟进超期'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickFilter(key)}
              className={cn(
                'rounded-full border px-2.5 py-1 transition-colors',
                quickFilter === key ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">拖拽客户卡片即可推进销售阶段并自动记录时间线</span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {KANBAN_COLUMNS.map((stage) => {
          const cards = byStage.get(stage) ?? [];
          const isOver = dragOverStage === stage;
          return (
            <section
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStage(stage);
              }}
              onDragLeave={() => setDragOverStage(null)}
              onDrop={(e) => {
                e.preventDefault();
                void handleDrop(stage);
              }}
              className={cn(
                'flex w-64 shrink-0 flex-col rounded-lg border bg-muted/25 transition-colors',
                isOver ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <header className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', CUSTOMER_STATUS_BADGE_CLASS[stage])}>
                  {CUSTOMER_STATUS_LABEL[stage]}
                </span>
                <span className="text-xs font-medium tabular-nums text-muted-foreground">{cards.length}</span>
              </header>

              <div className="flex min-h-[18rem] flex-1 flex-col gap-2 p-2">
                {cards.map((c) => {
                  const overdue = getFollowUpState(c.nextFollowUpAt) === 'overdue';
                  return (
                    <article
                      key={c.id}
                      draggable
                      onDragStart={() => setDraggingId(c.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverStage(null);
                      }}
                      className={cn(
                        'cursor-grab rounded-md border border-border bg-card p-2.5 text-xs shadow-sm transition-all hover:border-primary/60 active:cursor-grabbing',
                        draggingId === c.id && 'opacity-50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <Link to={customerDetailPath(c.id)} className="min-w-0 flex-1 font-semibold hover:text-primary hover:underline">
                          <span className="flex items-center gap-1.5">
                            <CountryFlag value={c.country} />
                            <span className="truncate">{c.company || c.name}</span>
                          </span>
                        </Link>
                        {typeof c.intentScore === 'number' ? (
                          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] tabular-nums">{c.intentScore}分</Badge>
                        ) : null}
                      </div>
                      {c.company && c.name !== c.company ? (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{c.name}</p>
                      ) : null}
                      {c.interestedProducts ? (
                        <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-foreground/85">{c.interestedProducts}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {c.priority === 'high' ? <Badge variant="destructive" className="px-1.5 py-0 text-[9px]">高优</Badge> : null}
                        {c.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[9px] font-normal">{tag}</Badge>
                        ))}
                      </div>
                      {c.nextFollowUpAt ? (
                        <p className={cn('mt-2 flex items-center gap-1 text-[10px]', overdue ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                          {overdue ? <AlertCircle className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
                          {overdue ? `已逾期 · ${formatDate(c.nextFollowUpAt)}` : `跟进 · ${formatDate(c.nextFollowUpAt)}`}
                        </p>
                      ) : null}
                    </article>
                  );
                })}
                {!loading && cards.length === 0 ? (
                  <p className="py-6 text-center text-[11px] text-muted-foreground">暂无客户</p>
                ) : null}
                <Button variant="ghost" size="sm" className="mt-auto h-7 w-full justify-center text-[11px] text-muted-foreground" onClick={onCreate}>
                  <Plus className="h-3 w-3" />添加客户
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
