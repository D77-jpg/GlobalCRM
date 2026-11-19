import type { ProjectApprovedOffer } from '../../models/Project';
import type { KnowledgeReview } from './knowledge-types';

export interface OutreachQualityIssue {
  code:
    | 'word_count'
    | 'paragraph_length'
    | 'readability'
    | 'ai_buzzword'
    | 'cliche'
    | 'intra_repetition'
    | 'cta_friction'
    | 'cta_count'
    | 'bridge_missing'
    | 'unauthorized_offer'
    | 'step3_new_claim';
  severity: 'block' | 'warn';
  message: string;
}

export interface OutreachQualityReport {
  wordCount: number;
  paragraphCount: number;
  maxParagraphWords: number;
  avgSentenceWords: number;
  fleschKincaidGrade: number;
  questionCount: number;
  score: number;
  issues: OutreachQualityIssue[];
}

export interface OutreachMemoryRecord {
  step: number;
  subject: string;
  bodyText: string;
  angleCode?: string;
  savedAlternatives?: { code: string; name: string; angle: string; reason?: string }[];
  usedProofIds?: string[];
  usedProofTexts?: string[];
  usedCtas?: string[];
  usedDeliverables?: string[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'this', 'that', 'these', 'those', 'it',
  'its', 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'i', 'my', 'me', 'just', 'very', 'also',
  'not', 'no', 'so', 'up', 'out', 'about', 'into', 'over', 'after', 'before', 'some', 'any', 'more',
  'hi', 'hello', 'dear', 'thanks', 'thank', 'regards', 'best', 'team',
]);

const SYNONYM_CANONICAL: Record<string, string> = {
  quote: 'pricing', quotes: 'pricing', quotation: 'pricing', price: 'pricing', prices: 'pricing', cost: 'pricing', estimate: 'pricing',
  sample: 'sample', samples: 'sample', prototype: 'sample', mockup: 'sample', swatch: 'swatch', swatches: 'swatch',
  spec: 'spec', specs: 'spec', specification: 'spec', specifications: 'spec', datasheet: 'spec', sheet: 'spec', comparison: 'comparison',
  color: 'color', colour: 'color', colors: 'color', colours: 'color', shade: 'color', match: 'consistency', matching: 'consistency', consistent: 'consistency', consistency: 'consistency',
  delivery: 'leadtime', turnaround: 'leadtime', timeline: 'leadtime', schedule: 'leadtime', lead: 'leadtime',
  backup: 'secondsource', secondary: 'secondsource', alternative: 'secondsource', dual: 'secondsource',
  box: 'packaging', boxes: 'packaging', pouch: 'packaging', pouches: 'packaging', bag: 'packaging', bags: 'packaging', packaging: 'packaging',
  dumbbell: 'weights', dumbbells: 'weights', barbell: 'weights', barbells: 'weights', plate: 'weights', plates: 'weights', kettlebell: 'weights', kettlebells: 'weights',
  painting: 'artwork', paintings: 'artwork', canvas: 'artwork', artwork: 'artwork', portrait: 'artwork', portraits: 'artwork',
  free: 'free', complimentary: 'free', gratis: 'free',
  shipping: 'shipping', freight: 'shipping', courier: 'shipping', postage: 'shipping',
};

const CLICHE_PATTERN = /\b(?:i am reaching out to introduce|we are a leading manufacturer|high quality and competitive pric(?:e|es|ing)|following up on my email of|hope this email finds you well|dear sir\s*\/?\s*madam|to whom it may concern|please do not hesitate to contact|look forward to your early reply)\b/i;

const AI_BUZZWORD_PATTERN = /\b(?:considered|restrained|coherent|deliberate|elevate|worth considering|seamless|seamlessly|synergy|delve|testament|bespoke craftsmanship|unparalleled)\b/gi;

const HEAVY_CTA_PATTERN = /\b(?:full specifications|annual (?:volume|forecast|demand)|target pric(?:e|ing)|detailed requirements|send us your (?:bom|drawings|specs|forecast)|(?:schedule|hop on|jump on|book) a (?:(?:15|20|30|45|60)[\s-]*min(?:ute)?\s+)?(?:zoom\s+|video\s+)?(?:call|meeting|demo))\b/i;

const FREE_PATTERN = /\b(?:free(?![\s-]+weights?)|complimentary|at no (?:cost|charge)|zero cost)\b|免费/i;
const SAMPLE_PATTERN = /\b(?:samples?|swatches?|color cards?|sample kit|physical sample)\b|寄样|色卡|样品|打样/i;
const SHIPPING_PATTERN = /\b(?:shipping|freight|courier|express fee|postage|ddp|cif|fob)\b|运费|包邮|快递费/i;
const DELIVERABLE_PATTERNS: { key: string; category: ProjectApprovedOffer['category']; regex: RegExp }[] = [
  { key: 'spec_sheet', category: 'spec_sheet', regex: /\b(?:spec(?:ification)?\s+sheet|comparison\s+(?:sheet|chart|table)|material\s+(?:guide|reference|chart)|size\s+chart|catalog(?:ue)?)\b|规格对比表|选材参考|参数表/i },
  { key: 'drawing', category: 'drawing', regex: /\b(?:structural\s+(?:drawing|sketch|dieline)|layout\s+sketch|3d\s+mockup|dieline)\b|结构示意|刀版图/i },
  { key: 'swatch', category: 'swatch', regex: /\b(?:color\s+card|swatch(?:es)?|material\s+swatch|fabric\s+card)\b|色卡|面料卡/i },
  { key: 'sample', category: 'sample', regex: /\b(?:send|ship|mail|share|prepare|arrange)\b.{0,35}\b(?:samples?|sample\s+kit)\b|寄样|发样品/i },
  { key: 'quote_range', category: 'quote_range', regex: /\b(?:budget\s+range|ballpark\s+(?:pricing|quote)|indicative\s+pric(?:e|ing))\b|参考价区间/i },
];

export function stripSalutationAndSignoff(bodyText: string): string {
  const lines = bodyText.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  while (lines.length && (!lines[0] || /^(?:hi|hello|dear)\b/i.test(lines[0]))) lines.shift();
  while (lines.length && (!lines[lines.length - 1] || /^(?:best|regards|warm regards|kind regards|thanks|thank you|sincerely|cheers)[,!]?$/i.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

export function splitParagraphs(bodyText: string): string[] {
  return stripSalutationAndSignoff(bodyText)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function countEnglishWords(text: string): number {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches ? matches.length : 0;
}

function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return 0;
  if (clean.length <= 3) return 1;
  const trimmed = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function stemToken(word: string): string {
  const lower = word.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (!lower) return '';
  if (SYNONYM_CANONICAL[lower]) return SYNONYM_CANONICAL[lower];
  const stemmed = lower
    .replace(/(?:ings|ing|edly|ed|ies|es|s|ment|tion|ness|ly)$/i, (suffix) => (lower.length - suffix.length >= 3 ? '' : suffix));
  return SYNONYM_CANONICAL[stemmed] ?? stemmed;
}

export function semanticTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9'-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const stem = stemToken(w);
    if (stem.length >= 3 && !STOPWORDS.has(stem)) tokens.add(stem);
  }
  return tokens;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersect = 0;
  for (const item of a) if (b.has(item)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function extractQuestions(text: string): string[] {
  return [...text.matchAll(/([^.!?\n。！？]+)[?？]/gu)]
    .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter((q) => q.length >= 4);
}

export function extractDeliverables(text: string): { key: string; category: ProjectApprovedOffer['category'] }[] {
  return DELIVERABLE_PATTERNS.filter((d) => d.regex.test(text)).map(({ key, category }) => ({ key, category }));
}

export function verifyOfferAuthorization(
  bodyText: string,
  approvedOffers?: ProjectApprovedOffer[],
  hasKnowledgeEvidence = false,
): OutreachQualityIssue[] {
  const issues: OutreachQualityIssue[] = [];
  const enabledOffers = (approvedOffers ?? []).filter((o) => o.enabled);
  const mentionsFree = FREE_PATTERN.test(bodyText);
  const mentionsSample = SAMPLE_PATTERN.test(bodyText);
  const mentionsShipping = SHIPPING_PATTERN.test(bodyText);
  const deliverables = extractDeliverables(bodyText);

  if (!mentionsFree && !mentionsSample && !mentionsShipping && !deliverables.length) return issues;

  if (mentionsFree) {
    const allowed = enabledOffers.find((o) => o.allowsFree && (!o.requiresEvidence || hasKnowledgeEvidence));
    if (!allowed) {
      issues.push({
        code: 'unauthorized_offer',
        severity: 'block',
        message: '正文包含免费承诺，但项目未授权对应免费小提议或缺少已发布依据',
      });
    }
  }
  if (mentionsSample) {
    const allowed = enabledOffers.find((o) => (o.allowsSample || o.category === 'sample' || o.category === 'swatch') && (!o.requiresEvidence || hasKnowledgeEvidence));
    if (!allowed && (approvedOffers !== undefined || mentionsFree || mentionsShipping)) {
      issues.push({
        code: 'unauthorized_offer',
        severity: 'block',
        message: '正文包含寄样/色卡提议，但项目未逐项授权或条件/依据未满足',
      });
    }
  }
  if (mentionsShipping) {
    const allowed = enabledOffers.find((o) => o.allowsShipping && (!o.requiresEvidence || hasKnowledgeEvidence));
    if (!allowed) {
      issues.push({
        code: 'unauthorized_offer',
        severity: 'block',
        message: '正文涉及运费/快递条件，但项目未授权运费承诺或缺少已发布依据',
      });
    }
  }
  if (approvedOffers && approvedOffers.length > 0) {
    for (const deliv of deliverables) {
      if (deliv.category === 'sample' || deliv.category === 'swatch') continue;
      const matched = enabledOffers.find((o) => o.category === deliv.category && (!o.requiresEvidence || hasKnowledgeEvidence));
      if (!matched) {
        issues.push({
          code: 'unauthorized_offer',
          severity: 'warn',
          message: `正文提议提供「${deliv.key}」，但当前项目授权列表未启用或缺少依据`,
        });
      }
    }
  }
  return issues;
}

export function evaluateOutreachDraftQuality(params: {
  bodyText: string;
  subject?: string;
  step?: number;
  sparseInfo?: boolean;
  review?: KnowledgeReview;
  approvedOffers?: ProjectApprovedOffer[];
  customerHints?: string[];
}): OutreachQualityReport {
  const { bodyText, subject = '', step = 1, sparseInfo = false, review, approvedOffers, customerHints = [] } = params;
  const cleanBody = stripSalutationAndSignoff(bodyText);
  const paragraphs = splitParagraphs(bodyText);
  const wordCount = countEnglishWords(cleanBody);
  const maxParagraphWords = paragraphs.reduce((max, p) => Math.max(max, countEnglishWords(p)), 0);
  const sentences = cleanBody
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => countEnglishWords(s) >= 2);
  const totalWords = Math.max(1, wordCount);
  const sentenceCount = Math.max(1, sentences.length);
  const avgSentenceWords = Number((totalWords / sentenceCount).toFixed(1));
  const words = cleanBody.match(/[A-Za-z]+/g) ?? [];
  const totalSyllables = words.reduce((acc, w) => acc + countSyllables(w), 0);
  const fleschKincaidGrade = words.length > 0
    ? Number((0.39 * (words.length / sentenceCount) + 11.8 * (totalSyllables / words.length) - 15.59).toFixed(1))
    : 0;
  const questions = extractQuestions(cleanBody);
  const issues: OutreachQualityIssue[] = [];

  // 1. Word count limits by step
  if (step === 1) {
    const minHard = sparseInfo ? 20 : 35;
    if (wordCount < minHard) {
      issues.push({ code: 'word_count', severity: 'block', message: `首封正文过短（${wordCount} 词）` });
    } else if (wordCount > 155) {
      issues.push({ code: 'word_count', severity: 'block', message: `首封正文过长（${wordCount} 词，目标 80–120 词）` });
    } else if (!sparseInfo && (wordCount < 65 || wordCount > 130)) {
      issues.push({ code: 'word_count', severity: 'warn', message: `首封字数建议控制在 80–120 词（当前 ${wordCount} 词）` });
    }
  } else if (step === 2) {
    if (wordCount < 18 || wordCount > 105) {
      issues.push({ code: 'word_count', severity: 'block', message: `第 2 封跟进字数超界（${wordCount} 词，建议 35–75 词）` });
    } else if (wordCount > 90) {
      issues.push({ code: 'word_count', severity: 'warn', message: `第 2 封偏长（${wordCount} 词，建议 35–75 词）` });
    }
  } else if (step === 3) {
    if (wordCount < 15 || wordCount > 90) {
      issues.push({ code: 'word_count', severity: 'block', message: `第 3 封结束信字数超界（${wordCount} 词，建议 30–60 词）` });
    }
  }

  // 2. Paragraph length
  if (maxParagraphWords > 68 || (wordCount >= 65 && paragraphs.length === 1)) {
    issues.push({
      code: 'paragraph_length',
      severity: 'block',
      message: `存在过长段落（单段 ${maxParagraphWords} 词，总段数 ${paragraphs.length}），不利于移动端快速浏览`,
    });
  } else if (maxParagraphWords > 52) {
    issues.push({
      code: 'paragraph_length',
      severity: 'warn',
      message: `单段偏长（${maxParagraphWords} 词），建议拆成 1–3 句短段`,
    });
  }

  // 3. Readability & AI buzzwords & clichés
  if (avgSentenceWords > 28 || fleschKincaidGrade > 14.5) {
    issues.push({
      code: 'readability',
      severity: 'block',
      message: `英文句式偏复杂（均句长 ${avgSentenceWords} 词，难度 ${fleschKincaidGrade}），请改写得更口语简洁`,
    });
  } else if (avgSentenceWords > 22 || fleschKincaidGrade > 12.5) {
    issues.push({
      code: 'readability',
      severity: 'warn',
      message: `句式略偏书面（均句长 ${avgSentenceWords} 词）`,
    });
  }

  const buzzwords = [...new Set((cleanBody.match(AI_BUZZWORD_PATTERN) ?? []).map((w) => w.toLowerCase()))];
  if (buzzwords.length >= 2) {
    issues.push({ code: 'ai_buzzword', severity: 'block', message: `正文含过多 AI 高频词（${buzzwords.join('、')}）` });
  } else if (buzzwords.length === 1) {
    issues.push({ code: 'ai_buzzword', severity: 'warn', message: `正文含 AI 高频词（${buzzwords[0]}）` });
  }

  if (CLICHE_PATTERN.test(cleanBody) || CLICHE_PATTERN.test(subject)) {
    issues.push({ code: 'cliche', severity: 'block', message: '正文或主题仍包含生硬的群发套话' });
  }

  // 4. Intra-draft synonym/semantic repetition across paragraphs
  if (paragraphs.length >= 2) {
    const paraTokens = paragraphs.map(semanticTokens);
    for (let i = 0; i < paraTokens.length; i++) {
      for (let j = i + 1; j < paraTokens.length; j++) {
        if (paraTokens[i].size >= 4 && paraTokens[j].size >= 4 && jaccardSimilarity(paraTokens[i], paraTokens[j]) >= 0.52) {
          issues.push({ code: 'intra_repetition', severity: 'block', message: '正文不同段落存在同义重复表述' });
          break;
        }
      }
    }
  }

  // 5. CTA count & reply ease
  if (step < 3) {
    if (questions.length !== 1) {
      issues.push({ code: 'cta_count', severity: 'block', message: '本封开发信应保留一个明确的回复问题' });
    } else {
      const qWords = countEnglishWords(questions[0]);
      if (qWords > 30 || HEAVY_CTA_PATTERN.test(questions[0])) {
        issues.push({ code: 'cta_friction', severity: 'block', message: '结尾 CTA 提问负担过重，客户难以在几秒内回复' });
      }
    }
  }

  // 6. Capability-to-buyer bridge (Step 1)
  if (step === 1 && paragraphs.length >= 2) {
    const hasBuyerReference = /\b(?:your|you)\b/i.test(cleanBody)
      || customerHints.some((hint) => hint.length >= 3 && cleanBody.toLowerCase().includes(hint.toLowerCase()));
    const hasSupplierReference = /\b(?:we|our)\b/i.test(cleanBody);
    const para2HasLink = /\b(?:for|so|help|keep|support|match|across|your|you|without|avoid|consistent|same)\b/i.test(paragraphs[1] ?? '');
    if (!hasBuyerReference || !hasSupplierReference || !para2HasLink) {
      issues.push({
        code: 'bridge_missing',
        severity: 'warn',
        message: '「我方能做什么」与「客户为什么可能在意」之间缺少自然衔接',
      });
    }
  }

  // 7. Step 3 must not introduce new supported factual claims
  if (step === 3 && review?.factAudit?.checks?.some((c) => c.status === 'supported')) {
    issues.push({
      code: 'step3_new_claim',
      severity: 'warn',
      message: '第 3 封结束信不应新增新的事实主张或产品承诺',
    });
  }

  // 8. Per-item offer authorization check
  const hasKnowledgeEvidence = Boolean(
    review?.claims?.some((claim) => claim.sourceIds.some((id) => review.sources.some((s) => s.sourceId === id && s.kind === 'knowledge'))),
  );
  issues.push(...verifyOfferAuthorization(cleanBody, approvedOffers, hasKnowledgeEvidence));

  const penalty = issues.reduce((sum, item) => sum + (item.severity === 'block' ? 22 : 7), 0);
  const score = Math.max(0, 100 - penalty);

  return {
    wordCount,
    paragraphCount: paragraphs.length,
    maxParagraphWords,
    avgSentenceWords,
    fleschKincaidGrade,
    questionCount: questions.length,
    score,
    issues,
  };
}

/**
 * Cross-email strict deduplication for Steps 2 & 3:
 * checks exact reuse, synonym/paraphrase reuse, proof-ID reuse, CTA intent overlap,
 * and Step-2 deliverable authorization/evidence grounding.
 */
export function detectCrossEmailRepetition(params: {
  bodyText: string;
  step?: number;
  review?: KnowledgeReview;
  previous: OutreachMemoryRecord[];
  approvedOffers?: ProjectApprovedOffer[];
}): string | undefined {
  const { bodyText, step = 2, review, previous, approvedOffers } = params;
  if (!previous.length) return undefined;

  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const sentences = (text: string) => stripSalutationAndSignoff(text)
    .split(/[.!?。！？\n]/u)
    .map(normalize)
    .filter((line) => line.split(' ').length >= 5);

  const prevBodies = previous.map((p) => p.bodyText);
  const prevSentences = new Set(prevBodies.flatMap(sentences));
  const prevSentenceTokenSets = prevBodies.flatMap(sentences).map(semanticTokens).filter((s) => s.size >= 4);

  // 1. Exact proof sentence repetition
  const proofSentences = (review?.claims ?? []).flatMap((c) => sentences(c.text));
  if (proofSentences.length && proofSentences.every((s) => prevSentences.has(s))) {
    return '跟进内容重复了前一封的证明点';
  }

  // 2. Structured proof-ID repetition (if step 2 uses the exact same knowledge source/claim ID without adding a new one)
  if (step === 2 && review?.claims?.length) {
    const prevProofIds = new Set(previous.flatMap((p) => p.usedProofIds ?? []));
    const currentProofIds = [...new Set(review.claims.flatMap((c) => c.sourceIds).filter((id) => id.startsWith('knowledge:')))];
    if (prevProofIds.size > 0 && currentProofIds.length > 0 && currentProofIds.every((id) => prevProofIds.has(id))) {
      // Allow only if the actual proof text is semantically distinct (a different fact from the same doc)
      const prevProofTokenSets = previous.flatMap((p) => p.usedProofTexts ?? []).map(semanticTokens).filter((s) => s.size >= 3);
      const currentProofTokenSets = review.claims.map((c) => semanticTokens(c.text)).filter((s) => s.size >= 3);
      if (
        prevProofTokenSets.length > 0
        && currentProofTokenSets.length > 0
        && currentProofTokenSets.every((cur) => prevProofTokenSets.some((prev) => jaccardSimilarity(cur, prev) >= 0.48))
      ) {
        return '跟进内容换词重说了上一封已使用过的同一证明点';
      }
    }
  }

  // 3. Paraphrase / synonym rephrasing across sentences (excluding standard step-2 lead-in)
  const currentSentences = sentences(bodyText).filter((s) => !/^(?:just |quick )?following up\b|wanted to follow up\b/i.test(s));
  let paraphrasedCount = 0;
  for (const s of currentSentences) {
    if (prevSentences.has(s)) {
      paraphrasedCount++;
      continue;
    }
    const curTokens = semanticTokens(s);
    if (curTokens.size >= 4 && prevSentenceTokenSets.some((prev) => jaccardSimilarity(curTokens, prev) >= 0.56)) {
      paraphrasedCount++;
    }
  }
  if (currentSentences.length >= 2 && paraphrasedCount / currentSentences.length >= 0.6) {
    return '跟进正文与前一封存在大面积换词重说';
  }

  // 4. Exact or paraphrased CTA question reuse
  const prevQuestions = [
    ...prevBodies.flatMap(extractQuestions),
    ...previous.flatMap((p) => p.usedCtas ?? []),
  ];
  const prevQuestionNorm = new Set(prevQuestions.map(normalize));
  const prevQuestionTokens = prevQuestions.map(semanticTokens).filter((s) => s.size >= 3);
  const currentQuestions = extractQuestions(bodyText);
  for (const q of currentQuestions) {
    const norm = normalize(q);
    if (prevQuestionNorm.has(norm)) return '跟进内容重复了之前的提问';
    const qTokens = semanticTokens(q);
    if (qTokens.size >= 3 && prevQuestionTokens.some((prev) => jaccardSimilarity(qTokens, prev) >= 0.55)) {
      return '跟进结尾提问与上一封 CTA 同义重复';
    }
  }

  // 5. Step 2 deliverable check: must not repeat previously offered deliverable, and offered deliverable needs grounding
  if (step === 2) {
    const currentDeliverables = extractDeliverables(bodyText);
    const prevDeliverables = new Set(previous.flatMap((p) => p.usedDeliverables ?? extractDeliverables(p.bodyText).map((d) => d.key)));
    const repeatedDeliv = currentDeliverables.find((d) => prevDeliverables.has(d.key));
    if (repeatedDeliv) {
      return '第 2 封重复提议了上一封已提过的同类资料';
    }
    if (currentDeliverables.length > 0 && review) {
      const hasKnowledge = review.sources.some((s) => s.kind === 'knowledge');
      const offerIssues = verifyOfferAuthorization(bodyText, approvedOffers, hasKnowledge);
      const blockingOffer = offerIssues.find((i) => i.severity === 'block');
      if (blockingOffer) return blockingOffer.message;
      if (!hasKnowledge && !(approvedOffers ?? []).some((o) => o.enabled && currentDeliverables.some((d) => d.category === o.category))) {
        return '第 2 封提议提供的对比表或选材参考缺少项目依据或授权';
      }
    }
  }

  return undefined;
}
