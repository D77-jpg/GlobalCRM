import * as React from 'react';
import { Clock, Hash, Mail, MailOpen, User } from 'lucide-react';
import { apiGet, toErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ReplyMail {
  id: string;
  subject: string;
  from: string;
  fromName?: string;
  to: string[];
  sentAt: string | Date;
  text: string;
  html: string;
  threadId?: string;
  messageId?: string;
}

interface ReplyMailResponse {
  items: ReplyMail[];
}

/** A compact meta row, matching the existing sent-letter detail dialog. */
function MetaRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-medium">{children}</dd>
    </div>
  );
}

/**
 * Inbound mail commonly contains the entire outgoing thread below the
 * customer's actual sentence. Show only the fresh part; the quoted history is
 * already available in the mail center if someone really needs it.
 */
function customerReplyText(text: string): string {
  const quotedMarker = text.search(/\n\s*(?:On|在).+?(?:wrote|写道)\s*[:：]\s*\n/i);
  const fresh = quotedMarker >= 0 ? text.slice(0, quotedMarker) : text;
  return fresh.replace(/\n{3,}/g, '\n\n').trim();
}

export interface CustomerReplyMailButtonProps {
  customerId: string;
  status: string;
  /** Open a specific reply from the timeline, instead of the latest reply list. */
  mailId?: string;
  label?: string;
  /** The outbound stage this reply belongs to, e.g. 第1封开发信. */
  sourceLabel?: string;
}

/**
 * 客户详情页的快捷入口：客户已回复时，不离开时间线即可打开对应来信。
 */
export function CustomerReplyMailButton({
  customerId,
  status,
  mailId,
  label,
  sourceLabel,
}: CustomerReplyMailButtonProps): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [items, setItems] = React.useState<ReplyMail[]>([]);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const data = await apiGet<ReplyMailResponse>(`/customers/${customerId}/reply-mails?limit=20`);
      if (request === requestRef.current) setItems(data.items ?? []);
    } catch (caught) {
      if (request === requestRef.current) {
        setItems([]);
        setError(toErrorMessage(caught, '无法读取回复邮件'));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [customerId]);

  if (status !== 'replied') return null;

  const visibleItems = mailId ? items.filter((mail) => mail.id === mailId) : items;
  const firstMail = visibleItems[0];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <MailOpen className="h-3.5 w-3.5" aria-hidden />
        {label || '查看回复邮件'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-start gap-2 pr-6">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 break-words">{firstMail?.subject || '客户回复邮件'}</span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <span className="chip chip-mint">客户回复</span>
              {sourceLabel ? <span>对应{sourceLabel}</span> : null}
              {firstMail ? <span>· 收到于 {formatDateTime(firstMail.sentAt)}</span> : null}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">正在读取回复邮件…</p>
            ) : error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
                <Button type="button" variant="link" size="sm" className="ml-2 h-auto p-0" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            ) : visibleItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {mailId ? '没有找到这条时间线关联的回复邮件。' : '暂时没有找到该客户的回复邮件。'}
              </p>
            ) : (
              visibleItems.map((mail) => {
                const replyText = customerReplyText(mail.text) || '（客户未填写正文，仅引用了原邮件）';
                return (
                  <div key={mail.id} className="space-y-4">
                    <dl className="grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">
                      <MetaRow icon={<User className="h-3.5 w-3.5" aria-hidden />} label="发件人：">
                        {mail.fromName || '—'}
                      </MetaRow>
                      <MetaRow icon={<Mail className="h-3.5 w-3.5" aria-hidden />} label="邮箱：">
                        <a href={`mailto:${mail.from}`} className="text-primary underline-offset-2 hover:underline">
                          {mail.from || '—'}
                        </a>
                      </MetaRow>
                      <MetaRow icon={<Clock className="h-3.5 w-3.5" aria-hidden />} label="收到时间：">
                        {formatDateTime(mail.sentAt)}
                      </MetaRow>
                      <MetaRow icon={<Hash className="h-3.5 w-3.5" aria-hidden />} label="Message-ID：">
                        <span className="break-all font-mono text-2xs">{mail.messageId || '—'}</span>
                      </MetaRow>
                    </dl>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground">客户回复正文</p>
                        <span className="chip chip-muted">已省略引用原邮件</span>
                      </div>
                      <div className="mail-preview rounded-md border bg-background p-4">
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                          {replyText}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
