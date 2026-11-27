/**
 * Badge — refined botanical semantic pills.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-tight transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40 focus:ring-offset-1',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground',
        secondary: 'chip-muted border-transparent',
        outline: 'border-border bg-card text-muted-foreground',
        muted: 'chip-muted border-transparent',
        destructive: 'chip-rose border-transparent',
        pending: 'chip-violet border-transparent',
        developed: 'chip-mint border-transparent',
        failed: 'chip-rose border-transparent',
        warning: 'chip-amber border-transparent',
        gold: 'chip-gold border-transparent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
