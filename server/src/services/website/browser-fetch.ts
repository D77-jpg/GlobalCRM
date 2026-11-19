/**
 * 浏览器兜底抓取（可选，含网络访问隔离与并发限制）
 * ------------------------------------------------------------------
 * 1. 启动前和每次页面请求/跳转前都执行 publicTarget DNS/IPv4 检查，阻断内网/回环/元数据地址；
 * 2. 进程级并发信号量（默认最多 2 个并发页面），避免无头浏览器耗尽内存/CPU；
 * 3. 返回完整渲染后的 HTML（回退 innerText），使 JSON-LD、Shopify 商品卡和内链都可正常解析。
 */
import env from '../../config/env';
import type { WebResponse } from './public-web';
import { publicTarget, websiteUrl } from './public-web';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_CONCURRENT_BROWSERS = Math.max(1, Math.min(4, Number(process.env.WEBSITE_BROWSER_CONCURRENCY || 2)));
const MAX_WAIT_QUEUE = 8;

let activeBrowsers = 0;
const waitQueue: Array<() => void> = [];

async function acquireBrowserSlot(): Promise<boolean> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return true;
  }
  if (waitQueue.length >= MAX_WAIT_QUEUE) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(grant);
      if (idx >= 0) waitQueue.splice(idx, 1);
      resolve(false);
    }, 15_000);
    timer.unref();
    const grant = () => {
      clearTimeout(timer);
      activeBrowsers++;
      resolve(true);
    };
    waitQueue.push(grant);
  });
}

function releaseBrowserSlot(): void {
  activeBrowsers = Math.max(0, activeBrowsers - 1);
  const next = waitQueue.shift();
  if (next) next();
}

export function browserFetchStatus() {
  return { activeBrowsers, queued: waitQueue.length, maxConcurrent: MAX_CONCURRENT_BROWSERS };
}

interface PlaywrightRoute {
  request(): { url(): string; resourceType(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

interface PlaywrightPage {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void> | void): Promise<void>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  url(): string;
}

interface PlaywrightBrowser {
  newPage(options: Record<string, unknown>): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  launch(options: { headless: boolean; args?: string[] }): Promise<PlaywrightBrowser>;
}

async function loadPlaywright(): Promise<PlaywrightLike | undefined> {
  const specifier = 'playwright';
  try {
    const module = (await import(specifier)) as { chromium?: PlaywrightLike };
    return module.chromium;
  } catch {
    return undefined;
  }
}

export async function isBrowserRequestAllowed(
  rawUrl: string,
  resourceType = 'document',
  targetCheck: typeof publicTarget = publicTarget,
): Promise<boolean> {
  if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) return false;
  try {
    await targetCheck(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export async function browserFetch(raw: string): Promise<WebResponse | undefined> {
  if (!env.WEBSITE_BROWSER_FETCH) return undefined;
  let target: { url: URL; address: string };
  try {
    target = await publicTarget(raw);
  } catch {
    return undefined;
  }
  const chromium = await loadPlaywright();
  if (!chromium) return undefined;
  const acquired = await acquireBrowserSlot();
  if (!acquired) return undefined;

  let browser: PlaywrightBrowser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    const allowedHost = target.url.hostname.replace(/^www\./, '');
    await page.route('**/*', async (route) => {
      const req = route.request();
      const reqUrl = req.url();
      const resType = req.resourceType();
      try {
        const parsed = websiteUrl(reqUrl);
        if (resType === 'document' && parsed.hostname.replace(/^www\./, '') !== allowedHost) {
          await route.abort('blockedbyclient');
          return;
        }
        const ok = await isBrowserRequestAllowed(reqUrl, resType);
        if (!ok) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    const response = await page.goto(target.url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (!response || response.status() >= 400) return undefined;
    const finalUrl = page.url();
    try {
      await publicTarget(finalUrl);
    } catch {
      return undefined;
    }
    const html = await page.content().catch(() => '');
    if (html && html.trim().length >= 80 && html.length <= 2 * 1024 * 1024) {
      return { url: finalUrl, text: html, status: 200 };
    }
    const text = await page.evaluate<string>('document.body ? document.body.innerText : ""');
    if (!text?.trim()) return undefined;
    return { url: finalUrl, text, status: 200 };
  } catch {
    return undefined;
  } finally {
    await browser?.close().catch(() => undefined);
    releaseBrowserSlot();
  }
}
