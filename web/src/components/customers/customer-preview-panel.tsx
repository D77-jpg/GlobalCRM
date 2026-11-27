/**
 * 客户列表右侧速览卡 — Atelier Trade 精致侧栏速览
 */
import type * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Globe2,
  Mail,
  MapPin,
  MessageSquareText,
  Pencil,
  Phone,
  Send,
  Tag,
  UserRound,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CustomerStatusBadge } from '@/components/common/status-badge';
import { CountryFlag } from '@/components/common/country-flag';
import {
  CUSTOMER_PRIORITY_BADGE_CLASS,
  CUSTOMER_PRIORITY_LABEL,
  CUSTOMER_SOURCE_LABEL,
  customerDetailPath,
} from '@/constants';
import { formatDate, formatRelative, getFollowUpState, initials } from '@/lib/format';
import { countryInfo } from '@/lib/country';
import { isCompanyOnlyCustomer } from '@/lib/customer-display';
import { cn } from '@/lib/utils';
import type { Customer } from '@/types';

interface CustomerPreviewPanelProps {
  customer: Customer;
  onEdit: (customer: Customer) => void;
  onSend: (customer: Customer) => void;
  onClose: () => void;
  className?: string;
}

function websiteHref(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function InfoLine({
  icon: Icon,
  label,
  children,
  href,
}: {
  icon: typeof Mail;
  label: string;
  children: React.ReactNode;
  href?: string;
}): React.JSX.Element {
  const content = href ? (
    <a
      href={href}
      className="break-all font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
      {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {children}
    </a>
  ) : (
    <span className="break-all text-muted-foreground">{children}</span>
  );
  return (
    <div className="flex items-start gap-2.5 text-xs leading-5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden />
      <div className="min-w-0 min-h-5">
        <span className="sr-only">{label}：</span>
        {content}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="border-t border-border/75 pt-3.5 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function CustomerPreviewPanel({
  customer,
  onEdit,
  onSend,
  onClose,
  className,
}: CustomerPreviewPanelProps): React.JSX.Element {
  const country = countryInfo(customer.country);
  const company = customer.company || (isCompanyOnlyCustomer(customer) ? '未填写联系人' : '未填写公司');
  const followState = getFollowUpState(customer.nextFollowUpAt);
  const source = customer.leadSource || CUSTOMER_SOURCE_LABEL[customer.source] || customer.source;

  return (
    <aside
      aria-label={`客户速览：${customer.name}`}
      className={cn(
        'panel hidden h-full min-h-0 flex-col overflow-hidden min-[1360px]:flex',
        className,
      )}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border bg-surface/65 px-4 py-3.5">
        <span className="avatar-bubble flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold ring-1 ring-primary/15" aria-hidden>
          {initials(customer.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">客户速览</p>
          <h2 className="mt-0.5 truncate text-[15px] font-semibold leading-5 text-foreground">{customer.name}</h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {customer.country ? <CountryFlag value={customer.country} /> : null}
            <span className="truncate">{company}{country ? ` · ${country.name}` : ''}</span>
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-xs" asChild>
          <Link to={customerDetailPath(customer.id)} aria-label="打开完整客户资料">
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="关闭客户速览">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/80 px-4 py-2.5">
        <CustomerStatusBadge status={customer.status} />
        {customer.priority ? (
          <Badge variant="outline" className={cn('font-medium', CUSTOMER_PRIORITY_BADGE_CLASS[customer.priority])}>
            优先级 {CUSTOMER_PRIORITY_LABEL[customer.priority]}
          </Badge>
        ) : null}
        {customer.grade ? <Badge variant="gold">{customer.grade} 级客户</Badge> : null}
      </div>

      <div className="flex shrink-0 gap-2 border-b border-border/80 px-4 py-3">
        <Button type="button" size="sm" className="flex-1" onClick={() => onSend(customer)}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          发送开发信
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onEdit(customer)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          编辑
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Section title="联系方式">
          <div className="space-y-2.5">
            <InfoLine icon={Mail} label="邮箱" href={customer.email ? `mailto:${customer.email}` : undefined}>
              {customer.email || '未填写邮箱'}
            </InfoLine>
            <InfoLine icon={Phone} label="电话" href={customer.phone ? `tel:${customer.phone}` : undefined}>
              {customer.phone || '未填写电话'}
            </InfoLine>
            <InfoLine icon={Globe2} label="网站" href={customer.website ? websiteHref(customer.website) : undefined}>
              {customer.website || '未填写网站'}
            </InfoLine>
            <InfoLine icon={MapPin} label="地址">
              {customer.address || customer.country || '未填写地址'}
            </InfoLine>
          </div>
        </Section>

        <Section title="业务信息">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
            <div>
              <dt className="text-muted-foreground">负责人</dt>
              <dd className="mt-0.5 flex items-center gap-1 font-medium"><UserRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{customer.owner?.name || '未分配'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">来源</dt>
              <dd className="mt-0.5 truncate font-medium" title={source}>{source}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">最近联系</dt>
              <dd className="mt-0.5 font-medium">{customer.lastContactAt ? formatRelative(customer.lastContactAt) : customer.status === 'pending' ? '未联系' : '未记录'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">开发信</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{customer.letterCount} 封</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">下次跟进</dt>
              <dd className={cn('mt-0.5 inline-flex items-center gap-1 font-medium', followState === 'overdue' && 'text-rose', followState === 'today' && 'text-amberx')}>
                <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                {customer.nextFollowUpAt ? formatDate(customer.nextFollowUpAt) : '未设置'}
                {followState === 'overdue' ? ' · 已逾期' : followState === 'today' ? ' · 今天' : ''}
              </dd>
            </div>
          </dl>
        </Section>

        <Section title="标签">
          {customer.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {customer.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 font-normal">
                  <Tag className="h-3 w-3 text-primary/70" aria-hidden />
                  {tag}
                </Badge>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground">暂无标签</p>}
        </Section>

        <Section title="备注">
          <p className="flex items-start gap-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
            <span className="line-clamp-5">{customer.notes || '暂无备注'}</span>
          </p>
        </Section>
      </div>

      <Link
        to={customerDetailPath(customer.id)}
        className="flex shrink-0 items-center justify-between border-t border-border bg-surface/60 px-4 py-3 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        打开完整客户资料
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </aside>
  );
}
