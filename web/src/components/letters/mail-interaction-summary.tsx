import type * as React from 'react';
import { Eye, Link2, Send } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { MailTrackingSummary } from '@/types';

export function MailInteractionSummary({
  sentAt,
  tracking,
  detailed = false,
}: {
  sentAt?: string | Date;
  tracking?: MailTrackingSummary;
  detailed?: boolean;
}): React.JSX.Element {
  if (!detailed) {
    const openDisplay = tracking?.opened
      ? `已打开 ${tracking.dedupedOpenCount ?? tracking.openCount} 次${tracking.humanReadConfidence === 'uncertain' ? '（可能为自动预览）' : ''}`
      : '未记录打开';
    const clickDisplay = tracking?.clicked
      ? `点击 ${tracking.dedupedClickCount ?? tracking.clickCount} 次`
      : '未记录点击';
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="邮件互动情况">
        {tracking ? (
          <>
            <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden />{openDisplay}</span>
            <span className="inline-flex items-center gap-1"><Link2 className="h-3 w-3" aria-hidden />{clickDisplay}</span>
          </>
        ) : <span className="inline-flex items-center gap-1"><Send className="h-3 w-3" aria-hidden />未开启打开/点击统计</span>}
      </div>
    );
  }

  const confidenceLabel = tracking?.humanReadConfidence === 'likely_clicked'
    ? '较高（客户点击过链接）'
    : tracking?.humanReadConfidence === 'uncertain'
      ? '待确认（可能为邮箱自动预览）'
      : '暂无互动';

  const tiles: { label: string; value: string; tone?: string }[] = [
    { label: '打开次数', value: tracking ? `${tracking.dedupedOpenCount ?? tracking.openCount} 次` : '—', tone: tracking?.opened ? 'text-mint' : undefined },
    { label: '链接点击', value: tracking ? `${tracking.dedupedClickCount ?? tracking.clickCount} 次` : '—', tone: tracking?.clicked ? 'text-violet' : undefined },
    { label: '阅读判断', value: tracking ? confidenceLabel : '—' },
    { label: '最近互动', value: tracking?.lastClickedAt ? formatDateTime(tracking.lastClickedAt) : tracking?.lastOpenedAt ? formatDateTime(tracking.lastOpenedAt) : '暂无记录' },
  ];

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-surface/60 p-3.5" aria-label="邮件行为追踪">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"><Eye className="h-3.5 w-3.5 text-primary" aria-hidden />邮件互动</span>
        <span className="text-[11px] text-muted-foreground">发送于 {sentAt ? formatDateTime(sentAt) : '—'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(tile => (
          <div key={tile.label} className="rounded-xl bg-card px-3 py-2 shadow-card">
            <p className="text-[11px] text-muted-foreground">{tile.label}</p>
            <p className={`mt-0.5 truncate text-[0.8125rem] font-semibold tabular-nums ${tile.tone ?? 'text-foreground'}`} title={tile.value}>{tile.value}</p>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">点击过的链接</p>
        {tracking?.clickedLinks.length ? tracking.clickedLinks.map((link) => (
          <a key={`${link.url}-${link.clickedAt}`} href={link.url} target="_blank" rel="noreferrer" className="block break-all text-[11px] text-primary underline underline-offset-2">
            {link.url} <span className="text-muted-foreground">× {link.clickCount}{link.lastClickedAt ? ` · 最近 ${formatDateTime(link.lastClickedAt)}` : ''}</span>
          </a>
        )) : <p className="text-[11px] text-muted-foreground">暂无记录</p>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{tracking?.accuracyNotice || '纯文本邮件或追踪未启用，不会产生打开与点击数据。'}</p>
      {tracking?.coverageNotice ? <p className="text-[11px] leading-relaxed text-muted-foreground">{tracking.coverageNotice}</p> : null}
    </section>
  );
}
