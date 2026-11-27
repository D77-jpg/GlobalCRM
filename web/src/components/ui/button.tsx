/**
 * Button — tactile, quiet-first controls with deep forest-emerald primary CTAs.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[0.8125rem] font-medium',
    'transition-[background-color,color,border-color,box-shadow,transform] duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1',
    'focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'btn-gradient active:translate-y-px',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:translate-y-px',
        outline:
          'border border-border bg-card text-foreground shadow-[0_1px_1px_hsl(150_20%_12%_/_0.03)] hover:border-foreground/20 hover:bg-surface active:translate-y-px',
        secondary: 'bg-primary-soft text-primary hover:bg-primary-soft/80',
        ghost: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        success: 'bg-status-developed text-white shadow-sm hover:bg-status-developed/90',
      },
      size: {
        default: 'h-9 px-3.5 py-1.5',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-10 px-4.5 text-sm',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
        'icon-xs': 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        data-ui="button"
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && !asChild ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button };
