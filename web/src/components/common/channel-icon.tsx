import * as React from 'react';
import { cn } from '@/lib/utils';
import type { OmnichannelType } from '@/types';

export interface ChannelBrandIconProps {
  channel: 'all' | OmnichannelType;
  className?: string;
}

/**
 * Recognizable omnichannel platform brand icons (WhatsApp, Alibaba, Instagram,
 * WeChat, TradeManager / Wangwang, Web Chat, and All-Channels grid).
 */
export function ChannelBrandIcon({ channel, className }: ChannelBrandIconProps): React.JSX.Element {
  switch (channel) {
    case 'whatsapp':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <circle cx="10" cy="10" r="9" fill="#25D366" />
          <path
            d="M10.05 5.1a4.85 4.85 0 0 0-4.18 7.3l-.55 2.02 2.08-.54a4.85 4.85 0 1 0 2.65-8.78Zm2.83 6.84c-.12.34-.7.65-.97.69-.26.04-.58.06-.94-.06-.22-.07-.5-.17-.86-.32-1.51-.65-2.5-2.18-2.57-2.28-.08-.1-.62-.82-.62-1.56 0-.74.39-1.1.53-1.25.14-.15.3-.19.4-.19h.29c.09 0 .22-.03.34.26.12.3.42 1.03.46 1.1.04.08.06.17.01.27-.05.1-.08.17-.15.26-.08.09-.16.2-.23.27-.08.08-.16.16-.07.31.09.15.4.66.86 1.07.59.53 1.09.69 1.24.77.15.08.24.06.33-.04.09-.1.38-.44.48-.59.1-.15.2-.13.34-.08.14.05.89.42 1.04.5.15.08.25.11.29.18.04.06.04.37-.08.7Z"
            fill="#FFFFFF"
          />
        </svg>
      );
    case 'alibaba':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <rect x="1" y="1" width="18" height="18" rx="5" fill="#FF6A00" />
          <path
            d="M13.6 13.3c-.55 0-.96-.24-1.15-.68-.52.46-1.2.68-2.02.68-1.52 0-2.53-.86-2.53-2.14 0-1.36 1.14-2.14 3.04-2.14h1.36v-.33c0-.72-.48-1.12-1.38-1.12-.72 0-1.26.25-1.58.7l-1.15-.74c.54-.78 1.5-1.24 2.82-1.24 1.88 0 2.94.92 2.94 2.58v2.72c0 .32.14.46.42.46h.23v1.25h-1Zm-1.3-2.16v-.47h-1.2c-1.02 0-1.58.35-1.58.98 0 .56.48.92 1.28.92.86 0 1.5-.56 1.5-1.43Z"
            fill="#FFFFFF"
          />
        </svg>
      );
    case 'instagram':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <rect x="1" y="1" width="18" height="18" rx="5.2" fill="#E1306C" />
          <rect x="4.6" y="4.6" width="10.8" height="10.8" rx="3.2" stroke="#FFFFFF" strokeWidth="1.5" />
          <circle cx="10" cy="10" r="2.5" stroke="#FFFFFF" strokeWidth="1.5" />
          <circle cx="13.4" cy="6.6" r="0.85" fill="#FFFFFF" />
        </svg>
      );
    case 'wechat':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <circle cx="10" cy="10" r="9" fill="#07C160" />
          <path
            d="M7.9 5.5c-2.48 0-4.5 1.68-4.5 3.75 0 1.15.63 2.18 1.62 2.87l-.4 1.38 1.53-.76c.54.16 1.13.26 1.75.26.18 0 .35-.01.52-.03A3.56 3.56 0 0 1 8.2 11.8c0-2.16 2.1-3.9 4.7-3.9.16 0 .32.01.47.02C12.95 6.53 10.66 5.5 7.9 5.5Zm-1.5 2.9a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2Zm3 0a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2Z"
            fill="#FFFFFF"
          />
          <path
            d="M12.9 8.6c-2.15 0-3.9 1.44-3.9 3.22 0 1.78 1.75 3.22 3.9 3.22.5 0 .99-.08 1.44-.22l1.26.64-.34-1.15c.95-.59 1.54-1.49 1.54-2.49 0-1.78-1.75-3.22-3.9-3.22Zm-1.25 2.5a.52.52 0 1 1 0-1.04.52.52 0 0 1 0 1.04Zm2.5 0a.52.52 0 1 1 0-1.04.52.52 0 0 1 0 1.04Z"
            fill="#FFFFFF"
          />
        </svg>
      );
    case 'trademanager':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <circle cx="10" cy="10" r="9" fill="#0091FF" />
          <path
            d="M10 5.1c-3.04 0-5.5 2.02-5.5 4.52 0 1.38.76 2.62 1.96 3.45l-.44 1.63 1.78-.86c.69.2 1.43.3 2.2.3 3.04 0 5.5-2.02 5.5-4.52S13.04 5.1 10 5.1Z"
            fill="#FFFFFF"
          />
          <circle cx="8.15" cy="9.35" r="0.85" fill="#0091FF" />
          <circle cx="11.85" cy="9.35" r="0.85" fill="#0091FF" />
          <path d="M8.1 11.25c.48.55 1.15.85 1.9.85s1.42-.3 1.9-.85" stroke="#0091FF" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
    case 'web_chat':
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <circle cx="10" cy="10" r="9" fill="#7C3AED" />
          <circle cx="10" cy="10" r="5" stroke="#FFFFFF" strokeWidth="1.35" />
          <path d="M5.2 10h9.6M10 5c1.35 1.4 2.1 3.15 2.1 5s-.75 3.6-2.1 5c-1.35-1.4-2.1-3.15-2.1-5S8.65 6.4 10 5Z" stroke="#FFFFFF" strokeWidth="1.2" />
        </svg>
      );
    case 'all':
    default:
      return (
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn('h-3.5 w-3.5 shrink-0', className)}>
          <rect x="2.5" y="2.5" width="6.2" height="6.2" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
          <rect x="11.3" y="2.5" width="6.2" height="6.2" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
          <rect x="2.5" y="11.3" width="6.2" height="6.2" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="14.4" cy="14.4" r="3.1" fill="currentColor" />
        </svg>
      );
  }
}
