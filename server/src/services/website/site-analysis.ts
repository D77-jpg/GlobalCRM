import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { websiteUrl } from './public-web';

export type ResearchProfile = 'genesis' | 'ironhue' | 'velaturo' | 'general';

export interface StructuredProductCard {
  title: string;
  price?: number;
  currency?: string;
  material?: string;
  category?: string;
}

export interface WebsiteStructuredProfile {
  productLines: string[];
  materials: string[];
  priceBand?: {
    min: number;
    max: number;
    currency: string;
    tier: 'budget' | 'mid' | 'premium' | 'luxury';
  };
  brandPositioning?: string;
  productCards: StructuredProductCard[];
  platform?: 'shopify' | 'woocommerce' | 'generic';
}

export interface WebsitePage {
  url: string;
  title: string;
  text: string;
  hash: string;
  htmlHash: string;
  collectedAt: string;
  links: { url: string; text: string }[];
  name: string;
  structured?: WebsiteStructuredProfile;
}

export interface WebsiteFact {
  id: string;
  kind: string;
  value: string;
  quote: string;
  url: string;
  collectedAt: string;
}

export interface ResearchReport {
  profile: ResearchProfile;
  profileLabel: string;
  company: string;
  emails: string[];
  facts: WebsiteFact[];
  warnings: string[];
  unknowns: string[];
  segments: { label: string; sourceIds: string[] }[];
  angles: { title: string; advice: string; sourceIds: string[] }[];
  score: {
    lower: number;
    upper: number;
    grade: string;
    dimensions: { name: string; max: number; score: number | null; reason: string; sourceIds: string[] }[];
  };
  structuredProfile?: WebsiteStructuredProfile;
  version: 'website-rules-v1';
}

interface Node {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
}

const ignored = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'nav', 'footer']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

const MATERIAL_PATTERNS: [string, RegExp][] = [
  ['18k gold / vermeil', /\b(?:18k|14k|vermeil|solid gold|gold[- ]?plated)\b/i],
  ['sterling silver / 925', /\b(?:sterling silver|925 silver|925)\b/i],
  ['velvet / microfiber', /\b(?:velvet|microfiber|suede|satin|linen|cotton|silk)\b/i],
  ['FSC / recycled paper', /\b(?:fsc|recycled paper|kraft|rigid board|paperboard)\b/i],
  ['genuine / vegan leather', /\b(?:full[- ]?grain leather|italian leather|vegan leather|pu leather)\b/i],
  ['soy / beeswax / glass', /\b(?:soy wax|beeswax|amber glass|ceramic jar)\b/i],
  ['urethane / PU / rubber', /\b(?:urethane|pu dumbbell|virgin rubber|crumb rubber|cast iron|steel)\b/i],
  ['acrylic / oil / linen canvas', /\b(?:acrylic|oil on canvas|linen canvas|stretched canvas|oak frame|hand[- ]?painted)\b/i],
];

function words(node: Node, depth = 0): string {
  if (depth > 60) return '';
  if (node.name && ignored.has(node.name)) return '';
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? [])
    .map((child) => words(child, depth + 1))
    .join(['p', 'div', 'li', 'section', 'br', 'h1', 'h2', 'h3'].includes(node.name ?? '') ? '\n' : ' ');
}

function rawText(node: Node): string {
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map(rawText).join('');
}

function classifyPriceTier(min: number, max: number): 'budget' | 'mid' | 'premium' | 'luxury' {
  const mid = (min + max) / 2;
  if (mid >= 250) return 'luxury';
  if (mid >= 80) return 'premium';
  if (mid >= 25) return 'mid';
  return 'budget';
}

function extractJsonLdItems(jsonText: string, cards: StructuredProductCard[], productLines: Set<string>, materials: Set<string>, positioning: string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return;
  }
  const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
  let visited = 0;
  while (queue.length && ++visited <= 200) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) queue.push(...obj['@graph']);
    const rawType = obj['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType]).map((t) => String(t ?? '').toLowerCase());

    if (types.some((t) => t === 'product' || t === 'productgroup')) {
      const title = clean(String(obj.name ?? '')).slice(0, 140);
      const material = typeof obj.material === 'string' ? clean(obj.material).slice(0, 80) : undefined;
      const category = typeof obj.category === 'string' ? clean(obj.category).slice(0, 80) : undefined;
      let price: number | undefined;
      let currency: string | undefined;
      const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
      if (offers && typeof offers === 'object') {
        const offerObj = offers as Record<string, unknown>;
        const p = Number(offerObj.price ?? offerObj.lowPrice);
        if (Number.isFinite(p) && p > 0) price = p;
        if (typeof offerObj.priceCurrency === 'string') currency = offerObj.priceCurrency.toUpperCase();
      }
      if (title) {
        cards.push({ title, ...(price ? { price } : {}), ...(currency ? { currency } : {}), ...(material ? { material } : {}), ...(category ? { category } : {}) });
        if (category) productLines.add(category);
      }
      if (material) materials.add(material);
    } else if (types.some((t) => t === 'itemlist' || t === 'collectionpage')) {
      if (typeof obj.name === 'string' && obj.name.trim()) productLines.add(clean(obj.name).slice(0, 100));
      if (Array.isArray(obj.itemListElement)) {
        for (const el of obj.itemListElement.slice(0, 30)) {
          if (el && typeof el === 'object') {
            const elObj = el as Record<string, unknown>;
            if (elObj.item) queue.push(elObj.item);
            else if (typeof elObj.name === 'string') cards.push({ title: clean(elObj.name).slice(0, 140) });
          }
        }
      }
    } else if (types.some((t) => t === 'organization' || t === 'brand' || t === 'store')) {
      if (typeof obj.description === 'string' && obj.description.trim()) {
        positioning.push(clean(obj.description).slice(0, 240));
      }
      if (typeof obj.slogan === 'string' && obj.slogan.trim()) {
        positioning.push(clean(obj.slogan).slice(0, 160));
      }
    }
  }
}

function extractShopifyEmbedded(scriptText: string, cards: StructuredProductCard[], productLines: Set<string>) {
  // Shopify often embeds window.ShopifyAnalytics.meta = {"product":{"type":"...","variants":[{"name":"...","price":12900}]}}
  const metaMatch = scriptText.match(/ShopifyAnalytics\.meta\s*=\s*(\{[\s\S]{10,4000}?\});/);
  if (metaMatch?.[1]) {
    try {
      const meta = JSON.parse(metaMatch[1]) as {
        currency?: string;
        product?: { type?: string; vendor?: string; variants?: { name?: string; price?: number }[] };
      };
      if (meta.product?.type) productLines.add(clean(meta.product.type).slice(0, 80));
      for (const v of (meta.product?.variants ?? []).slice(0, 10)) {
        if (!v.name) continue;
        const price = typeof v.price === 'number' && v.price > 0 ? (v.price >= 1000 ? v.price / 100 : v.price) : undefined;
        cards.push({ title: clean(v.name).slice(0, 140), ...(price ? { price } : {}), ...(meta.currency ? { currency: meta.currency } : {}) });
      }
    } catch { /* ignore malformed inline JS */ }
  }
}

export function parseWebsitePage(html: string, url: string, at = new Date().toISOString()): WebsitePage {
  const root = parseDocument(html, { decodeEntities: true });
  const lines: string[] = [];
  const links: { url: string; text: string }[] = [];
  const cards: StructuredProductCard[] = [];
  const productLines = new Set<string>();
  const materials = new Set<string>();
  const positioning: string[] = [];
  let title = '';
  let name = '';
  let ogPrice: number | undefined;
  let ogCurrency = 'USD';
  let platform: WebsiteStructuredProfile['platform'] = 'generic';
  let nodes = 0;

  function walk(node: Node, depth: number, noise = false) {
    if (depth > 60 || ++nodes > 50000) return;
    const attrs = node.attribs ?? {};
    if (node.name === 'title') title = clean(words(node)).slice(0, 240);
    if (node.name === 'meta') {
      const prop = (attrs.property || attrs.name || '').toLowerCase();
      const content = clean(attrs.content ?? '');
      if (prop === 'og:site_name' || prop === 'application-name') name = content.slice(0, 120);
      if (prop === 'description' || prop === 'og:description') {
        if (content.length >= 20) positioning.push(content.slice(0, 240));
      }
      if (prop === 'og:price:amount' || prop === 'product:price:amount') {
        const p = Number(content);
        if (Number.isFinite(p) && p > 0) ogPrice = p;
      }
      if (prop === 'og:price:currency' || prop === 'product:price:currency') {
        if (content) ogCurrency = content.toUpperCase().slice(0, 6);
      }
      if (/shopify/i.test(content) || /shopify/i.test(prop)) platform = 'shopify';
      if (/woocommerce/i.test(content)) platform = 'woocommerce';
    }
    if (node.name === 'script') {
      const type = (attrs.type ?? '').toLowerCase();
      const body = rawText(node);
      if (type.includes('ld+json')) {
        extractJsonLdItems(body, cards, productLines, materials, positioning);
      } else if (/Shopify|ShopifyAnalytics|cdn\.shopify\.com/i.test(body) || /cdn\.shopify\.com/i.test(attrs.src ?? '')) {
        platform = 'shopify';
        extractShopifyEmbedded(body, cards, productLines);
      }
      return;
    }
    if (node.name === 'a' && attrs.href) {
      try {
        const href = new URL(attrs.href, url);
        if (['http:', 'https:', 'mailto:', 'tel:'].includes(href.protocol)) {
          links.push({ url: href.href.slice(0, 1200), text: clean(words(node)).slice(0, 180) });
        }
      } catch { /* Untrusted hrefs are ignored. */ }
    }
    if (node.name && ['style', 'noscript', 'template', 'svg', 'iframe'].includes(node.name)) return;
    noise = noise || ['nav', 'footer', 'form'].includes(node.name ?? '');

    // Detect product card headings by class/data attributes
    const cls = `${attrs.class ?? ''} ${attrs['data-testid'] ?? ''}`.toLowerCase();
    if (!noise && /\b(?:product[-_ ]?(?:card|title|name|item)|grid-product__title|card__heading)\b/.test(cls)) {
      const cardText = clean(words(node)).slice(0, 140);
      if (cardText.length >= 3 && cardText.length <= 120 && !/^(?:add to cart|quick view|sold out|sale)$/i.test(cardText)) {
        const priceMatch = cardText.match(/(?:\$|€|£|USD|EUR|GBP)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
        const price = priceMatch ? Number(priceMatch[1]) : undefined;
        cards.push({ title: cardText.replace(/(?:\$|€|£|USD|EUR|GBP)\s*[0-9,.]+/gi, '').trim().slice(0, 120), ...(price ? { price } : {}) });
      }
    }

    if (!noise && ['h1', 'h2', 'h3', 'p', 'li', 'address'].includes(node.name ?? '')) {
      const text = clean(words(node));
      if (text && text.length <= 1800) lines.push(text);
    }
    for (const child of node.children ?? []) walk(child, depth + 1, noise);
  }
  walk(root, 0);

  const text = [...new Set(lines.length ? lines : words(root).split('\n').map(clean).filter(Boolean))].join('\n').slice(0, 24000);

  // Extract materials from full page text + cards
  for (const [label, pattern] of MATERIAL_PATTERNS) {
    if (pattern.test(text)) materials.add(label);
  }
  if (ogPrice && cards.length === 0 && title) {
    cards.push({ title: title.replace(/\s+[|–—]\s+.*$/, '').slice(0, 120), price: ogPrice, currency: ogCurrency });
  }
  const prices = cards.map((c) => c.price).filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0);
  if (ogPrice) prices.push(ogPrice);
  const dedupedCards = [...new Map(cards.filter((c) => c.title).map((c) => [c.title.toLowerCase(), c])).values()].slice(0, 25);
  const priceBand = prices.length
    ? {
      min: Math.min(...prices),
      max: Math.max(...prices),
      currency: dedupedCards.find((c) => c.currency)?.currency ?? ogCurrency,
      tier: classifyPriceTier(Math.min(...prices), Math.max(...prices)),
    }
    : undefined;

  const hasStructured = dedupedCards.length > 0 || productLines.size > 0 || materials.size > 0 || Boolean(priceBand) || positioning.length > 0;
  const structured: WebsiteStructuredProfile | undefined = hasStructured
    ? {
      productLines: [...productLines].slice(0, 12),
      materials: [...materials].slice(0, 10),
      ...(priceBand ? { priceBand } : {}),
      ...(positioning[0] ? { brandPositioning: positioning[0] } : {}),
      productCards: dedupedCards,
      platform,
    }
    : undefined;

  return {
    url,
    title,
    text,
    hash: hash(text),
    htmlHash: hash(html),
    collectedAt: at,
    links: [...new Map(links.map((l) => [l.url, l])).values()].slice(0, 150),
    name: name || title.replace(/\s+[|–—]\s+.*$/, '').slice(0, 120),
    ...(structured ? { structured } : {}),
  };
}

export function relatedPages(page: WebsitePage): string[] {
  const root = new URL(page.url);
  const chosen = new Map<string, string>();
  const kinds: [string, RegExp][] = [
    ['about', /about|our-story|founder|team|über-uns|关于/i],
    ['contact', /contact|kontakt|联系/i],
    ['legal', /impressum|imprint|legal|法律/i],
    ['trade', /wholesale|trade-account|trade-program|批发/i],
    ['products', /products|collections|catalog|产品/i],
    ['stockists', /stockist|retailers|stores|门店/i],
  ];
  for (const link of page.links) {
    let u;
    try { u = websiteUrl(link.url); } catch { continue; }
    if (u.origin !== root.origin || /login|checkout|cart|logout|delete|\.(?:pdf|zip|docx?|xlsx?|png|jpe?g)$/i.test(u.pathname) || (/account/i.test(u.pathname) && !/trade|wholesale/i.test(u.pathname))) continue;
    for (const [kind, pattern] of kinds) {
      if (!chosen.has(kind) && pattern.test(`${u.pathname} ${link.text}`) && u.href !== page.url) {
        chosen.set(kind, u.href);
        break;
      }
    }
  }
  return [...new Set(chosen.values())].slice(0, 6);
}

export function projectResearchProfile(project: { slug?: string; code?: string; name?: string }): ResearchProfile {
  const text = [project.slug, project.code, project.name].join(' ').toLowerCase();
  return /\bironhue\b/.test(text) ? 'ironhue' : /\bvelaturo\b/.test(text) ? 'velaturo' : /\bgenesis\b/.test(text) ? 'genesis' : 'general';
}

const labels: Record<ResearchProfile, string> = {
  genesis: '包装客户开发',
  ironhue: '健身器材客户开发',
  velaturo: '墙面艺术客户开发',
  general: '通用客户调查',
};

const productPatterns: Record<ResearchProfile, RegExp> = {
  genesis: /jewel(?:lery|ry)|necklace|bracelet|watch|skincare|cosmetic|perfume|fragrance|candle|珠宝|首饰|香氛|蜡烛|美妆/i,
  ironhue: /dumbbell|kettlebell|weight plate|barbell|strength training|fitness equipment|哑铃|壶铃|杠铃|健身器材/i,
  velaturo: /wall art|canvas|portrait|framing|art print|interior design|hotel|画框|装裱|墙饰|肖像|酒店/i,
  general: /product|collection|service|产品|服务/i,
};

const roles: [string, RegExp][] = [
  ['品牌 / 自有产品', /our brand|our collection|designed by|own brand|自有品牌/i],
  ['经销 / 批发', /wholesale|distributor|trade account|批发|经销/i],
  ['零售 / 电商', /shop online|add to cart|online store|零售|网店/i],
  ['健身房 / 工作室', /gym|personal training|fitness studio|健身房|私教/i],
  ['室内 / 空间项目', /interior design|hospitality|hotel project|室内设计|酒店项目/i],
  ['画框 / 装裱', /framing|frame shop|装裱|画框店/i],
];

function mergeStructuredProfiles(pages: WebsitePage[]): WebsiteStructuredProfile | undefined {
  const productLines = new Set<string>();
  const materials = new Set<string>();
  const cards = new Map<string, StructuredProductCard>();
  let brandPositioning: string | undefined;
  let platform: WebsiteStructuredProfile['platform'] = 'generic';
  const prices: number[] = [];
  let currency = 'USD';

  for (const page of pages) {
    const s = page.structured;
    if (!s) continue;
    for (const pl of s.productLines) productLines.add(pl);
    for (const m of s.materials) materials.add(m);
    for (const c of s.productCards) {
      if (!cards.has(c.title.toLowerCase())) cards.set(c.title.toLowerCase(), c);
      if (typeof c.price === 'number' && c.price > 0) {
        prices.push(c.price);
        if (c.currency) currency = c.currency;
      }
    }
    if (s.priceBand) {
      prices.push(s.priceBand.min, s.priceBand.max);
      currency = s.priceBand.currency;
    }
    if (!brandPositioning && s.brandPositioning) brandPositioning = s.brandPositioning;
    if (s.platform && s.platform !== 'generic') platform = s.platform;
  }

  if (!productLines.size && !materials.size && !cards.size && !brandPositioning) return undefined;
  const priceBand = prices.length
    ? {
      min: Math.min(...prices),
      max: Math.max(...prices),
      currency,
      tier: classifyPriceTier(Math.min(...prices), Math.max(...prices)),
    }
    : undefined;
  return {
    productLines: [...productLines].slice(0, 15),
    materials: [...materials].slice(0, 12),
    ...(priceBand ? { priceBand } : {}),
    ...(brandPositioning ? { brandPositioning } : {}),
    productCards: [...cards.values()].slice(0, 30),
    platform,
  };
}

export function analyzeWebsite(pages: WebsitePage[], profile: ResearchProfile, now = new Date()): ResearchReport {
  const facts: WebsiteFact[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const add = (kind: string, value: string, quote: string, page: WebsitePage) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key) || facts.length >= 100) return;
    seen.add(key);
    facts.push({
      id: hash(`${page.url}\n${kind}\n${value}`).slice(0, 24),
      kind,
      value: value.slice(0, 400),
      quote: quote.slice(0, 900),
      url: page.url,
      collectedAt: page.collectedAt,
    });
  };

  for (const page of pages) {
    for (const card of (page.structured?.productCards ?? []).slice(0, 10)) {
      add('product', card.title, `${card.title}${card.price ? ` (${card.currency ?? 'USD'} ${card.price})` : ''}`, page);
    }
    for (const line of page.text.split('\n')) {
      if (/ignore.{0,40}(?:instructions|rules)|忽略.{0,20}(?:规则|指令)|system prompt|自动发送|跨项目/i.test(line)) {
        warnings.push('网页含疑似指令文字，已作为不可信内容排除，未执行。');
        continue;
      }
      if (productPatterns[profile].test(line)) add('product', line, line, page);
      for (const [label, pattern] of roles) if (pattern.test(line)) add('role', label, line, page);
      if (/gift box|gift wrapping|packaging|礼盒|礼品包装/i.test(line)) add('current_state', line, line, page);
      if (/(?:founder|co-founder|founded by|owner|head of|director|buyer|procurement|创始人|采购)\b\s*[:：]?\s*[A-Z][a-z]+\s+[A-Z][a-z]+/i.test(line)) add('person', line, line, page);
      if (/seeking (?:new )?suppliers|looking for (?:a |new )?supplier|采购需求|寻找供应商/i.test(line)) add('buying_signal', line, line, page);
      const date = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      if (date && /launch|new collection|opening|上新|开业/i.test(line)) {
        const age = now.getTime() - Date.parse(date[1]);
        if (age >= 0 && age <= 365 * 86400000) add('recent_trigger', line, line, page);
      }
      const phone = line.match(/(?:phone|tel|电话)\s*[:：]\s*(\+?[\d() .-]{7,30})/i);
      if (phone) add('phone', phone[1].trim(), line, page);
      for (const email of line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) add('email', email.toLowerCase(), line, page);
    }
    for (const link of page.links) {
      if (link.url.startsWith('mailto:')) {
        let email = '';
        try { email = decodeURIComponent(link.url.slice(7).split('?')[0]); } catch { continue; }
        if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) add('email', email.toLowerCase(), link.text || email, page);
      } else if (link.url.startsWith('tel:')) {
        let phone = '';
        try { phone = decodeURIComponent(link.url.slice(4)); } catch { continue; }
        if (/^[+\d() .-]{7,30}$/.test(phone)) add('phone', phone, link.text || phone, page);
      } else if (/(^|\.)(?:linkedin\.com|instagram\.com|wa\.me)$/.test(new URL(link.url).hostname)) {
        add('contact_link', link.url, link.text || link.url, page);
      }
    }
  }

  const find = (kind: string) => facts.filter((f) => f.kind === kind);
  const dimensions: ResearchReport['score']['dimensions'] = [];
  const dimension = (name: string, max: number, score: number | null, reason: string, used: WebsiteFact[]) =>
    dimensions.push({ name, max, score, reason, sourceIds: used.slice(0, 3).map((f) => f.id) });

  dimension('产品适配', 25, find('product').length ? 12.5 : null, find('product').length ? '官网出现相关品类，实际采购适配仍需确认' : '未找到足够的相关产品证据', find('product'));
  dimension('真实需求证据', 20, find('buying_signal').length ? 10 : null, find('buying_signal').length ? '发现寻找供应商的公开陈述，需核对时效与对象' : '销售某类产品不等于正在采购', find('buying_signal'));
  dimension('复购迹象', 15, null, '产品数量和批发渠道不能直接证明复购，待调查', []);
  dimension('采购角色可达', 15, find('email').length ? 7.5 : null, find('email').length ? '发现公开邮箱，未确认是否为采购联系人' : '缺少经过确认的采购联系人', find('email'));
  dimension('近期触发点', 15, find('recent_trigger').length ? 7.5 : null, find('recent_trigger').length ? '存在一年内带明确日期的动态，仍需人工核对' : '缺少带明确日期的近期动态', find('recent_trigger'));
  dimension('初步经济性', 10, null, '缺少采购量、预算或物流条件，不能判断', []);

  const lower = dimensions.reduce((s, d) => s + (d.score ?? 0), 0);
  const upper = lower + dimensions.filter((d) => d.score === null).reduce((s, d) => s + d.max, 0);
  const angles: ResearchReport['angles'] = [];
  const matched = find('product');
  if (matched.length) {
    const mature = find('current_state');
    angles.push({
      title: profile === 'genesis' && mature.length ? '从备选供应方案或新系列切入' : '从已在售品类切入',
      advice: profile === 'genesis' && mature.length
        ? '客户官网已有包装陈述。先核对现状，再询问是否需要备选方案，不推断现有包装有缺陷。'
        : '围绕官网出现的具体产品询问采购或合作方向；我方可提供的产品、工艺和承诺须检索当前项目已发布知识。',
      sourceIds: (mature.length ? mature : matched).slice(0, 3).map((f) => f.id),
    });
  }
  if (find('role').length) {
    angles.push({
      title: '按客户经营方式调整提问',
      advice: '先确认采购身份、目标产品和规模，再准备相应的产品资料；不把经销、零售或场馆身份当成已确认采购需求。',
      sourceIds: find('role').slice(0, 3).map((f) => f.id),
    });
  }

  const structuredProfile = mergeStructuredProfiles(pages);
  return {
    version: 'website-rules-v1',
    profile,
    profileLabel: labels[profile],
    company: pages[0]?.name ?? '',
    emails: find('email').map((f) => f.value).sort((a, b) => Number(/^(info|hello|contact)@/.test(a)) - Number(/^(info|hello|contact)@/.test(b))),
    facts,
    warnings: [...new Set(warnings)],
    unknowns: ['采购数量和预算尚未确认', '真实采购负责人及采购时间尚未确认', '营收、复购频次和现有供应商尚未确认'],
    segments: find('role').map((f) => ({ label: f.value, sourceIds: [f.id] })),
    angles,
    score: { lower, upper, grade: matched.length ? '待研究' : '待确认品类', dimensions },
    ...(structuredProfile ? { structuredProfile } : {}),
  };
}
