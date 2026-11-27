/**
 * Card & StatCard — elevated warm-bordered white surfaces for executive clarity.
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
      className={cn('text-[0.9375rem] font-semibold leading-snug tracking-[-0.015em]', className)}
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
 * 统计卡片：柔和森林绿圆形图标底 + 清晰的数值与辅助趋势/说明。
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
    default: 'bg-primary-soft text-primary',
    primary: 'bg-primary-soft text-primary',
    pending: 'bg-amberx-soft text-amberx',
    developed: 'bg-mint-soft text-mint',
    failed: 'bg-rose-soft text-rose',
    gold: 'bg-gold-soft text-gold',
  }[tone];

  const badgeToneClass = {
    default: 'chip-muted',
    primary: 'chip-violet',
    pending: 'chip-amber',
    developed: 'chip-mint',
    failed: 'chip-rose',
    gold: 'chip-gold',
  }[tone];

  return (
    <Card className={cn('p-4 transition-[border-color,box-shadow] duration-150 hover:border-foreground/15', className)}>
      <div className="flex items-start gap-3">
        {icon ? (
          <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', iconToneClass)} aria-hidden>
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
              <p className="break-all text-[1.5rem] font-bold leading-none tracking-[-0.03em] tabular-nums text-foreground">
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
