import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import env from '../config/env';
import { shouldSkipMailTrackingForUrl } from '../config/edition';
import { DevelopmentLetter } from '../models';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TRACKED_LINKS = 100;
const DEDUPE_WINDOW_MS = 60_000;
const FAST_BURST_AFTER_SEND_MS = 5_000;

export interface PreparedTrackingLink {
  tokenHash: string;
  originalUrl: string;
  clickCount: number;
}

export interface PreparedTracking {
  deliveryHtml: string;
  tracking?: {
    prepared: true;
    enabled: false;
    openTokenHash: string;
    openCount: 0;
    clickCount: 0;
    links: PreparedTrackingLink[];
  };
}

export interface TrackingSummary {
  enabled: boolean;
  opened: boolean;
  openedAt?: Date;
  openCount: number;
  dedupedOpenCount: number;
  automatedOpenCount: number;
  uncertainOpenCount: number;
  lastOpenedAt?: Date;
  clicked: boolean;
  clickedAt?: Date;
  clickCount: number;
  dedupedClickCount: number;
  automatedClickCount: number;
  lastClickedAt?: Date;
  /** 真实人是否看过：打开仅标「无法确定」，非扫描点击才标「可能已互动」 */
  humanReadConfidence: 'none' | 'uncertain' | 'likely_clicked';
  humanReadLabel: string;
  clickedLinks: {
    url: string;
    clickedAt?: Date;
    clickCount: number;
    lastClickedAt?: Date;
  }[];
  coverageNotice: string;
  accuracyNotice: string;
}

export function generateTrackingToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashTrackingToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function trackingUrl(path: string, token: string): string {
  return new URL(`/api/tracking/${path}/${token}`, env.TRACKING_BASE_URL).toString();
}

/** 跳转 URL 不从请求参数接收，且每次跳转前再做一次协议检查。 */
export function isSafeRedirectUrl(value: string): boolean {
  if (!value || value.length > 4000) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function internalHosts(): Set<string> {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);
  for (const value of [env.TRACKING_BASE_URL, ...env.corsOrigins]) {
    try { hosts.add(new URL(value).hostname.toLowerCase()); } catch { /* wildcard / invalid origin is ignored */ }
  }
  return hosts;
}

export function shouldTrackLink(value: string): boolean {
  const decoded = value.replace(/&amp;/gi, '&');
  if (!isSafeRedirectUrl(decoded)) return false;
  const url = new URL(decoded);
  const searchable = `${url.pathname}${url.search}${url.hash}`.toLowerCase();
  if (/(^|[\/_?&=#.-])(unsubscribe|unsub|opt[-_]?out)([\/_?&=#.-]|$)/i.test(searchable)) return false;
  if (internalHosts().has(url.hostname.toLowerCase())) return false;
  return true;
}

/**
 * 对已清洗 HTML 做发送副本。原文 content 不改，因此 CRM 预览不会请求 pixel。
 * 纯文本、无标签内容直接返回，追踪失败也由上层降级为原始 HTML。
 */
export function prepareTrackedHtml(html: string): PreparedTracking {
  // 团队自用模式下若 TRACKING_BASE_URL 指向回环/内网地址，跳过追踪像素与链接改写，防止外发邮件暴露内网 IP
  if (shouldSkipMailTrackingForUrl(env.TRACKING_BASE_URL, env.CRM_EDITION)) {
    return { deliveryHtml: html };
  }
  const contentWithoutCompliance = html.replace(/<div\b[^>]*data-compliance=["']unsubscribe["'][\s\S]*?<\/div>/i, '');
  if (!/<[a-z][\s\S]*>/i.test(contentWithoutCompliance)) return { deliveryHtml: html };

  const links: PreparedTrackingLink[] = [];
  const delivery = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (anchor, attributes: string, innerHtml: string) => {
    if (links.length >= MAX_TRACKED_LINKS) return anchor;
    if (/\bdata-no-track(?:\s*=|\s|$)/i.test(attributes) || /\brel\s*=\s*(["'])[^"']*unsubscribe[^"']*\1/i.test(attributes)) return anchor;
    const visibleText = innerHtml.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
    if (/\b(unsubscribe|opt[- ]?out)\b|\u9000\u8ba2|\u53d6\u6d88\u8ba2\u9605/i.test(visibleText)) return anchor;
    const href = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!href || !shouldTrackLink(href[2])) return anchor;
    const originalUrl = href[2].replace(/&amp;/gi, '&');
    const token = generateTrackingToken();
    links.push({ tokenHash: hashTrackingToken(token), originalUrl, clickCount: 0 });
    return anchor.replace(href[0], `href="${trackingUrl('c', token)}"`);
  });

  const openToken = generateTrackingToken();
  const pixel = `<img src="${trackingUrl('o', openToken)}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden" />`;
  const deliveryHtml = /<\/body\s*>/i.test(delivery)
    ? delivery.replace(/<\/body\s*>/i, `${pixel}</body>`)
    : `${delivery}${pixel}`;

  return {
    deliveryHtml,
    tracking: {
      prepared: true,
      enabled: false,
      openTokenHash: hashTrackingToken(openToken),
      openCount: 0,
      clickCount: 0,
      links,
    },
  };
}

export function trackingSummary(value: unknown): TrackingSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const tracking = value as {
    enabled?: boolean;
    openedAt?: Date;
    openCount?: number;
    dedupedOpenCount?: number;
    automatedOpenCount?: number;
    uncertainOpenCount?: number;
    lastOpenedAt?: Date;
    clickedAt?: Date;
    clickCount?: number;
    dedupedClickCount?: number;
    automatedClickCount?: number;
    unclassifiedClickedAt?: Date;
    lastClickedAt?: Date;
    links?: { originalUrl: string; clickedAt?: Date; clickCount?: number; lastClickedAt?: Date }[];
  };
  if (!tracking.enabled) return undefined;
  const openCount = tracking.openCount ?? 0;
  const clickCount = tracking.clickCount ?? 0;
  const automatedOpenCount = tracking.automatedOpenCount ?? 0;
  const automatedClickCount = tracking.automatedClickCount ?? 0;
  const dedupedOpenCount = tracking.dedupedOpenCount ?? (openCount > 0 ? 1 : 0);
  const dedupedClickCount = tracking.dedupedClickCount ?? (clickCount > 0 ? 1 : 0);
  const uncertainOpenCount = tracking.uncertainOpenCount ?? Math.max(0, openCount - automatedOpenCount);

  const humanReadConfidence: TrackingSummary['humanReadConfidence'] =
    tracking.unclassifiedClickedAt || (clickCount > automatedClickCount)
      ? 'likely_clicked'
      : openCount > 0 || clickCount > 0
        ? 'uncertain'
        : 'none';
  const humanReadLabel =
    humanReadConfidence === 'likely_clicked'
      ? '存在非已知扫描器点击（仍建议以回复为准）'
      : humanReadConfidence === 'uncertain'
        ? '无法确定是否由真人阅读'
        : '暂无互动信号';

  return {
    enabled: true,
    opened: openCount > 0,
    openedAt: tracking.openedAt,
    openCount,
    dedupedOpenCount,
    automatedOpenCount,
    uncertainOpenCount,
    lastOpenedAt: tracking.lastOpenedAt,
    clicked: clickCount > 0,
    clickedAt: tracking.clickedAt,
    clickCount,
    dedupedClickCount,
    automatedClickCount,
    lastClickedAt: tracking.lastClickedAt,
    humanReadConfidence,
    humanReadLabel,
    clickedLinks: (tracking.links ?? []).filter((link) => (link.clickCount ?? 0) > 0).map((link) => ({
      url: link.originalUrl,
      clickedAt: link.clickedAt,
      clickCount: link.clickCount ?? 0,
      lastClickedAt: link.lastClickedAt,
    })),
    coverageNotice: '仅识别部分已知图片代理与安全扫描器（如 Google/Yahoo Proxy、Apple MPP 特征、SafeLinks、Proofpoint、Mimecast、Barracuda 及发信后 5 秒内极速预取）；未命中规则的代理仍可能混入普通计数。',
    accuracyNotice: '邮件客户端、图片代理或隐私保护会影响统计，无法确定是否由真人阅读，且打开数据不能说明邮件进入了主收件箱。',
  };
}

const AUTOMATED_UA_PATTERN = /googleimageproxy|imageproxy|yahoomailproxy|safelinks|proofpoint|mimecast|barracuda|urlscan|headlesschrome|applemail|cfnetwork.*darwin|mozilla\/5\.0\s*\(windows nt 10\.0.*edg\/.*bingpreview|bot|crawler|spider|scanner|virustotal|fortiguard|symantec/i;

export function classifyTrackingRequest(req?: Request, sentAt?: Date, now = new Date()): { automated: boolean; reason?: string } {
  if (sentAt && now.getTime() - sentAt.getTime() >= 0 && now.getTime() - sentAt.getTime() <= FAST_BURST_AFTER_SEND_MS) {
    return { automated: true, reason: 'post_send_fast_burst' };
  }
  if (!req) return { automated: false };
  const ua = req.get('user-agent') ?? '';
  if (AUTOMATED_UA_PATTERN.test(ua)) return { automated: true, reason: 'known_proxy_or_scanner' };
  if (/prefetch|preview/i.test(req.get('sec-purpose') ?? req.get('purpose') ?? '')) {
    return { automated: true, reason: 'prefetch_header' };
  }
  return { automated: false };
}

function requestFingerprint(req?: Request): string {
  const ua = (req?.get('user-agent') ?? 'unknown').slice(0, 200);
  const ip = (req?.ip ?? req?.socket?.remoteAddress ?? 'unknown').slice(0, 64);
  return createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24);
}

export async function recordOpen(token: string, req?: Request): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;
  const now = new Date();
  const tokenHash = hashTrackingToken(token);
  const existing = await DevelopmentLetter.findOne({
    'tracking.openTokenHash': tokenHash,
    'tracking.enabled': true,
    status: { $in: ['sent', 'opened'] },
  }).select('+tracking.lastOpenFingerprint').lean();
  if (!existing) return false;

  const { automated } = classifyTrackingRequest(req, existing.sentAt, now);
  const fingerprint = requestFingerprint(req);
  const lastAt = existing.tracking?.lastOpenedAt ? new Date(existing.tracking.lastOpenedAt) : undefined;
  const isDuplicateBurst = Boolean(
    lastAt
    && now.getTime() - lastAt.getTime() <= DEDUPE_WINDOW_MS
    && (!existing.tracking?.lastOpenFingerprint || existing.tracking.lastOpenFingerprint === fingerprint),
  );

  const result = await DevelopmentLetter.updateOne({
    _id: existing._id,
    'tracking.enabled': true,
    status: { $in: ['sent', 'opened'] },
  }, {
    $set: { status: 'opened', 'tracking.lastOpenFingerprint': fingerprint },
    $min: { 'tracking.openedAt': now, ...(!automated ? { 'tracking.unclassifiedOpenedAt': now } : {}) },
    $max: { 'tracking.lastOpenedAt': now },
    $inc: {
      'tracking.openCount': 1,
      ...(!isDuplicateBurst ? { 'tracking.dedupedOpenCount': 1 } : {}),
      ...(automated ? { 'tracking.automatedOpenCount': 1 } : { 'tracking.uncertainOpenCount': 1 }),
    },
  });
  return result.modifiedCount === 1;
}

export async function recordClick(token: string, req?: Request): Promise<string | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenHash = hashTrackingToken(token);
  const doc = await DevelopmentLetter.findOne({
    'tracking.links.tokenHash': tokenHash,
    'tracking.enabled': true,
    status: { $in: ['sent', 'opened'] },
  }).select('+tracking.links.tokenHash +tracking.lastClickFingerprint');
  const link = doc?.tracking?.links.find((item) => item.tokenHash === tokenHash);
  if (!doc || !link || !isSafeRedirectUrl(link.originalUrl)) return null;

  const now = new Date();
  const { automated } = classifyTrackingRequest(req, doc.sentAt, now);
  const fingerprint = requestFingerprint(req);
  const lastAt = doc.tracking?.lastClickedAt ? new Date(doc.tracking.lastClickedAt) : undefined;
  const isDuplicateBurst = Boolean(
    lastAt
    && now.getTime() - lastAt.getTime() <= DEDUPE_WINDOW_MS
    && (!doc.tracking?.lastClickFingerprint || doc.tracking.lastClickFingerprint === fingerprint),
  );

  const result = await DevelopmentLetter.updateOne({
    _id: doc._id,
    'tracking.links.tokenHash': tokenHash,
    'tracking.enabled': true,
    status: { $in: ['sent', 'opened'] },
  }, {
    $set: { 'tracking.lastClickFingerprint': fingerprint },
    $min: { 'tracking.clickedAt': now, 'tracking.links.$.clickedAt': now, ...(!automated ? { 'tracking.unclassifiedClickedAt': now } : {}) },
    $max: { 'tracking.lastClickedAt': now, 'tracking.links.$.lastClickedAt': now },
    $inc: {
      'tracking.clickCount': 1,
      'tracking.links.$.clickCount': 1,
      ...(!isDuplicateBurst ? { 'tracking.dedupedClickCount': 1 } : {}),
      ...(automated ? { 'tracking.automatedClickCount': 1 } : {}),
    },
  });
  return result.modifiedCount === 1 ? link.originalUrl : null;
}
