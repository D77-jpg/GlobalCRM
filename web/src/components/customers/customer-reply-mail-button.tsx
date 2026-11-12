import * as React from 'react';
import { Mail, MailOpen } from 'lucide-react';
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
}

interface ReplyMailResponse {
  items: ReplyMail[];
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
}

/**
 * 客户详情页的快捷入口：客户已回复时，不必先去邮件中心筛选，
 * 直接在这里打开最近几封客户来信。
 */
export function CustomerReplyMailButton({ customerId, status, mailId, label }: CustomerReplyMailButtonProps): React.JSX.Element | null {
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
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" aria-hidden />
              客户回复邮件
            </DialogTitle>
            <DialogDescription>
              展示与该客户关联的最近来信；打开后可直接阅读正文。
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
              visibleItems.map((mail) => (
                <article key={mail.id} className="space-y-3 rounded-xl border border-border/70 bg-surface/40 p-3 sm:p-4">
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold">{mail.subject || '（无主题）'}</p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {mail.fromName && mail.fromName !== mail.from
                          ? `${mail.fromName} <${mail.from}>`
                          : mail.from} · {formatDateTime(mail.sentAt)}
                      </p>
                    </div>
                    <span className="chip chip-mint">客户来信</span>
                  </header>
                  <div className="rounded-md border border-border bg-white px-4 py-3">
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">客户回复正文</p>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                      {customerReplyText(mail.text) || '（客户未填写正文，仅引用了原邮件）'}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground">已省略下方引用的原邮件</p>
                  </div>
                </article>
              ))
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
