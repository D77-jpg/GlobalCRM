import * as React from 'react';
import { useDashboardNavigation } from './dashboard-navigation';
import { CUSTOMER_STATUS_BAR_CLASS, CUSTOMER_STATUS_LABEL, CUSTOMER_STATUS_VALUES } from '@/constants';
import { cn } from '@/lib/utils';
import type { CustomerStatus } from '@/types';

export function SalesFunnel({ byStatus, total }: { byStatus: Record<CustomerStatus, number>; total: number }): React.JSX.Element {
  const { openCustomers } = useDashboardNavigation();
  const max = Math.max(...CUSTOMER_STATUS_VALUES.map((status) => byStatus[status] ?? 0), 1);
  return (
    <section aria-labelledby="customer-pipeline-title">
      <h3 id="customer-pipeline-title" className="section-title">客户销售阶段</h3>
      <p className="mt-1 text-xs text-muted-foreground">点击阶段，直接筛选对应客户</p>
      {total === 0 ? (
        <p className="py-8 text-xs text-muted-foreground">导入客户后查看阶段分布</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {CUSTOMER_STATUS_VALUES.map((status) => {
            const count = byStatus[status] ?? 0;
            return (
              <li key={status}>
                <button
                  type="button"
                  disabled={count === 0}
                  onClick={() => openCustomers({ status })}
                  className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
                >
                  <span className="w-12 shrink-0 font-medium">{CUSTOMER_STATUS_LABEL[status]}</span>
                  <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className={cn('block h-full rounded-full transition-all', CUSTOMER_STATUS_BAR_CLASS[status])} style={{ width: `${(count / max) * 100}%` }} />
                  </span>
                  <span className="w-8 text-right font-semibold tabular-nums">{count}</span>
                  <span className="w-9 text-right tabular-nums text-muted-foreground">{total ? Math.round((count / total) * 100) : 0}%</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
