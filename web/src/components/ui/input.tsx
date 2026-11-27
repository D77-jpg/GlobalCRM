/**
 * Input — crisp 36px field with warm stone border and forest-emerald focus ring.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, invalid, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    data-ui="field"
    aria-invalid={invalid || undefined}
    className={cn(
      [
        'flex h-9 w-full rounded-lg border border-input/90 bg-card px-3 py-1.5 text-[0.8125rem] shadow-none',
        'transition-[border-color,box-shadow,background-color] file:border-0 file:bg-card file:text-sm file:font-medium file:text-foreground',
        'placeholder:text-muted-foreground/75',
        'hover:border-foreground/25',
        'focus-visible:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:ring-offset-0',
        'disabled:cursor-not-allowed disabled:opacity-55',
        'read-only:bg-surface',
      ].join(' '),
      invalid && 'border-destructive/65 focus-visible:border-destructive focus-visible:ring-destructive/15',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export { Input };
