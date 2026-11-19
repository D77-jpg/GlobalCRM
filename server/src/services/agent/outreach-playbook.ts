import { GENESIS_PLAYBOOK, type PlaybookCardData } from './genesis-playbook.data';
import { IRONHUE_PLAYBOOK } from './ironhue-playbook.data';
import { VELATURO_PLAYBOOK } from './velaturo-playbook.data';
import type { ProjectIndustryRule } from '../../models/Project';
import type { OutreachPlaybookAlternative, OutreachPlaybookContext } from '../project-profile';

export interface PlaybookCustomsSignals {
  purchaseScale?: 'high' | 'medium' | 'small';
  shipmentCount?: number;
  importedCategories?: string[];
  importedMaterials?: string[];
  seasonalPeakMonths?: number[];
  upcomingRestockWindow?: boolean;
  supplierConcentration?: 'single_source' | 'concentrated' | 'diversified';
  topSupplierShare?: number;
  confidence?: 'high' | 'medium' | 'low';
  stale?: boolean;
}

export interface PlaybookWebsiteStructured {
  productLines?: string[];
  materials?: string[];
  priceTier?: 'budget' | 'mid' | 'premium' | 'luxury';
  brandPositioning?: string;
}

/**
 * Select a project-scoped sales playbook card before drafting.
 * Card text is strategy and must never be added to the fact evidence bundle.
 */
export interface PlaybookSelectionInput {
  projectKey: string;
  taskType?: string;
  outreachStep?: number;
  industry?: string;
  interestedProducts?: string;
  productCategory?: string;
  websiteText?: string;
  contactRole?: string;
  usedAngles?: string[];
  /** Step-1 persisted alternative angles to carry forward directly into Step 2. */
  savedAlternatives?: OutreachPlaybookAlternative[];
  /** Explicit segment override (for dual-angle drafting or manual angle rewrite). */
  forcedSegmentCode?: string;
  /** Project-maintained industry gating/matching rules (works for any industry). */
  industryRules?: ProjectIndustryRule[];
  /** Verified customs procurement signals (scale, materials, seasonality, concentration). */
  customsSignals?: PlaybookCustomsSignals;
  /** Structured product/material/price-band signals from website JSON-LD/Shopify. */
  websiteStructured?: PlaybookWebsiteStructured;
  /** Project-managed cards imported through the knowledge workspace. */
  cards?: { segments: PlaybookCardData[]; preferences: PlaybookCardData[]; revision?: number };
}

function contactRole(title?: string): OutreachPlaybookContext['contactRole'] {
  if (/\b(?:buyer|procurement|sourcing|purchasing|operations|supply chain)\b|采购|供应链|运营/i.test(title ?? '')) return 'procurement';
  if (/\b(?:founder|owner|brand|creative|merchandising)\b|创始人|品牌|设计/i.test(title ?? '')) return 'brand';
  return undefined;
}

const GENERIC_TERMS = new Set([
  'brand', 'brands', 'product', 'products', 'packaging', 'package', 'pouch', 'pouches', 'box', 'boxes',
  'customer', 'customers', 'supplier', 'suppliers', 'company', 'business', 'retail', 'wholesale',
  'design', 'designer', 'collection', 'collections', 'quality', 'premium', 'luxury', 'gift', 'gifts',
  'boutique', 'shop', 'store', 'spa', 'resort', 'hotel', 'program', 'range', 'line', 'new',
  '品牌', '产品', '包装', '客户', '供应商', '公司', '设计', '系列', '品质', '礼品', '高端', '轻奢',
]);

// Legacy fallback category gates for built-in Genesis cards when project has no custom industryRules.
const REQUIRED_SIGNALS: Record<string, RegExp> = {
  I01: /jewel|necklace|earring|ring|bracelet|pendant|珠宝|首饰/i,
  I02: /candle|蜡烛/i,
  I03: /perfume|fragrance|香水|香氛/i,
  I04: /skincare|skin care|body care|beauty|护肤|身体护理|美妆/i,
  I05: /handmade|artisan|atelier|jewel|珠宝|手作|工坊/i,
  I06: /leather|handbag|皮具|手袋/i,
  I07: /watch|腕表|手表/i,
  I08: /wedding ring|bridal|diamond|婚戒|钻石|高级珠宝/i,
  I09: /scarf|silk tie|necktie|围巾|丝巾|领带/i,
  I10: /jewel|珠宝|multi[- ]?store|chain|连锁/i,
  I11: /makeup brush|beauty tool|美妆|刷具/i,
  I12: /soap|沐浴|天然皂/i,
  I13: /perfume|travel spray|试香|旅行装/i,
  I14: /hair accessory|hair tie|发饰|发圈|头饰/i,
  I15: /eyewear|sunglasses|眼镜|太阳镜/i,
  I16: /sleepwear|lingerie|睡衣|内衣|家居服/i,
  I17: /aromatherapy|essential oil|芳疗|精油/i,
  I18: /wallet|card holder|belt|钱包|卡包|皮带/i,
  I19: /shoe|footwear|bridal|鞋履|婚鞋/i,
  I20: /diffuser|home fragrance|香薰|扩香/i,
  I21: /subscription|礼盒|订阅/i,
  I22: /tea|coffee|茶|咖啡/i,
  I23: /chocolate|candy|bakery|巧克力|糖果|烘焙/i,
  I24: /wine|spirits|葡萄酒|烈酒/i,
  I25: /stationery|notebook|pen|文具|钢笔|手账/i,
  I26: /wedding|event|伴手礼|婚礼|活动/i,
  I27: /ceramic|glass|homeware|陶瓷|玻璃|家居/i,
  I28: /crystal|mineral|spiritual|水晶|矿石|灵性/i,
  I29: /electronic|audio|tech|电子|音频|科技/i,
  I30: /grooming|beard|理容|胡须/i,
  I31: /pet|宠物/i,
  I32: /museum|gallery|design gift|博物馆|美术馆|设计礼品/i,
  I33: /hotel|resort|hospitality|酒店|度假/i,
  I34: /bedding|textile|towel|家纺|床品|毛巾/i,
  I35: /golf|sport|高尔夫|运动/i,
  I36: /handcraft|souvenir|personalized|手工艺|纪念品|个性化/i,
  I37: /beauty salon|clinic|美容院|医美/i,
  I38: /coin|medal|collectible|纪念币|奖章|收藏/i,
  I39: /baby|kid|婴童/i,
  I40: /promotional|low[- ]?cost|促销|赠品/i,
};

function safeRegex(pattern?: string): RegExp | undefined {
  if (!pattern || pattern.length > 300) return undefined;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

function terms(value: string): string[] {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const result: string[] = [];
  for (const part of text.split(/[^a-z0-9\u4e00-\u9fff-]+/u)) {
    for (const match of part.matchAll(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
      const term = match[0].replace(/^-+|-+$/g, '');
      if (term.length >= 2 && !GENERIC_TERMS.has(term)) result.push(term);
    }
  }
  return result;
}

interface ScoredCard {
  card: PlaybookCardData;
  score: number;
  matchedClues: string[];
}

function scoreCardWithClues(
  card: PlaybookCardData,
  haystack: string,
  customRule?: ProjectIndustryRule,
  customsHaystack = '',
  structuredHaystack = '',
): ScoredCard {
  let score = 0;
  const clues = new Set<string>();
  const fields: [keyof Pick<PlaybookCardData, 'name' | 'signals' | 'products' | 'logic'>, number][] = [
    ['name', 2], ['signals', 2], ['products', 3], ['logic', 1],
  ];
  for (const [field, weight] of fields) {
    for (const term of new Set(terms(card[field]))) {
      if (haystack.includes(term)) {
        score += weight;
        if (clues.size < 6) clues.add(term);
      }
      if (structuredHaystack && structuredHaystack.includes(term)) {
        score += 1;
        if (clues.size < 6) clues.add(`官网结构化:${term}`);
      }
      if (customsHaystack && customsHaystack.includes(term)) {
        score += 2;
        if (clues.size < 6) clues.add(`海关进口:${term}`);
      }
    }
  }
  for (const term of card.keywords ?? []) {
    const low = term.toLowerCase();
    if (low.length >= 3 && haystack.includes(low)) {
      score += 3;
      clues.add(term);
    }
  }
  for (const phrase of `${card.products} ${card.signals}`.split(/[、,，/／|｜;；]+/)) {
    const value = phrase.trim().toLowerCase();
    if (value.length >= 3 && value.length <= 40 && haystack.includes(value)) {
      score += 2;
      if (clues.size < 6) clues.add(phrase.trim());
    }
  }
  if (customRule) {
    for (const kw of customRule.keywords ?? []) {
      if (kw.length >= 2 && haystack.includes(kw.toLowerCase())) {
        score += 3;
        clues.add(`项目规则:${kw}`);
      }
    }
    if (customRule.priority) score += Math.max(-5, Math.min(5, customRule.priority));
  }
  return { card, score, matchedClues: [...clues].slice(0, 5) };
}

function choosePreference(haystack: string, customs?: PlaybookCustomsSignals): PlaybookCardData | undefined {
  const id =
    customs?.supplierConcentration === 'single_source'
    || /existing supplier|current supplier|already (?:have|work|source)|incumbent|现有供应商|已有供应商|现有包装|稳定供应/i.test(haystack)
      ? 'P07'
      : /new collection|new product|new brand|launch|new range|新品|新系列|上市/i.test(haystack)
        ? 'P04'
        : /sustainab|eco[- ]?friendly|recycl|环保|可持续/i.test(haystack)
          ? 'P06'
          : customs?.purchaseScale === 'high' || /multi[- ]?sku|wholesale|distributor|price|catalog|多个|系列|批发|经销/i.test(haystack)
            ? 'P02'
            : /chain|multi[- ]?store|retailer|连锁|门店/i.test(haystack)
              ? 'P05'
              : 'P01';
  return GENESIS_PLAYBOOK.preferences.find((card) => card.id === id);
}

function chooseIronhuePreference(haystack: string, customs?: PlaybookCustomsSignals): PlaybookCardData | undefined {
  const id =
    customs?.supplierConcentration === 'single_source'
    || /existing supplier|current supplier|already (?:have|work|source)|incumbent|现有供应商|已有供应商|稳定供应/i.test(haystack) ? 'IHP07'
      : /new (?:line|product|brand)|launch|first order|新品|新线|首单/i.test(haystack) ? 'IHP04'
        : /price|budget|cost|margin|毛利|预算|价格/i.test(haystack) ? 'IHP02'
          : /tender|test|standard|certif|文件|认证|测试|准入/i.test(haystack) ? 'IHP06'
            : customs?.purchaseScale === 'high' || /multi|chain|distributor|wholesale|连锁|批发|多店/i.test(haystack) ? 'IHP05'
              : 'IHP01';
  return IRONHUE_PLAYBOOK.preferences.find((card) => card.id === id);
}

function chooseVelaturoPreference(haystack: string, customs?: PlaybookCustomsSignals): PlaybookCardData | undefined {
  const id =
    customs?.supplierConcentration === 'single_source'
    || /existing supplier|current supplier|already (?:have|work|source)|incumbent|现有供应商|已有供应商|稳定供应/i.test(haystack) ? 'VAP07'
      : customs?.upcomingRestockWindow || /deadline|opening|launch date|project date|开业|节点|日期/i.test(haystack) ? 'VAP03'
        : /trial|test|sample|small batch|试款|样品/i.test(haystack) ? 'VAP04'
          : /material|frame|flame|clean|材料|画框|阻燃|清洁/i.test(haystack) ? 'VAP06'
            : /price|budget|cost|预算|价格/i.test(haystack) ? 'VAP02'
              : 'VAP01';
  return VELATURO_PLAYBOOK.preferences.find((card) => card.id === id);
}

const PLAYBOOKS: Record<string, { segments: PlaybookCardData[]; preferences: PlaybookCardData[] }> = {
  genesis: GENESIS_PLAYBOOK,
  ironhue: IRONHUE_PLAYBOOK,
  velaturo: VELATURO_PLAYBOOK,
};

/** Read-only built-in cards for the admin inspector; selection remains project-aware. */
export function getBuiltinPlaybook(projectKey: string) {
  return PLAYBOOKS[projectKey.toLowerCase()];
}

const PROJECT_GATES: Record<string, RegExp> = {
  ironhue: /fitness|gym|dumbbell|barbell|kettlebell|weight|strength|training|workout|健身|哑铃|杠铃|壶铃|力量|训练/i,
  velaturo: /wall art|painting|canvas|portrait|art gallery|art consultant|home decor|艺术|画作|油画|丙烯|墙面|肖像|画廊|装饰画/i,
};

const PREFERENCE_CHOOSERS: Record<string, (haystack: string, customs?: PlaybookCustomsSignals) => PlaybookCardData | undefined> = {
  genesis: choosePreference,
  ironhue: chooseIronhuePreference,
  velaturo: chooseVelaturoPreference,
};

function buildConcreteSelectionReason(
  top: ScoredCard,
  runnerUp: ScoredCard | undefined,
  role: OutreachPlaybookContext['contactRole'],
  customs?: PlaybookCustomsSignals,
): string {
  const clueText = top.matchedClues.length
    ? `命中客户线索「${top.matchedClues.slice(0, 3).join(' / ')}」`
    : '匹配当前客户品类特征';
  const roleText = role === 'procurement'
    ? '；联系人偏采购/供应链角色，优先突出规格、一致性与稳定供货'
    : role === 'brand'
      ? '；联系人偏品牌/创始人角色，优先突出产品呈现与客户体验'
      : '';
  const customsText = customs && !customs.stale && customs.confidence !== 'low'
    ? [
      customs.supplierConcentration === 'single_source' ? '海关显示供应商集中度高（适合二供/备份切入）' : '',
      customs.upcomingRestockWindow ? '海关显示临近季节性补货窗口' : '',
      customs.purchaseScale === 'high' ? '海关显示采购规模较大' : '',
    ].filter(Boolean).join('、')
    : '';
  const compareText = runnerUp
    ? `；暂不选「${runnerUp.card.name}」（得分 ${runnerUp.score} < ${top.score}${runnerUp.matchedClues.length ? `，线索「${runnerUp.matchedClues.slice(0, 2).join(' / ')}」支撑相对较弱` : '，直接业务线索不足'}），留作后续跟进备选`
    : '';
  return `选用「${top.card.name}」：${clueText}${customsText ? `；${customsText}` : ''}${roleText}${compareText}。`;
}

export function selectOutreachPlaybook(input: PlaybookSelectionInput): OutreachPlaybookContext | undefined {
  const projectKey = input.projectKey.toLowerCase();
  const playbook = input.cards ?? PLAYBOOKS[projectKey];
  if (!playbook) return undefined;
  if (input.taskType && input.taskType !== 'first_outreach' && input.outreachStep === undefined) return undefined;

  const customsUsable = input.customsSignals && !input.customsSignals.stale && input.customsSignals.confidence !== 'low'
    ? input.customsSignals
    : undefined;
  const customsHaystack = customsUsable
    ? [...(customsUsable.importedCategories ?? []), ...(customsUsable.importedMaterials ?? [])].join(' ').normalize('NFKC').toLowerCase()
    : '';
  const structuredHaystack = input.websiteStructured
    ? [
      ...(input.websiteStructured.productLines ?? []),
      ...(input.websiteStructured.materials ?? []),
      input.websiteStructured.brandPositioning ?? '',
    ].join(' ').normalize('NFKC').toLowerCase()
    : '';

  const haystack = [
    input.industry,
    input.interestedProducts,
    input.productCategory,
    input.websiteText,
    structuredHaystack,
    customsHaystack,
  ].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
  if (!haystack.trim()) return undefined;

  const rulesByCode = new Map((input.industryRules ?? []).map((r) => [r.code, r]));
  const gate = (input.cards || input.industryRules?.length) ? undefined : PROJECT_GATES[projectKey];
  if (gate && !gate.test(haystack)) return undefined;

  const ranked = playbook.segments
    .filter((card) => {
      const rule = rulesByCode.get(card.id);
      if (rule) {
        const req = safeRegex(rule.requiredPattern);
        const exc = safeRegex(rule.excludedPattern);
        if (req && !req.test(haystack)) return false;
        if (exc && exc.test(haystack)) return false;
        return true;
      }
      return Boolean(input.cards) || projectKey !== 'genesis' || !REQUIRED_SIGNALS[card.id] || REQUIRED_SIGNALS[card.id].test(haystack);
    })
    .map((card) => scoreCardWithClues(card, haystack, rulesByCode.get(card.id), customsHaystack, structuredHaystack))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));

  const unused = ranked.filter(({ card }) => !input.usedAngles?.includes(card.id));

  let top: ScoredCard | undefined;
  if (input.forcedSegmentCode) {
    const forced = ranked.find((item) => item.card.id === input.forcedSegmentCode);
    if (forced) {
      top = forced;
    } else {
      const card = playbook.segments.find((c) => c.id === input.forcedSegmentCode);
      if (card) top = scoreCardWithClues(card, haystack, rulesByCode.get(card.id), customsHaystack, structuredHaystack);
    }
  } else if (input.outreachStep === 2) {
    // Directly reuse Step 1's persisted alternative list when still unused and valid.
    const carried = (input.savedAlternatives ?? [])
      .filter((alt) => !input.usedAngles?.includes(alt.code))
      .map((alt) => {
        const found = ranked.find((item) => item.card.id === alt.code);
        if (found) return found;
        const card = playbook.segments.find((c) => c.id === alt.code);
        return card ? scoreCardWithClues(card, haystack, rulesByCode.get(card.id), customsHaystack, structuredHaystack) : undefined;
      })
      .find((item): item is ScoredCard => Boolean(item));
    top = carried ?? unused[0] ?? ranked[0];
  } else {
    top = ranked[0];
  }

  if (!top) return undefined;

  const role = contactRole(input.contactRole);
  const roleTerms = role === 'brand'
    ? /品牌|体验|陈列|搭配|brand|presentation|experience/i
    : role === 'procurement'
      ? /采购|二供|批次|一致|规格|补货|sourcing|consistency|specification/i
      : undefined;

  const customsPrefTerms = customsUsable?.supplierConcentration === 'single_source'
    ? /现有供应商|二供|备份|existing supplier|backup|incumbent/i
    : customsUsable?.upcomingRestockWindow
      ? /交期|补货|节点|opening|deadline|lead/i
      : customsUsable?.purchaseScale === 'high'
        ? /批发|多店|系列|wholesale|multi|chain/i
        : undefined;

  const options = playbook.preferences
    .map((card) => {
      const scored = scoreCardWithClues(card, haystack);
      let bonus = 0;
      if (roleTerms?.test(`${card.name} ${card.signals} ${card.logic}`)) bonus += 3;
      if (customsPrefTerms?.test(`${card.name} ${card.signals} ${card.logic}`)) bonus += 4;
      return { card, score: scored.score + bonus };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));

  const preference = (role || input.cards || customsPrefTerms ? options[0]?.card : undefined)
    ?? PREFERENCE_CHOOSERS[projectKey]?.(haystack, customsUsable);

  const runnerUps = unused.filter(({ card }) => card.id !== top!.card.id).slice(0, 2);
  const alternatives: OutreachPlaybookAlternative[] = runnerUps.map((entry) => ({
    code: entry.card.id,
    name: entry.card.name,
    angle: entry.card.logic,
    score: entry.score,
    matchedClues: entry.matchedClues,
    reason: entry.matchedClues.length
      ? `匹配线索「${entry.matchedClues.slice(0, 2).join(' / ')}」，相关性得分 ${entry.score}（低于主卡 ${top!.score}），暂留作第 2 封或换角度备选`
      : `与客户存在间接相关性（得分 ${entry.score} < ${top!.score}），暂不作为首封主线`,
  }));

  return {
    segmentCode: top.card.id,
    segmentName: top.card.name,
    signals: top.card.signals,
    products: top.card.products,
    logic: top.card.logic,
    avoid: top.card.avoid,
    cta: top.card.cta,
    prepare: top.card.prepare,
    check: top.card.check,
    subjects: top.card.subjects.slice(0, 3),
    selectionReason: buildConcreteSelectionReason(top, runnerUps[0], role, customsUsable),
    matchedClues: top.matchedClues,
    ...(input.cards?.revision === undefined ? {} : { revision: input.cards.revision }),
    ...(role ? { contactRole: role } : {}),
    ...(alternatives.length ? { alternatives } : {}),
    ...(preference ? {
      preferenceCode: preference.id,
      preferenceName: preference.name,
      preferenceLogic: preference.logic,
      preferenceCta: preference.cta,
    } : {}),
    confidence: top.score >= 7 ? 'high' : 'medium',
  };
}
