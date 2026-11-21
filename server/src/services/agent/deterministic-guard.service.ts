import type { IProjectPolicy } from '../../models/ProjectPolicy';
import type { RedlinePresetItem } from './workbench-presets';
import { DEFAULT_KB_QA_RULES, GENESIS_REDLINE_PRESET } from './workbench-presets';

export type GuardSeverity = 'ok' | 'warn' | 'bad';

export interface GuardCheckItem {
  severity: GuardSeverity;
  code: string;
  message: string;
}

export interface ApprovedQuoteRecord {
  quotationNo?: string;
  external?: boolean;
  expired?: boolean;
  content?: string;
  lines?: {
    item: string;
    qty?: number | string;
    price?: number | string;
    currency?: string;
    status?: 'approved' | 'pending';
  }[];
}

export interface DeterministicGuardContext {
  brandKey?: string;
  policies?: Pick<IProjectPolicy, 'code' | 'topic' | 'valueZh' | 'valueEn' | 'external' | 'confirmed'>[];
  redlines?: RedlinePresetItem[];
  approvedQuotes?: ApprovedQuoteRecord[];
  inboundText?: string;
  threadText?: string;
  contactName?: string;
  attachedOutFiles?: string[];
  channel?: 'email' | 'whatsapp' | 'alibaba' | 'trademanager' | 'instagram' | 'web' | 'chat';
  complaintLevel?: '' | 'R1' | 'R2' | 'R3' | 'R4';
  segment?: string;
  threadSubject?: string;
  signatureText?: string;
  lang?: string;
  destination?: string;
}

export interface ReplyScoreResult {
  score: number;
  coverage: number;
  badCount: number;
  warnCount: number;
  words: number;
  parts: {
    coverage: number;
    specificity: number;
    safety: number;
    writing: number;
    length: number;
  };
  reasons: string[];
  checks: GuardCheckItem[];
}

export interface KbComposeResult {
  subject: string;
  body: string;
  requests: { text: string; group: string; ruleId: string }[];
  covered: { req: string; ruleId: string; isCheckFallback: boolean }[];
  uncovered: string[];
  coverage: number;
  score: ReplyScoreResult;
}

const CHAT_CHANNELS = new Set(['whatsapp', 'trademanager', 'instagram', 'chat']);

const R34_RULES: [RegExp, string][] = [
  [/\bit('s| is) (completely |totally |100% )?safe|safe to (use|continue)/i, '投诉 R3/R4：调查前不能下安全结论'],
  [/we (accept|take) (full )?(responsibility|liability)|our fault|we apologi[sz]e for (the )?(defect|faulty)/i, '投诉 R3/R4：调查前不承认责任'],
  [/we will (refund|replace|remake|compensate)|full refund|free replacement/i, '投诉 R3/R4：调查前不承诺退款或免费补货'],
  [/(caused|damaged) (by|during|in) (the )?(shipping|transit|carrier|courier)/i, '投诉 R3/R4：调查前不归咎运输方'],
];

const MONEY_RE = /(?:US\$|USD|EUR|GBP|RMB|CNY|NOK|AUD|CAD|[$€£¥])\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|RMB|CNY|NOK|dollars|euros)\b/gi;
const TIMES_RE = /(\d+(?:\.\d+)?)\s?(?:[–\-~]|to)\s?(\d+(?:\.\d+)?)\s?(?:working |business |calendar )?(days?|weeks?|months?)|(?<![\d.–\-])(\d+(?:\.\d+)?)\s?(?:working |business |calendar )?(days?|weeks?)\b/gi;
const PCT_RE = /(\d+(?:\.\d+)?)\s?%/g;
const ATTACH_RE = /\b(please find (?:the |our )?(?:attached|enclosed|formal quotation|quotation|quote)|(?:i|we)(?:'ve| have)? (?:attached|enclosed)|(?:i|we)(?:'m| am| are) (?:attaching|enclosing|sending you the attached)|attached (?:is|are|please find|you will find|herewith)|enclosed (?:is|are|please find)|(?:see|find) (?:the |our )?(?:attached|enclosed) (?:quotation|quote|pi|proforma|catalogue|catalog|price ?list|file|drawing|offer|sheet))\b/i;
const PLACEHOLDER_RE = /〔[^〕]{1,40}〕|\[[^\]\n]{1,40}\]|\{[^}\n]{1,30}\}|\bTBD\b|\bXXX+\b|_{3,}/g;
const CHECKY_RE = /\b(i'?ll|i will|we'?ll|we will|let me)\b[^.?!]{0,60}\b(check|confirm|verify|review|come back|get back)\b|\bwith our team\b/gi;

const STOP_WORDS = new Set([
  'the', 'and', 'you', 'your', 'our', 'for', 'with', 'are', 'can', 'what', 'how', 'does', 'have',
  'this', 'that', 'from', 'will', 'would', 'please', 'about', 'any', 'send', 'also', 'want', 'need',
  'know', 'like', 'more', 'which', 'much', 'many', 'when', 'they', 'them', 'there', 'their', 'its',
  'was', 'were', 'been', 'into', 'could', 'kindly', 'information',
]);

function normAmount(raw: string): string {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!cleaned.includes('.')) return cleaned;
  return cleaned.replace(/0+$/, '').replace(/\.$/, '');
}

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  const matches = String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  for (const m of matches) out.add(normAmount(m));
  return out;
}

function safeCompileRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 350) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function stemWord(word: string): string {
  return word.toLowerCase().replace(/(es|s)$/, '');
}

function tokenize(text: string): Set<string> {
  const s = String(text || '').toLowerCase();
  const tokens = new Set<string>();
  for (const w of s.match(/[a-z0-9]+/g) ?? []) {
    if (w.length > 2 && !STOP_WORDS.has(w)) tokens.add(w);
  }
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i += 1) {
    tokens.add(cjk.slice(i, i + 2));
  }
  return tokens;
}

export function extractAllowedAmounts(records?: ApprovedQuoteRecord[]): { allowed: Set<string>; hasPendingLine: boolean } {
  const allowed = new Set<string>();
  let hasPendingLine = false;
  for (const rec of records ?? []) {
    if (rec.external === false || rec.expired) continue;
    let approvedSubtotal = 0;
    let hasApproved = false;
    for (const line of rec.lines ?? []) {
      const st = line.status ?? 'approved';
      if (st === 'pending') {
        hasPendingLine = true;
        continue;
      }
      const p = Number(String(line.price ?? '').replace(/,/g, '').trim());
      const q = Number(String(line.qty ?? '').replace(/,/g, '').trim());
      if (!Number.isFinite(p) || p <= 0) continue;
      allowed.add(normAmount(p.toFixed(2)));
      allowed.add(normAmount(String(line.price)));
      if (Number.isFinite(q) && q > 0) {
        const lineTotal = Math.round(p * q * 100) / 100;
        allowed.add(normAmount(lineTotal.toFixed(2)));
        approvedSubtotal += lineTotal;
        hasApproved = true;
      }
    }
    if (hasApproved) {
      allowed.add(normAmount((Math.round(approvedSubtotal * 100) / 100).toFixed(2)));
    }
    if (rec.content) {
      for (const m of rec.content.matchAll(MONEY_RE)) {
        const num = m[1] || m[2];
        if (num) allowed.add(normAmount(num));
      }
    }
  }
  return { allowed, hasPendingLine };
}

export function extractNamesFromTexts(...texts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  const ignored = new Set([
    'thanks', 'thank', 'regards', 'best', 'hello', 'hi', 'dear', 'the', 'a',
    'interested', 'writing', 'from', 'procurement', 'sales', 'team', 'all', 'there', 'sir', 'madam',
  ]);
  for (const raw of texts) {
    const t = String(raw || '');
    for (const m of t.matchAll(/\b(?:my name is|i am|i'm|i’m|this is)\s+([A-Z][a-zà-ÿ'’-]+)/gi)) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of t.matchAll(/(?:regards|best|sincerely|thanks|thank you|cheers)[,!.]?\s*\n+\s*([A-Z][a-zà-ÿ'’-]+)/gi)) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of t.matchAll(/(?:regards|thanks|thank you|cheers)[,!.]?\s+([A-Z][a-zà-ÿ'’-]+)\.?\s*$/gim)) {
      if (m[1]) out.add(m[1]);
    }
    for (const m of t.matchAll(/\b(?:Hi|Hello|Dear)\s+([A-Z][a-zà-ÿ'’-]+)/g)) {
      if (m[1]) out.add(m[1]);
    }
    for (const line of t.split('\n')) {
      const m = /^\s*([A-Z][a-zà-ÿ'’-]{2,})(?:\s+[A-Z][a-zà-ÿ'’-]+)?\s*$/.exec(line);
      if (m?.[1]) out.add(m[1]);
    }
  }
  return new Set([...out].filter((name) => !ignored.has(name.toLowerCase())));
}

export function extractItemLines(text: string): string[] {
  const out: string[] = [];
  const skipTokens = new Set([
    'qty', 'quantity', 'each', 'per', 'weight', 'total', 'price', 'unit', 'cm', 'mm',
    'kg', 'lb', 'lbs', 'in', 'inch', 'inches', 'pcs', 'pc', 'pieces', 'ft', 'oz', 'ml',
  ]);
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^[\s\-•*·>|]+/, '').trim();
    if (!line || line.length > 120 || line.endsWith('?') || line.endsWith(':')) continue;
    if (!/\d/.test(line) || !/[A-Za-z]{3,}/.test(line)) continue;
    if (/^(hi|hello|dear|thanks|regards|best|tel|phone|email|address|www|http)/i.test(line)) continue;
    const cleaned = line
      .replace(/\(.*?\)/g, ' ')
      .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 ')
      .replace(/\b\d+(?:\.\d+)?\s?(?:kg|lb|lbs|pcs|pieces|pairs|sets|units|x|cm|mm|m|in|inch|inches|ft)?\b/gi, ' ')
      .replace(/[-–:×*=\t|,]+|\bx\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = (cleaned.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !skipTokens.has(w.toLowerCase()));
    if (words.length >= 1 && words.length <= 6) {
      const joined = words.join(' ');
      if (!out.some((x) => x.toLowerCase() === joined.toLowerCase())) out.push(joined);
    }
  }
  return out.length >= 4 ? out : [];
}

export function detectProvidedKinds(text: string): Set<string> {
  const t = String(text || '');
  const kinds = new Set<string>();
  if (/\b\d+\s?(pcs|pieces|pairs|sets|units|pouch(?:es)?|bags?|boxes|box|mailers?)\b|\bx\s?\d+\s?(pcs|pairs|sets)?\b|\bqty\b/i.test(t)) {
    kinds.add('qty');
  }
  if (/\b(black|white|grey|gray|red|blue|green|yellow|orange|pink|purple|pantone|pms)\b/i.test(t)) {
    kinds.add('colour');
  }
  if (/logo[^.\n]{0,20}(attached|enclosed|printed|moulded|molded|engraved)|attached[^.\n]{0,20}logo|\.(ai|svg|eps|pdf)\b|logo file|with (our|my|the) (own )?(logo|brand)|\bno logo\b|\bblank\b|\bunbranded\b|\b(foil|emboss|deboss|embroider|screen[- ]print|uv print|offset)\b/i.test(t)) {
    kinds.add('logo');
  }
  if (/\b(port of|destination|deliver(y|ed)? to|zip|postcode)\b/i.test(t)) {
    kinds.add('dest');
  }
  if (/\d+(?:\.\d+)?\s?(cm|mm|in|")?\s?[x×*]\s?\d+(?:\.\d+)?/i.test(t)) {
    kinds.add('size');
  }
  if (/\b(velvet|satin|cotton|canvas|muslin|linen|burlap|jute|organza|microfib|suede)\b|丝绒|绒布|缎|棉|麻|欧根纱|超纤/i.test(t)) {
    kinds.add('material');
  }
  return kinds;
}

export function detectScamSignals(text: string): string[] {
  const t = String(text || '');
  const signals: string[] = [];
  if ((t.match(/https?:\/\//gi) ?? []).length >= 2) {
    signals.push('询盘包含多个外部链接，请核实后再点击');
  }
  if (/(verify|confirm) your (account|email)|log ?in to (view|download)|password|sign in to/i.test(t)) {
    signals.push('要求登录或验证账号（典型钓鱼特征）');
  }
  if (/send (me )?(your )?(price ?list|catalog(ue)?) (for|of) all/i.test(t) && t.length < 220) {
    signals.push('仅索要全部价目表、缺少具体规格，注意先筛查真实需求');
  }
  return signals;
}

export function runDeterministicGuard(subject: string, body: string, ctx: DeterministicGuardContext): GuardCheckItem[] {
  const out: GuardCheckItem[] = [];
  const subj = String(subject || '');
  const text = String(body || '');
  const both = `${subj}\n${text}`;
  const seg = (ctx.segment || '').toUpperCase();

  // 1. Project redlines
  for (const rule of ctx.redlines ?? []) {
    if (!rule.enabled) continue;
    if (rule.skipSegment && seg === rule.skipSegment.toUpperCase()) continue;
    const rx = safeCompileRegex(rule.pattern);
    if (!rx) continue;
    const match = rx.exec(both);
    if (match) {
      const prefix = rule.severity === 'warn' ? '注意' : '红线';
      out.push({
        severity: rule.severity,
        code: `redline:${rule.id}`,
        message: `${prefix}：“${match[0].trim().slice(0, 60)}” ${rule.message}`,
      });
    }
  }

  // 2. High-risk complaints R3/R4
  if (ctx.complaintLevel === 'R3' || ctx.complaintLevel === 'R4') {
    for (const [rx, message] of R34_RULES) {
      const match = rx.exec(text);
      if (match) {
        out.push({ severity: 'bad', code: 'complaint_r34', message: `${message}（“${match[0]}”）` });
      }
    }
  }

  // 3. Fake attachment check
  const attMatch = ATTACH_RE.exec(text);
  if (attMatch && !(ctx.attachedOutFiles && ctx.attachedOutFiles.length > 0)) {
    out.push({
      severity: 'bad',
      code: 'fake_attachment',
      message: `正文写了“${attMatch[0]}”，但未登记待发送附件。请先添加真实附件或改写为下一步动作`,
    });
  }

  // 4. Approved amount whitelist
  const { allowed: quoteAmounts, hasPendingLine } = extractAllowedAmounts(ctx.approvedQuotes);
  const inboundNumbers = numbersIn(ctx.inboundText || '');
  const badMoney = new Set<string>();
  for (const m of text.matchAll(MONEY_RE)) {
    const rawNum = m[1] || m[2];
    if (!rawNum) continue;
    const norm = normAmount(rawNum);
    if (!quoteAmounts.has(norm) && !inboundNumbers.has(norm)) {
      badMoney.add(m[0].trim());
    }
  }
  if (badMoney.size > 0) {
    out.push({
      severity: 'bad',
      code: 'unapproved_amount',
      message: `以下金额无对应的已批准报价行：${[...badMoney].slice(0, 6).join('、')}。无批准价格时不得写金额`,
    });
  }
  if (hasPendingLine && /\b(grand total|total (price|amount|cost) (is|of|comes to|will be))\b/i.test(text)) {
    out.push({
      severity: 'bad',
      code: 'pending_grand_total',
      message: '存在待报价行，禁止写全单总价；只能写“已报价部分小计”并点名待报行',
    });
  }

  // 5. Time & percentage whitelist (from external policies + confirmed quotes + thread)
  const externalPolicies = (ctx.policies ?? []).filter((p) => p.external);
  const sourceBlob = [
    ...externalPolicies.map((p) => `${p.valueEn || ''} ${p.valueZh || ''}`),
    ...(ctx.approvedQuotes ?? []).filter((r) => r.external !== false).map((r) => r.content || ''),
    ctx.threadText || '',
    ctx.inboundText || '',
  ].join(' ');
  const srcNums = numbersIn(sourceBlob);
  const srcRanges = new Set<string>();
  for (const m of sourceBlob.matchAll(/(\d+(?:\.\d+)?)\s?(?:[–\-~]|to)\s?(\d+(?:\.\d+)?)/gi)) {
    srcRanges.add(`${normAmount(m[1])}-${normAmount(m[2])}`);
  }
  const srcSingleTime = new Set<string>(numbersIn(`${ctx.threadText || ''} ${ctx.inboundText || ''}`));
  for (const m of sourceBlob.matchAll(TIMES_RE)) {
    if (m[4]) srcSingleTime.add(normAmount(m[4]));
  }
  const badTimes = new Set<string>();
  for (const m of text.matchAll(TIMES_RE)) {
    if (m[1] && m[2]) {
      if (!srcRanges.has(`${normAmount(m[1])}-${normAmount(m[2])}`)) badTimes.add(m[0]);
    } else if (m[4]) {
      if (!srcSingleTime.has(normAmount(m[4]))) badTimes.add(m[0]);
    }
  }
  if (badTimes.size > 0) {
    out.push({
      severity: 'bad',
      code: 'unapproved_time',
      message: `以下时间周期不在已批准对外口径或往来中：${[...badTimes].slice(0, 5).join('、')}。请核对口径或改为“随报价确认”`,
    });
  }
  const badPct = new Set<string>();
  for (const m of text.matchAll(PCT_RE)) {
    if (!srcNums.has(normAmount(m[1]))) badPct.add(m[0]);
  }
  if (badPct.size > 0) {
    out.push({
      severity: 'bad',
      code: 'unapproved_percentage',
      message: `以下百分比缺乏来源依据：${[...badPct].slice(0, 5).join('、')}（税率、公差、付款比例需来自口径或资料）`,
    });
  }

  // 6. Placeholders & CJK leaked in English
  const placeholders = [...new Set(both.match(PLACEHOLDER_RE) ?? [])];
  if (placeholders.length > 0) {
    out.push({ severity: 'bad', code: 'placeholder', message: `仍有占位符或待填项：${placeholders.slice(0, 6).join('、')}` });
  }
  if ((ctx.lang || 'en').startsWith('en') && /[\u4e00-\u9fff]/.test(both)) {
    out.push({ severity: 'bad', code: 'cjk_in_english', message: '英文回复正文或主题中夹杂了中文字符' });
  }

  // 7. New-thread fake Re:/Fw:
  if (/^\s*(re|fw|fwd)\s*:/i.test(subj) && !(ctx.threadSubject || '').trim()) {
    out.push({ severity: 'bad', code: 'fake_re_subject', message: '新邮件线程不要在主题前加 Re:/Fw:' });
  }

  // 8. Name guessing
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const greetMatch = /^(?:hi|hello|dear|hey|good (?:morning|afternoon|evening))\s+([A-Z][\w'’-]+)/i.exec(firstLine);
  if (greetMatch) {
    const candidate = greetMatch[1].toLowerCase();
    const generic = new Set(['there', 'team', 'all', 'everyone', 'sir', 'madam', 'friends']);
    if (!generic.has(candidate)) {
      const known = extractNamesFromTexts(ctx.inboundText, ctx.threadText);
      if (ctx.contactName) {
        const firstToken = ctx.contactName.trim().split(/\s+/)[0];
        if (firstToken) known.add(firstToken);
      }
      const lowerKnown = new Set([...known].map((n) => n.toLowerCase()));
      if (!lowerKnown.has(candidate)) {
        out.push({
          severity: 'bad',
          code: 'guessed_name',
          message: `称呼里的名字“${greetMatch[1]}”在来信与客户档案中找不到，禁止猜名，请改用 Hi, 或 Hello,`,
        });
      }
    }
  }

  // 9. Signature verification
  if (ctx.signatureText?.trim()) {
    const sigLines = ctx.signatureText.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const tail = sigLines.slice(-2);
    if (tail.length > 0 && !tail.every((line) => text.includes(line))) {
      out.push({ severity: 'warn', code: 'signature_mismatch', message: `结尾与配置签名不一致：${tail.join(' / ')}` });
    }
  }

  // 10. Long-list line-by-line coverage
  const itemLines = extractItemLines(ctx.inboundText || '');
  if (itemLines.length >= 4) {
    const replyStems = new Set((text.match(/[A-Za-z]{2,}/g) ?? []).map(stemWord));
    const missing = itemLines.filter((item) => {
      const words = (item.match(/[A-Za-z]{3,}/g) ?? []);
      return !words.some((w) => replyStems.has(stemWord(w)));
    });
    if (missing.length > 0) {
      out.push({
        severity: 'warn',
        code: 'long_list_missing',
        message: `清单共 ${itemLines.length} 行，以下行在正文中未覆盖：${missing.slice(0, 8).join('、')}`,
      });
    }
  }

  // 11. Re-asking already provided details
  const questions = text.match(/[^.?!\n]*\?/g) ?? [];
  const provided = detectProvidedKinds(`${ctx.inboundText || ''}\n${ctx.threadText || ''}`);
  const askPatterns: [string, RegExp, string][] = [
    ['qty', /how many|quantit/i, '数量'],
    ['colour', /colou?r/i, '颜色'],
    ['logo', /logo (file|artwork)|vector|artwork/i, 'Logo 文件'],
    ['dest', /destination|port|zip|postcode|delivery address/i, '目的地'],
    ['size', /(what|which|exact) size|dimensions/i, '尺寸'],
    ['material', /(which|what) (material|fabric)/i, '材料'],
  ];
  const reAsked = askPatterns
    .filter(([key, rx]) => provided.has(key) && questions.some((q) => rx.test(q)))
    .map(([, , label]) => label);
  if (reAsked.length > 0) {
    out.push({ severity: 'warn', code: 'reask_provided', message: `可能重复追问了买家已提供的信息：${reAsked.join('、')}` });
  }
  if (questions.length > 3) {
    out.push({ severity: 'warn', code: 'too_many_questions', message: `正文包含 ${questions.length} 个问句，建议收敛为 2–3 个核心问题` });
  }

  // 12. Industry / Genesis-specific extra guards (unit consistency, US paper bags, food contact)
  const inbound = ctx.inboundText || '';
  const bCm = /\d\s?(cm|mm)\b/i.test(inbound);
  const bIn = /\d\s?(in|inch|inches|")\b/i.test(inbound);
  const rCm = /\d\s?(cm|mm)\b/i.test(text);
  const rIn = /\d\s?(in|inch|inches)\b/i.test(text);
  if (bCm && !bIn && rIn && !rCm) {
    out.push({ severity: 'warn', code: 'unit_mismatch', message: '买家用厘米/毫米，回复却改成了英寸：请保留买家单位' });
  }
  if (bIn && !bCm && rCm && !rIn) {
    out.push({ severity: 'warn', code: 'unit_mismatch', message: '买家用英寸，回复却改成了厘米：请保留买家单位' });
  }
  const fullCtx = `${inbound} ${ctx.threadText || ''} ${ctx.destination || ''}`;
  if (/\b(usa?|united states|america|u\.s\.)\b|\b(CA|NY|TX|FL|NJ)\b \d{5}/i.test(fullCtx)
    && /paper (shopping |gift )?bags?/i.test(inbound)
    && !/anti-?dumping|countervailing|dut(y|ies)|tariff/i.test(text)) {
    out.push({ severity: 'warn', code: 'us_paper_bag_duty', message: '美国客户问带提手纸袋：需提醒反倾销/反补贴税，并优先建议布袋或盒子' });
  }
  if (/\b(food|tea|coffee|candy|chocolate|cookies?)\b/i.test(inbound)
    && /\b(cotton|linen|jute|burlap)\b/i.test(inbound)
    && !/food[- ]contact|touch (the )?food|in contact with/i.test(text)) {
    out.push({ severity: 'warn', code: 'food_contact_check', message: '棉/麻布袋可能直接接触食品：需提醒先确认食品接触适用性' });
  }

  // 13. Length bounds
  const words = (text.match(/[A-Za-z’']+/g) ?? []).length;
  const isChat = CHAT_CHANNELS.has(ctx.channel || 'email');
  const maxWords = isChat ? 95 : 420;
  if (words > maxWords) {
    out.push({ severity: 'warn', code: 'too_long', message: `约 ${words} 个英文词，偏长（建议 ${maxWords} 词以内）` });
  } else if (words > 0 && words < 20) {
    out.push({ severity: 'warn', code: 'too_short', message: `仅约 ${words} 个英文词，请确认是否完整回应买家诉求` });
  }

  return out.length > 0
    ? out
    : [{ severity: 'ok', code: 'all_clear', message: '未发现红线、无来源金额/时间、假附件、猜名或占位符问题' }];
}

export function extractBuyerRequests(text: string): { text: string; group: string; ruleId: string }[] {
  const cleaned = String(text || '').replace(/[*_]/g, ' ');
  const askRe = /\?|\b(please (send|let|advise|quote|share|confirm|clarify|provide)|could you|can you|would you|do you|are you|is it|kindly|i(?:'d| would) (?:like|appreciate)|we(?:'d| would) (?:like|appreciate)|need to know|want to know|whether|tell me|let me know|wondering)\b/i;
  const candidates: string[] = [];
  for (const rawLine of cleaned.split(/\n+/)) {
    const trimmed = rawLine.trim();
    const line = trimmed.replace(/^[\t \-•·>]+/, '');
    if (line.length < 6 || line.endsWith(':') || /^(subject|from|to|sent|date)\s*:/i.test(line)) continue;
    if (/^(hi|hello|dear|thanks|thank you|best|kind regards|regards|cheers)\b/i.test(line) && !line.includes('?') && line.length < 40) continue;
    const isBullet = /^(\d+[.)]|[-•*·])\s/.test(trimmed);
    for (const sent of line.split(/(?<=[.?!])\s+/)) {
      const s = sent.replace(/^(hi|hello|hey|dear)\b[^,.!?]{0,30}[,!.]\s*/i, '').trim();
      if (s.length > 5 && (isBullet || askRe.test(s))) candidates.push(s);
    }
  }
  const out: { text: string; group: string; ruleId: string }[] = [];
  const seen = new Set<string>();
  const compiled = DEFAULT_KB_QA_RULES.map((rule) => ({ rule, rx: safeCompileRegex(rule.pattern) })).filter((x) => x.rx);
  for (const cand of candidates.slice(0, 24)) {
    let matched = false;
    for (const { rule, rx } of compiled) {
      if (!rx || seen.has(rule.group)) continue;
      if (rx.test(cand)) {
        seen.add(rule.group);
        out.push({ text: cand.slice(0, 280), group: rule.group, ruleId: rule.id });
        matched = true;
      }
    }
    if (!matched) {
      const key = `other:${cand.toLowerCase().slice(0, 48)}`;
      if (!seen.has(key) && tokenize(cand).size >= 2) {
        seen.add(key);
        out.push({ text: cand.slice(0, 280), group: '', ruleId: '' });
      }
    }
  }
  for (const { rule, rx } of compiled) {
    if (!rule.statement || !rx || seen.has(rule.group)) continue;
    const m = rx.exec(cleaned);
    if (m) {
      seen.add(rule.group);
      out.push({ text: m[0].slice(0, 280), group: rule.group, ruleId: rule.id });
    }
  }
  return out.slice(0, 14);
}

export function scoreWorkbenchReply(subject: string, body: string, ctx: DeterministicGuardContext): ReplyScoreResult {
  const text = String(body || '');
  const reqs = extractBuyerRequests(ctx.inboundText || '');
  const sents = text.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const solidText = sents.filter((s) => !CHECKY_RE.test(s)).join(' ');
  const ackText = sents.filter((s) => CHECKY_RE.test(s)).join(' ');
  const ruleMap = new Map(DEFAULT_KB_QA_RULES.map((r) => [r.id, safeCompileRegex(r.pattern)]));

  const perReq: number[] = reqs.map((req) => {
    const rx = ruleMap.get(req.ruleId);
    const keyTokens = new Set([...tokenize(req.text)].filter((w) => w.length > 3));
    const hit = (haystack: string): boolean => {
      if (rx && rx.test(haystack)) return true;
      if (keyTokens.size === 0) return false;
      const hTokens = tokenize(haystack);
      let overlap = 0;
      for (const k of keyTokens) if (hTokens.has(k)) overlap += 1;
      return overlap >= Math.max(1, Math.round(keyTokens.size * 0.34));
    };
    if (hit(solidText)) return 1;
    if (hit(ackText)) return 0.5;
    return 0;
  });
  let cov = perReq.length > 0 ? perReq.reduce((a, b) => a + b, 0) / perReq.length : 1;
  const itemLines = extractItemLines(ctx.inboundText || '');
  if (itemLines.length >= 4) {
    const replyStems = new Set((text.match(/[A-Za-z]{2,}/g) ?? []).map(stemWord));
    const lineCov = itemLines.filter((x) => (x.match(/[A-Za-z]{3,}/g) ?? []).some((w) => replyStems.has(stemWord(w)))).length / itemLines.length;
    cov = perReq.length > 0 ? (cov + lineCov) / 2 : lineCov;
  }

  // Specificity (15)
  const inbound = ctx.inboundText || '';
  const specs = new Set<string>();
  for (const m of inbound.matchAll(/\d+(?:[.,]\d+)?\s?(?:-|–|to|x|×)?\s?\d*(?:\.\d+)?\s?(?:kg|lbs?|pcs|pieces|pairs|sets|units|ft|cm|mm|in|inch|inches)\b/gi)) {
    specs.add(m[0].replace(/\s/g, '').toLowerCase());
  }
  const compactReply = text.replace(/\s/g, '').toLowerCase();
  const specHits = [...specs].filter((s) => compactReply.includes(s)).length;
  const specificity = specs.size === 0 ? 15 : Math.round(15 * Math.min(1, specHits / Math.max(2, 0.45 * specs.size)));

  // Safety (30)
  const checks = runDeterministicGuard(subject, text, ctx);
  const badCount = checks.filter((c) => c.severity === 'bad').length;
  const warnCount = checks.filter((c) => c.severity === 'warn').length;
  const safety = Math.max(0, 30 - 15 * badCount - 3 * warnCount);

  // Writing (10)
  let writing = 10;
  const reasons: string[] = [];
  const words = (text.match(/[A-Za-z’']+/g) ?? []).length;
  const meaningfulSents = sents.filter((s) => s.split(/\s+/).length > 2);
  const avgWords = words / Math.max(1, meaningfulSents.length);
  const bullets = text.split('\n').map((l) => l.trim()).filter((l) => /^([-•*·]|\d+[.)])\s/.test(l) && l.split(/\s+/).length < 9);
  if (bullets.length >= 3 || (avgWords < 8 && words > 40)) {
    writing -= 4;
    reasons.push('略显电报体，建议自然段表达');
  }
  const checkyCount = (text.match(CHECKY_RE) ?? []).length;
  if (checkyCount > 2) {
    writing -= Math.min(4, checkyCount - 2);
    reasons.push(`“待核实”表述偏多（${checkyCount} 处）`);
  }
  const qMarks = (text.match(/\?/g) ?? []).length;
  if (qMarks > 3) {
    writing -= 2;
    reasons.push(`问句偏多（${qMarks} 个）`);
  }
  if (!/^(hi|hello|dear|good)/i.test(text.trim())) {
    writing -= 2;
    reasons.push('缺少礼貌称呼');
  }
  writing = Math.max(0, writing);

  // Length (10)
  const isChat = CHAT_CHANNELS.has(ctx.channel || 'email');
  const [lo, hi] = isChat ? [10, 100] : [35, 420];
  const length = words >= lo && words <= hi ? 10 : words <= hi * 1.35 ? 5 : 0;

  const coverageScore = Math.round(35 * cov);
  const score = Math.min(100, Math.round(coverageScore + specificity + safety + writing + length));
  if (specs.size > 0 && specHits < 1) reasons.push('未引用买家给出的具体数量/尺寸信息');

  return {
    score,
    coverage: Number(cov.toFixed(2)),
    badCount,
    warnCount,
    words,
    parts: { coverage: coverageScore, specificity, safety, writing, length },
    reasons,
    checks,
  };
}

export function composeDeterministicKbReply(ctx: DeterministicGuardContext): KbComposeResult {
  const inbound = ctx.inboundText || '';
  const policyMap = new Map((ctx.policies ?? []).map((p) => [p.code.toUpperCase(), p]));
  const reqs = extractBuyerRequests(inbound);
  const paragraphs: string[] = [];
  const covered: { req: string; ruleId: string; isCheckFallback: boolean }[] = [];
  const uncovered: string[] = [];
  const usedRules = new Set<string>();

  for (const req of reqs) {
    const rule = DEFAULT_KB_QA_RULES.find((r) => r.id === req.ruleId);
    if (!rule) {
      if (/\b(quote|quotation|price|pricing|cost)\b/i.test(req.text)) {
        covered.push({ req: req.text, ruleId: 'QUOTE', isCheckFallback: false });
      } else {
        uncovered.push(req.text);
      }
      continue;
    }
    let answerText = '';
    let isCheckFallback = false;
    if (rule.policyCodes && rule.policyCodes.length > 0) {
      const matchedPolicies = rule.policyCodes
        .map((c) => policyMap.get(c))
        .filter((p): p is NonNullable<typeof p> => Boolean(p && p.external && p.valueEn.trim()));
      if (matchedPolicies.length > 0) {
        answerText = matchedPolicies.map((p) => p.valueEn.trim()).join(' ');
      } else {
        answerText = rule.checkFallbackEn || '';
        isCheckFallback = true;
      }
    } else if (rule.answerEn) {
      answerText = rule.answerEn;
    }
    if (!answerText) {
      uncovered.push(req.text);
      continue;
    }
    if (!usedRules.has(rule.id)) {
      usedRules.add(rule.id);
      paragraphs.push(answerText);
    }
    covered.push({ req: req.text, ruleId: rule.id, isCheckFallback });
  }

  // US paper bag advisory paragraph when policy is enabled
  const fullCtx = `${inbound} ${ctx.threadText || ''} ${ctx.destination || ''}`;
  if (/paper (shopping |gift |carrier )?bags?/i.test(inbound) && /\b(usa?|united states|america|u\.s\.)\b/i.test(fullCtx)) {
    const usPolicy = policyMap.get('P-US-PAPERBAG');
    if (usPolicy?.external && usPolicy.valueEn.trim() && !paragraphs.includes(usPolicy.valueEn.trim())) {
      paragraphs.unshift(`${usPolicy.valueEn.trim()} We can quote fabric or box alternatives so you can compare.`);
    }
  }

  const names = extractNamesFromTexts(inbound, ctx.threadText);
  const greetingName = ctx.contactName?.trim().split(/\s+/)[0] || [...names][0] || '';
  const bodyParts: string[] = [greetingName ? `Hi ${greetingName},` : 'Hello,', ''];
  const itemLines = extractItemLines(inbound);
  if (itemLines.length >= 4) {
    bodyParts.push(`Thanks for sharing the detailed list (${itemLines.length} items: ${itemLines.join(', ')}). We will review each line and confirm what we manufacture directly so the quotation is clear item by item.`, '');
  } else {
    bodyParts.push('Thanks for reaching out with your inquiry.', '');
  }
  if (paragraphs.length > 0) {
    bodyParts.push(paragraphs.join('\n\n'), '');
  }
  if (uncovered.length > 0) {
    bodyParts.push('I will check the remaining points in your message with our team and come back to you shortly.', '');
  }

  const have = detectProvidedKinds(`${inbound}\n${ctx.threadText || ''}`);
  const missingPrompts: string[] = [];
  if (!have.has('size')) missingPrompts.push('the exact dimensions');
  if (!have.has('qty')) missingPrompts.push('the target quantity');
  if (!have.has('colour')) missingPrompts.push('the colour or PMS reference');
  if (missingPrompts.length > 0 && !reqs.some((r) => r.group === 'complaint' || r.group === 'scope')) {
    const joined = missingPrompts.length === 1
      ? missingPrompts[0]
      : `${missingPrompts.slice(0, -1).join(', ')} and ${missingPrompts[missingPrompts.length - 1]}`;
    bodyParts.push(`To prepare an accurate quotation, could you share ${joined}?`, '');
  } else if (!reqs.some((r) => r.group === 'complaint' || r.group === 'scope')) {
    bodyParts.push('That gives us what we need to prepare the quotation for you.', '');
  }

  bodyParts.push((ctx.signatureText || 'Best regards,\nSales Team').trim());
  const body = bodyParts.join('\n').trim();
  const ts = (ctx.threadSubject || '').trim();
  const subject = CHAT_CHANNELS.has(ctx.channel || 'email') ? '' : (ts ? (/^re:/i.test(ts) ? ts : `Re: ${ts}`) : 'Your inquiry');
  const cov = reqs.length > 0 ? covered.reduce((s, c) => s + (c.isCheckFallback ? 0.5 : 1), 0) / reqs.length : 1;
  const score = scoreWorkbenchReply(subject, body, ctx);

  return { subject, body, requests: reqs, covered, uncovered, coverage: Number(cov.toFixed(2)), score };
}

export interface GuardSelftestCaseResult {
  name: string;
  expect: 'block' | 'pass';
  ok: boolean;
  got: string[];
}

export function runGuardrailSelftest(
  policies: Pick<IProjectPolicy, 'code' | 'topic' | 'valueZh' | 'valueEn' | 'external' | 'confirmed'>[],
  redlines?: RedlinePresetItem[],
): { total: number; passed: number; failed: number; results: GuardSelftestCaseResult[] } {
  const activeRedlines = redlines && redlines.length > 0 ? redlines : GENESIS_REDLINE_PRESET;
  const sig = '\n\nBest regards,\nGenesis Bags\nwww.genesisbags.com';
  const approvedSampleQuotes: ApprovedQuoteRecord[] = [{
    quotationNo: 'QT-TEST-001',
    external: true,
    lines: [
      { item: 'Black velvet pouch 10x12 cm', qty: 500, price: 0.85, currency: 'USD', status: 'approved' },
      { item: 'Magnetic gift box 20x15x5 cm', qty: 300, price: '', currency: 'USD', status: 'pending' },
    ],
  }];

  const badCases: [string, string, Partial<DeterministicGuardContext>, string][] = [
    ['旧 MOQ（500 件）', `Hi,\n\nThe MOQ is 500 pcs for custom fabric pouches.${sig}`, {}, '作废'],
    ['旧交期（15–20 天）', `Hi,\n\nProduction takes 15–20 days.${sig}`, {}, '作废'],
    ['FSC certified 错写法', `Hi,\n\nOur boxes are FSC certified.${sig}`, {}, 'FSC'],
    ['BSCI certified 错写法', `Hi,\n\nWe are BSCI certified.${sig}`, {}, 'BSCI'],
    ['免费定制样品', `Hi,\n\nWe can send free custom samples with your logo.${sig}`, {}, '样品'],
    ['X 年经验', `Hi,\n\nWe have 12 years of experience in packaging.${sig}`, {}, '年'],
    ['Genesis Group 旧名', `Hi,\n\nGenesis Group makes pouches in Xiamen.${sig}`, {}, 'Genesis Group'],
    ['证书编号外泄', `Hi,\n\nOur FSC licence number is FSC-C123456.${sig}`, {}, '证书编号'],
    ['擅自写克重', `Hi,\n\nWe will use 280 gsm cotton for this.${sig}`, {}, '克重'],
    ['旧付款口径（见提单）', `Hi,\n\nThe balance is paid against a copy of the B/L.${sig}`, {}, '付款'],
    ['无批准报价却写金额', `Hi,\n\nThe pouches are USD 0.65 each.${sig}`, {}, '金额'],
    ['含待报行仍捏造总价', `Hi,\n\nThe boxes are USD 1.20 each and the grand total is USD 785.${sig}`, { approvedQuotes: approvedSampleQuotes }, '金额'],
    ['未登记附件却写 attached', `Hi,\n\nPlease find attached our formal quotation.${sig}`, {}, '附件'],
    ['称呼猜人名', `Hi John,\n\nThanks for your inquiry about velvet pouches.${sig}`, {}, '猜名'],
    ['承诺零公差绝对一致', `Hi,\n\nThe colour will be exactly the same colour as your Pantone, zero tolerance.${sig}`, {}, '一致'],
    ['授权形象红线', `Hi,\n\nWe can print Disney characters on the pouches.${sig}`, {}, '授权'],
    ['内部口径编号外泄', `Hi,\n\nPer P-MOQ, the minimum is 100 pieces.${sig}`, {}, '内部编号'],
    ['残留占位符', `Hi,\n\nThe sample is ready in [X] days.${sig}`, {}, '占位'],
    ['模板套话', `Dear Sir,\n\nHope this email finds you well. We offer the best price.${sig}`, {}, '套话'],
    ['R3/R4 投诉擅自承诺退款', `Hi,\n\nWe accept full responsibility and will issue a full refund immediately.${sig}`, { complaintLevel: 'R3' }, '投诉'],
  ];

  const goodCases: [string, string, Partial<DeterministicGuardContext>][] = [
    ['现有样品免费（规范口径）', `Hi,\n\nExisting samples are free; you only cover the shipping. Custom samples are charged and credited against your bulk order.${sig}`, {}],
    ['MOQ 100 与规范打样周期', `Hi,\n\nOur MOQ is 100 pieces for all custom products. Pouch samples take 3–5 days and box samples take 5–7 days.${sig}`, {
      policies: [
        { code: 'P-MOQ', topic: 'MOQ', valueZh: '100', valueEn: 'Our MOQ is 100 pieces for all custom products.', external: true, confirmed: true },
        { code: 'P-SAMPLE-TIME', topic: '打样', valueZh: '3-5 / 5-7', valueEn: 'Pouch samples take 3–5 days. Box samples take 5–7 days.', external: true, confirmed: true },
      ],
    }],
    ['引用已批准报价行且未捏造总价', `Hi,\n\nThe black velvet pouches are USD 0.85 each for 500 pieces, and the magnetic box is still being priced by costing.${sig}`, { approvedQuotes: approvedSampleQuotes }],
    ['规范 FSC Chain of Custody 写法', `Hi,\n\nWe hold FSC® Chain of Custody certification for paper and board products, and I can send you a copy.${sig}`, {}],
  ];

  const results: GuardSelftestCaseResult[] = [];
  for (const [name, body, overrides, expectKey] of badCases) {
    const checks = runDeterministicGuard('Custom velvet pouches', body, {
      policies,
      redlines: activeRedlines,
      signatureText: sig.trim(),
      ...overrides,
    });
    const badMsgs = checks.filter((c) => c.severity === 'bad').map((c) => c.message);
    results.push({
      name,
      expect: 'block',
      ok: badMsgs.some((m) => m.includes(expectKey)),
      got: badMsgs.length > 0 ? badMsgs.slice(0, 3) : ['（未拦截）'],
    });
  }
  for (const [name, body, overrides] of goodCases) {
    const checks = runDeterministicGuard('Custom velvet pouches', body, {
      policies,
      redlines: activeRedlines,
      signatureText: sig.trim(),
      ...overrides,
    });
    const badMsgs = checks.filter((c) => c.severity === 'bad').map((c) => c.message);
    results.push({
      name,
      expect: 'pass',
      ok: badMsgs.length === 0,
      got: badMsgs.length > 0 ? badMsgs.slice(0, 3) : ['（已放行）'],
    });
  }

  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}
