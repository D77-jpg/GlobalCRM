/**
 * 状态徽章：客户 8 段销售状态各用一种低饱和语义色区分（见 CUSTOMER_STATUS_BADGE_CLASS）；开发信状态同理
 */
import type * as React from 'react';
import {
  CUSTOMER_STATUS_BADGE_CLASS,
  CUSTOMER_STATUS_LABEL,
  LETTER_STATUS_BADGE_CLASS,
  LETTER_STATUS_LABEL,
  QUOTATION_STATUS_BADGE_CLASS,
  QUOTATION_STATUS_LABEL,
} from '@/constants';
import type { CustomerStatus, LetterStatus, QuotationStatus } from '@/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function CustomerStatusBadge({
  status,
  className,
  showDot = true,
}: {
  status: CustomerStatus;
  className?: string;
  showDot?: boolean;
}): React.JSX.Element {
  const label = CUSTOMER_STATUS_LABEL[status] ?? status;
  return (
    <Badge variant="outline" className={cn(CUSTOMER_STATUS_BADGE_CLASS[status], 'gap-1.5', className)}>
      {showDot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {label}
    </Badge>
  );
}

export function LetterStatusBadge({
  status,
  needsReview = false,
  className,
  showDot = true,
}: {
  status: LetterStatus;
  needsReview?: boolean;
  className?: string;
  showDot?: boolean;
}): React.JSX.Element {
  const isUncertain = status === 'failed' && Boolean(needsReview);
  const badgeClass = isUncertain
    ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'
    : (LETTER_STATUS_BADGE_CLASS[status] ?? LETTER_STATUS_BADGE_CLASS.draft);
  return (
    <Badge
      variant="outline"
      title={isUncertain ? '请确认这封邮件是否已发出 · 确认前不会重发' : undefined}
      className={cn('gap-1.5', badgeClass, className)}
    >
      {showDot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {isUncertain ? '投递结果未知' : (LETTER_STATUS_LABEL[status] ?? status)}
    </Badge>
  );
}

/** 报价单状态彽章（草稿 / 已发送 / 谈判中 / 已接受 / 已拒绝 / 已过期） */
export function QuotationStatusBadge({
  status,
  className,
  showDot = false,
}: {
  status: QuotationStatus;
  className?: string;
  showDot?: boolean;
}): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn(QUOTATION_STATUS_BADGE_CLASS[status] ?? QUOTATION_STATUS_BADGE_CLASS.draft, 'gap-1.5', className)}
    >
      {showDot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {QUOTATION_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
