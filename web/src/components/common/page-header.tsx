/**
 * PageHeader — Editorial executive header with subtle eyebrow, crisp title,
 * optional status badge, description, and right-aligned actions.
 */
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
  className?: string;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  badge,
  actions,
  backTo,
  backLabel = '返回',
  className,
  children,
}: PageHeaderProps): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <header className={cn('workspace-page-header flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          {backTo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 mb-1.5 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => navigate(backTo)}
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {backLabel}
            </Button>
          ) : eyebrow !== null ? (
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              {eyebrow ?? 'GLOBALCRM / TRADE WORKSPACE'}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="break-words text-[1.45rem] font-semibold leading-tight tracking-[-0.028em] text-foreground sm:text-[1.625rem]">
              {title}
            </h1>
            {badge ? <div className="shrink-0">{badge}</div> : null}
          </div>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-[0.8125rem] leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="workspace-page-actions flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
