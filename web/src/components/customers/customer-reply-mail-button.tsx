import * as React from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileText,
  Hash,
  Image as ImageIcon,
  Loader2,
  Mail,
  MailOpen,
  Paperclip,
  User,
} from 'lucide-react';
import { apiDownload, apiGet, toErrorMessage } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
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

interface ReplyAttachment {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  blocked?: string;
}

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
  attachments?: ReplyAttachment[];
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

function formatBytes(size?: number): string {
  if (typeof size !== 'number' || Number.isNaN(size) || size < 0) return '未知大小';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function isPreviewableImage(att: ReplyAttachment): boolean {
  if (att.blocked) return false;
  if (att.mimeType && /^image\/(?:png|jpe?g|webp|gif)$/i.test(att.mimeType)) return true;
  return /\.(?:png|jpe?g|webp|gif)$/i.test(att.name);
}

function htmlFallbackText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_BOUNDARIES: RegExp[] = [
  /(?:^|\n)\s*[-_]{2,}\s*(?:original|forwarded)\s+message\s*[-_]{2,}/i,
  /(?:^|\n)\s*[-_]{2,}\s*(?:原始邮件|转发邮件)\s*[-_]{2,}/i,
  /(?:^|\n)\s*(?:On|在)\s+[^\n]{6,220}?(?:wrote|写道)\s*[:：]\s*(?:\n|$)/i,
  /(?:^|\n)\s*From\s*:\s*[^\n]+\n\s*(?:Date|Sent|Time)\s*:\s*[^\n]+/i,
  /(?:^|\n)\s*发件人\s*[:：]\s*[^\n]+\n\s*(?:发送时间|日期|时间)\s*[:：]\s*[^\n]+/i,
  /(?:^|\n)\s*_{10,}\s*(?:\n|$)/,
  /(?:^|\n)\s*You are receiving this business email because/i,
];

/**
 * Inbound mail commonly contains the entire outgoing thread below the
 * customer's actual sentence (including Foxmail/Outlook `From: ... Date: ...` blocks).
 * Separate the fresh reply from the quoted original email so users see the
 * real response cleanly while still allowing optional expansion of quoted history.
 */
function splitReplyContent(text: string, html: string, senderEmail: string): { freshText: string; quotedText: string } {
  const source = (text?.trim() ? text : htmlFallbackText(html)).replace(/\r\n?/g, '\n').trim();
  if (!source) return { freshText: '', quotedText: '' };

  let splitAt = -1;
  for (const pattern of QUOTE_BOUNDARIES) {
    const match = pattern.exec(source);
    if (match && match.index !== undefined) {
      if (splitAt < 0 || match.index < splitAt) {
        splitAt = match.index;
      }
    }
  }

  const rawFresh = splitAt >= 0 ? source.slice(0, splitAt) : source;
  const quotedText = splitAt >= 0 ? source.slice(splitAt).trim() : '';
  const cleanedLines = rawFresh
    .split('\n')
    .filter((line) => !/^\s*>/.test(line));
  let freshText = cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Foxmail/webmail clients often insert only the sender's email signature line above `From: ...`
  // when replying with attachments or empty text.
  const senderLower = senderEmail.trim().toLowerCase();
  if (quotedText && freshText && senderLower && freshText.toLowerCase() === senderLower) {
    freshText = '';
  }

  return { freshText, quotedText };
}

function ReplyAttachmentRow({
  customerId,
  mailId,
  att,
}: {
  customerId: string;
  mailId: string;
  att: ReplyAttachment;
}): React.JSX.Element {
  const [downloading, setDownloading] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState('');
  const previewUrlRef = React.useRef<string | null>(null);
  const imageable = isPreviewableImage(att);
  const downloadPath = `/customers/${customerId}/reply-mails/${mailId}/attachments/${att.id}`;

  React.useEffect(() => () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  const toggleImagePreview = async (): Promise<void> => {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    if (previewUrl || previewLoading) return;
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const { blob } = await apiDownload(downloadPath);
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch (caught) {
      setPreviewError(toErrorMessage(caught, '图片预览加载失败'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadFile(downloadPath, att.name);
    } catch (caught) {
      toast.error(toErrorMessage(caught, '附件下载失败'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="rounded-md border bg-muted/20 p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {imageable ? (
            <ImageIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="truncate font-medium text-foreground" title={att.name}>
            {att.name}
          </span>
          <span className="shrink-0 text-muted-foreground">({formatBytes(att.size)})</span>
        </div>

        {att.blocked ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {att.blocked}
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            {imageable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void toggleImagePreview()}
              >
                {previewOpen ? '收起预览' : '预览图片'}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2.5 text-xs"
              disabled={downloading}
              onClick={() => void handleDownload()}
            >
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
              下载
            </Button>
          </div>
        )}
      </div>

      {previewOpen ? (
        <div className="mt-2.5 rounded border bg-background p-2">
          {previewLoading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground justify-center">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              正在加载图片预览…
            </div>
          ) : previewError ? (
            <p className="py-3 text-center text-xs text-destructive">{previewError}</p>
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={att.name}
              className="mx-auto max-h-80 rounded object-contain"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface CustomerReplyMailButtonProps {
  customerId: string;
  status: string;
  /** Open a specific reply from the timeline, instead of the latest reply list. */
  mailId?: string;
  label?: string;
  /** The outbound stage this reply belongs to, e.g. 第1封开发信. */
  sourceLabel?: string;
  /** Known attachment count for badge display before opening modal. */
  attachmentCount?: number;
}

/**
 * 客户详情页的快捷入口：客户已回复时，不离开时间线即可打开对应来信及附件。
 */
export function CustomerReplyMailButton({
  customerId,
  status,
  mailId,
  label,
  sourceLabel,
  attachmentCount,
}: CustomerReplyMailButtonProps): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [items, setItems] = React.useState<ReplyMail[]>([]);
  const [expandedQuotes, setExpandedQuotes] = React.useState<Record<string, boolean>>({});
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

  if (status !== 'replied' && !mailId) return null;

  const visibleItems = mailId ? items.filter((mail) => mail.id === mailId) : items;
  const firstMail = visibleItems[0];
  const resolvedAttachmentCount = firstMail ? (firstMail.attachments?.length ?? 0) : (attachmentCount ?? 0);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-primary"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <MailOpen className="h-3.5 w-3.5" aria-hidden />
        {label || '查看回复邮件'}
        {attachmentCount && attachmentCount > 0 ? (
          <Badge variant="outline" className="ml-0.5 h-4 gap-0.5 px-1 text-[10px]">
            <Paperclip className="h-2.5 w-2.5" aria-hidden />
            {attachmentCount}
          </Badge>
        ) : null}
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
              {resolvedAttachmentCount > 0 ? (
                <Badge variant="secondary" className="gap-1">
                  <Paperclip className="h-3 w-3" aria-hidden />
                  {resolvedAttachmentCount} 个附件
                </Badge>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
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
              visibleItems.map((mail, idx) => {
                const { freshText, quotedText } = splitReplyContent(mail.text, mail.html, mail.from);
                const attachments = mail.attachments ?? [];
                const quoteExpanded = Boolean(expandedQuotes[mail.id]);
                const emptyHint = attachments.length > 0
                  ? '（客户仅发送了附件，未填写文字正文）'
                  : '（客户未填写正文，仅引用了原邮件）';
                return (
                  <div key={mail.id} className={idx > 0 ? 'space-y-4 border-t pt-4' : 'space-y-4'}>
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

                    {attachments.length > 0 ? (
                      <div className="space-y-2">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          客户来信附件（{attachments.length}）
                        </p>
                        <div className="space-y-2">
                          {attachments.map((att) => (
                            <ReplyAttachmentRow
                              key={att.id}
                              customerId={customerId}
                              mailId={mail.id}
                              att={att}
                            />
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground">客户回复正文</p>
                        {quotedText ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                            onClick={() =>
                              setExpandedQuotes((prev) => ({ ...prev, [mail.id]: !prev[mail.id] }))
                            }
                          >
                            {quoteExpanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                            {quoteExpanded ? '收起引用原邮件' : '展开引用原邮件'}
                          </Button>
                        ) : null}
                      </div>
                      <div className="mail-preview rounded-md border bg-background p-4">
                        <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${freshText ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {freshText || emptyHint}
                        </p>
                      </div>
                      {quotedText && quoteExpanded ? (
                        <div className="rounded-md border border-dashed bg-muted/25 p-3">
                          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">引用的原邮件记录</p>
                          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                            {quotedText}
                          </p>
                        </div>
                      ) : null}
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
