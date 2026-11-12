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

/** Keep the same restrictive iframe policy as the mail center. */
function mailSrcdoc(html: string): string {
  const csp = "default-src 'none'; img-src http: https: data: cid:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  const style = 'body{margin:0;padding:16px;font:14px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere;color:#202124;background:#fff}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#6d4aff}';
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${style}</style>${html}`;
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
                        {mail.fromName || mail.from} · {formatDateTime(mail.sentAt)}
                      </p>
                    </div>
                    <span className="chip chip-mint">客户来信</span>
                  </header>
                  {mail.html ? (
                    <iframe
                      title={`客户回复：${mail.subject || '（无主题）'}`}
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                      referrerPolicy="no-referrer"
                      className="min-h-56 w-full rounded-md border border-border bg-white"
                      srcDoc={mailSrcdoc(mail.html)}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {mail.text || '（无正文）'}
                    </p>
                  )}
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
