/**
 * 分页控件：总数说明 + 每页条数 + 页码切换
 * ------------------------------------------------------------------
 * 页码按钮采用「首/尾 + 当前页附近窗口 + 省略号」的策略，
 * 大数据量下也不会渲染出上百个按钮。
 */
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PAGE_SIZE_OPTIONS } from '@/constants';
import { cn } from '@/lib/utils';

const ELLIPSIS = 'ellipsis' as const;

/** 生成页码序列，例如 [1, 'ellipsis', 4, 5, 6, 'ellipsis', 20] */
export function buildPageItems(page: number, totalPages: number): (number | typeof ELLIPSIS)[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const items: (number | typeof ELLIPSIS)[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (start > 2) items.push(ELLIPSIS);
  for (let current = start; current <= end; current += 1) items.push(current);
  if (end < totalPages - 1) items.push(ELLIPSIS);

  items.push(totalPages);
  return items;
}

export interface DataPaginationProps {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  disabled?: boolean;
  /** 窄栏紧凑模式（适用于侧栏或三栏工作台中间列表，避免按钮溢出与文字折行） */
  compact?: boolean;
  className?: string;
  /** 左侧额外信息，例如「已选 3 项」 */
  extra?: React.ReactNode;
}

export function DataPagination({
  page,
  limit,
  total,
  totalPages,
  onPageChange,
  onLimitChange,
  disabled = false,
  compact = false,
  className,
  extra,
}: DataPaginationProps): React.JSX.Element | null {
  const [jumpValue, setJumpValue] = React.useState(String(page));

  React.useEffect(() => {
    setJumpValue(String(page));
  }, [page]);

  if (total <= 0) return null;

  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const pages = buildPageItems(page, totalPages);

  const commitJump = () => {
    const parsed = Number.parseInt(jumpValue.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setJumpValue(String(page));
      return;
    }
    const clamped = Math.max(1, Math.min(totalPages, parsed));
    setJumpValue(String(clamped));
    if (clamped !== page) onPageChange(clamped);
  };

  if (compact) {
    return (
      <div className={cn('space-y-2 border-t border-border/80 px-3 py-2.5', className)}>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="whitespace-nowrap tabular-nums">
            <strong className="font-semibold text-foreground">{from}–{to}</strong> / {total.toLocaleString('zh-CN')} 条
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span>每页</span>
            <Select value={String(limit)} onValueChange={(value) => onLimitChange(Number(value))} disabled={disabled}>
              <SelectTrigger className="h-6 w-[3.75rem] px-2 text-[11px]" aria-label="每页条数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)} className="text-xs">
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <nav className="flex items-center justify-between gap-1.5" aria-label="分页导航">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="上一页"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              commitJump();
            }}
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
          >
            <input
              type="text"
              inputMode="numeric"
              aria-label="跳转页码"
              value={jumpValue}
              disabled={disabled}
              onChange={(event) => setJumpValue(event.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitJump}
              className="h-7 w-11 rounded-md border border-border bg-card px-1.5 text-center font-mono text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/15"
            />
            <span className="whitespace-nowrap font-mono tabular-nums">/ {totalPages} 页</span>
          </form>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="下一页"
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </nav>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-t px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4',
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="whitespace-nowrap">
          共 <span className="font-medium text-foreground tabular-nums">{total.toLocaleString('zh-CN')}</span> 条，当前显示{' '}
          <span className="tabular-nums">
            {from}-{to}
          </span>
        </span>
        {extra}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden whitespace-nowrap sm:inline">每页</span>
          <Select value={String(limit)} onValueChange={(value) => onLimitChange(Number(value))} disabled={disabled}>
            <SelectTrigger className="h-8 w-[4.5rem] px-2 text-xs" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)} className="text-xs">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="hidden whitespace-nowrap sm:inline">条</span>
        </div>

        <nav className="flex items-center gap-1" aria-label="分页导航">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {pages.map((item, index) =>
            item === ELLIPSIS ? (
              <span key={`${item}-${index}`} className="px-1 text-xs text-muted-foreground" aria-hidden>
                …
              </span>
            ) : (
              <Button
                key={item}
                type="button"
                variant={item === page ? 'default' : 'outline'}
                size="sm"
                disabled={disabled}
                aria-current={item === page ? 'page' : undefined}
                className="h-8 min-w-8 px-2 text-xs tabular-nums"
                onClick={() => onPageChange(item)}
              >
                {item}
              </Button>
            ),
          )}

          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={disabled || page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </nav>
      </div>
    </div>
  );
}
