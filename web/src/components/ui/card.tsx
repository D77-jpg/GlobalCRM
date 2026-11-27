/**
 * Card & StatCard — Gallery-white architectural cards with crisp 1px borders.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('panel min-w-0 rounded-xl border border-border bg-card text-card-foreground', className)}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex min-w-0 flex-col gap-1 p-4 sm:p-5', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-[0.9375rem] font-semibold leading-snug tracking-[-0.018em]', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-xs leading-relaxed text-muted-foreground', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-4 pt-0 sm:p-5 sm:pt-0', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-wrap items-center gap-2 border-t border-border/80 p-4 sm:p-5', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

/**
 * 统计卡片：利落现代商务方形圆角图标框 + 高对比度墨黑数值 + 克制语义角标。
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  badge,
  rightSlot,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  rightSlot?: React.ReactNode;
  tone?: 'default' | 'pending' | 'developed' | 'failed' | 'primary' | 'gold';
  className?: string;
}): React.JSX.Element {
  const iconToneClass = {
    default: 'border border-border/80 bg-surface text-foreground',
    primary: 'border border-border/80 bg-surface text-foreground',
    pending: 'border border-border/80 bg-surface text-foreground',
    developed: 'border border-mint/20 bg-mint-soft/70 text-mint',
    failed: 'border border-rose/20 bg-rose-soft/70 text-rose',
    gold: 'border border-border/80 bg-surface text-foreground',
  }[tone];

  const badgeToneClass = {
    default: 'chip-muted',
    primary: 'chip-violet',
    pending: 'chip-amber',
    developed: 'chip-mint',
    failed: 'chip-rose',
    gold: 'chip-muted',
  }[tone];

  return (
    <Card className={cn('p-4 transition-[border-color,box-shadow] duration-150 hover:border-foreground/20', className)}>
      <div className="flex items-start gap-3">
        {icon ? (
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', iconToneClass)} aria-hidden>
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</p>
            {badge ? <span className={cn('chip shrink-0', badgeToneClass)}>{badge}</span> : null}
          </div>
          <div className="mt-1.5 flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="break-all text-[1.45rem] font-bold leading-none tracking-[-0.03em] tabular-nums text-foreground">
                {value}
              </p>
              {hint ? <div className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</div> : null}
            </div>
            {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
