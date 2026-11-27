/**
 * 空态 / 错误态 / 加载态 —— 柔和森林绿质感占位块
 */
import * as React from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface StateBlockProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  role?: React.AriaRole;
}

function StateBlock({ icon, title, description, action, className, role }: StateBlockProps): React.JSX.Element {
  return (
    <div role={role} className={cn('flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center', className)}>
      {icon ? (
        <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/10 bg-primary-soft/65 text-primary/80">
          {icon}
        </div>
      ) : null}
      <p className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">{title}</p>
      {description ? <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon = <Inbox className="h-7 w-7" strokeWidth={1.6} aria-hidden />,
  title = '暂无数据',
  description,
  action,
  className,
}: Omit<StateBlockProps, 'icon'> & { icon?: React.ReactNode }): React.JSX.Element {
  return (
    <StateBlock
      icon={icon}
      title={title}
      description={description}
      action={action}
      className={className}
    />
  );
}

export function NoResultState({
  title = '没有匹配的结果',
  description = '试试调整搜索关键词或清空筛选条件',
  action,
  className,
}: Omit<StateBlockProps, 'icon'>): React.JSX.Element {
  return (
    <StateBlock
      icon={<SearchX className="h-8 w-8" strokeWidth={1.5} aria-hidden />}
      title={title}
      description={description}
      action={action}
      className={className}
    />
  );
}

export function ErrorState({
  title = '加载失败',
  description,
  onRetry,
  retrying = false,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <StateBlock
      role="alert"
      icon={<AlertTriangle className="h-8 w-8 text-status-failed" strokeWidth={1.5} aria-hidden />}
      title={title}
      description={description}
      className={className}
      action={
        onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} loading={retrying}>
            {!retrying ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : null}
            重新加载
          </Button>
        ) : null
      }
    />
  );
}

export function InlineLoader({ label = '加载中…', className }: { label?: string; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-center gap-2.5 py-12 text-sm text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
      {label}
    </div>
  );
}
