import type { ProjectApprovedProofBlock } from '../../models/Project';
import type { ClaimCheck, KnowledgeBundle, KnowledgeSource } from './knowledge-types';
import type { CustomerCheckContext, EvidenceQuote } from './fact-verifier';

/**
 * Red-tier commercial / numeric commitments: NEVER relaxed in any outreach tier.
 * Mirrors the exact hard policy boundary in fact-verifier.ts.
 */
export const RED_TIER_POLICY_RE =
  /\b(?:moq|minimum\s+order|minimum|price|pricing|payment|cost|discount|freight|ship(?:ping|s|ped|ment)?|lead[ -]?time|deliver\w*|certif\w*|fsc|iso|bsci|free(?![\s-]+weights?)|capacity|guarantee\w*|warrant\w*|exclusive|stock|inventory|refund|replace|reserve|hold|sample|offer|deal|contract|legal)\b|起订|价格|报价|费用|运费|付款|定金|交期|认证|证书|免费|保证|质保|产能|库存|现货|备货|样品|折扣|退款|独家|合同|法律|承诺/i;

export const SUPPLIER_VOICE_RE =
  /\b(?:we|our|us)\b|\bi\s+(?:can|will|offer|supply|provide|guarantee|manufacture|produce|make)\b|我们|我方|我司/i;

export const CUSTOMER_INTENT_INFERENCE_RE =
  /\b(?:you\s+(?:need|require|want|plan|intend|are\s+(?:looking|planning|seeking|buying|sourcing))|your\s+(?:procurement|purchasing|sourcing)\s+(?:needs?|plans?|intentions?))\b|贵司(?:需要|计划|正在采购)|您的采购(?:需求|计划)/i;

const NEGATIVE_RE =
  /\b(?:not|never|no|cannot|can't|without|except|unless)\b|不支持|不可|不能|不提供|未认证|未经|除外|除非/i;

export function isRedTierClaim(text: string): boolean {
  const nfkc = text.normalize('NFKC');
  return /\d/.test(nfkc) || RED_TIER_POLICY_RE.test(nfkc);
}

export function normalizeBlockKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'our', 'their', 'about',
  'into', 'over', 'under', 'across', 'around', 'through', 'during', 'before', 'after',
  'when', 'where', 'which', 'while', 'what', 'whose', 'have', 'has', 'had', 'were',
  'been', 'being', 'will', 'would', 'could', 'should', 'might', 'must', 'also', 'just',
  'only', 'very', 'more', 'most', 'some', 'such', 'than', 'then', 'they', 'them', 'these',
  'those', 'there', 'here', 'each', 'both', 'many', 'much', 'well', 'good', 'great',
  'website', 'site', 'page', 'online', 'store', 'shop', 'brand', 'company', 'team',
  'noticed', 'came', 'saw', 'liked', 'loved', 'shows', 'lists', 'carries', 'features',
  'products', 'product', 'items', 'line', 'lines', 'range', 'collection', 'catalog',
]);

function contentTokens(text: string): string[] {
  const raw = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(raw.filter((tok) => !STOPWORDS.has(tok)))];
}

function tokenStemMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    if (a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a) return true;
    if (a.endsWith('ing') && a.slice(0, -3) === b) return true;
    if (b.endsWith('ing') && b.slice(0, -3) === a) return true;
  }
  return false;
}

/**
 * Industry-agnostic general category observation (Green Tier):
 * Replaces the legacy Genesis-only packaging regex so IRONHUE, VELATURO, and any
 * other B2B industry can include one natural category insight without inventing facts.
 * Strictly forbids digits, red-tier commitment words, supplier voice, and customer pronouns.
 */
export function isGeneralCategoryInsight(text: string): boolean {
  const value = text.trim();
  if (value.length < 18 || value.length > 280) return false;
  if (isRedTierClaim(value)) return false;
  if (/^(?:i|noticed|came across|liked|loved|saw)\b/i.test(value)) return false;
  if (/\b(?:you|your|yours|we|our|ours|us|i|my|mine)\b|你们|您|贵司|贵公司|我们|我方|我司/i.test(value)) return false;
  if (/unbox|packag|gift|presentation|first impression|arriv/i.test(value)) return true;
  if (/^(?:when|if|as|for)\b[^.!?]{6,230}\b(?:can|may|could|often|usually|tend|matter|helps?|keeps?)\b[^.!?]{3,160}[.!?]?$/i.test(value)) {
    return true;
  }
  return /\b(?:often|usually|typically|tend to|matters?|consistency|durability|finish|tolerance|restock\w*|scaling|commercial|retail|private[- ]label|operators?|buyers?|studios?|gyms?|brands?|distributors?|suppliers?)\b/i.test(value);
}

/**
 * Yellow-Tier deterministic customer opener check:
 * Verifies a non-red-tier, customer-attributed observation directly against the
 * customer's authorized website snapshots or CRM profile, returning exact Unicode offsets.
 */
export function matchDeterministicCustomerOpener(
  text: string,
  customer?: CustomerCheckContext,
): EvidenceQuote | undefined {
  if (!customer) return undefined;
  if (isRedTierClaim(text)) return undefined;
  if (SUPPLIER_VOICE_RE.test(text)) return undefined;
  if (CUSTOMER_INTENT_INFERENCE_RE.test(text)) return undefined;
  const hasAttribution =
    /\b(?:your|you|website|site)\b|贵司|贵公司|您/i.test(text)
    || /^(?:i\s+(?:noticed|saw|came across|liked|loved)|noticed|came across|liked|loved)\b/i.test(text.trim());
  if (!hasAttribution) return undefined;

  const sources: { sourceId: string; text: string }[] = [];
  for (const site of customer.websites ?? []) {
    if (site.sourceId.startsWith('website:') && site.text.trim()) {
      sources.push({ sourceId: site.sourceId, text: site.text });
    }
  }
  const profileText = JSON.stringify(customer.profile);
  if (profileText) sources.push({ sourceId: 'profile:' + customer.id, text: profileText });
  if (!sources.length) return undefined;

  // Prefer multi-word entity phrases or distinctive >=4-char tokens from the opener
  const tokens = contentTokens(text).filter((t) => t.length >= 4);
  if (!tokens.length) return undefined;

  // 1. Check 2-3 word contiguous phrases first (highest precision, e.g., "bumper plates", "velvet pouch")
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const candidatePhrases: string[] = [];
  for (let len = 3; len >= 2; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const slice = words.slice(i, i + len);
      if (slice.some((w) => !STOPWORDS.has(w.toLowerCase()) && w.length >= 4)) {
        candidatePhrases.push(slice.join(' '));
      }
    }
  }

  for (const src of sources) {
    const lowerSrc = src.text.toLowerCase();
    for (const phrase of candidatePhrases) {
      const idx = lowerSrc.indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        const start = Array.from(src.text.slice(0, idx)).length;
        const original = src.text.slice(idx, idx + phrase.length);
        const end = start + Array.from(original).length;
        if (NEGATIVE_RE.test(text) !== NEGATIVE_RE.test(original)) continue;
        return { sourceId: src.sourceId, quote: original, start, end };
      }
    }
  }

  // 2. Fallback: require >=2 distinct content tokens appearing within a 140-char span in the same source
  //    or 1 distinctive >=6-char product/company token matching literally.
  for (const src of sources) {
    const lowerSrc = src.text.toLowerCase();
    const hits = tokens
      .map((tok) => ({ tok, idx: lowerSrc.indexOf(tok) }))
      .filter((h) => h.idx >= 0)
      .sort((a, b) => a.idx - b.idx);

    if (hits.length >= 2) {
      for (let i = 0; i < hits.length - 1; i++) {
        const spanEnd = hits[i + 1]!.idx + hits[i + 1]!.tok.length;
        if (spanEnd - hits[i]!.idx <= 140) {
          const rawStart = hits[i]!.idx;
          const original = src.text.slice(rawStart, spanEnd);
          const start = Array.from(src.text.slice(0, rawStart)).length;
          const end = start + Array.from(original).length;
          if (NEGATIVE_RE.test(text) !== NEGATIVE_RE.test(original)) continue;
          return { sourceId: src.sourceId, quote: original, start, end };
        }
      }
    }
    const longHit = hits.find((h) => h.tok.length >= 6);
    if (longHit) {
      const original = src.text.slice(longHit.idx, longHit.idx + longHit.tok.length);
      const start = Array.from(src.text.slice(0, longHit.idx)).length;
      const end = start + Array.from(original).length;
      if (NEGATIVE_RE.test(text) === NEGATIVE_RE.test(original)) {
        return { sourceId: src.sourceId, quote: original, start, end };
      }
    }
  }

  return undefined;
}

/**
 * Match a paragraph (or each sentence in a paragraph) against admin-approved
 * project Proof Blocks. Never permits red-tier unapproved text to hitchhike.
 */
export function matchApprovedProofBlocks(
  text: string,
  blocks: ProjectApprovedProofBlock[] | undefined,
  bundle: KnowledgeBundle,
): { matched: ProjectApprovedProofBlock[]; sourceIds: string[]; quotes: EvidenceQuote[] } | undefined {
  const enabled = (blocks ?? []).filter((b) => b.enabled && b.text.trim().length > 0);
  if (!enabled.length) return undefined;

  const blockSourceId = (block: ProjectApprovedProofBlock): string => {
    if (block.sourceKnowledgeId) {
      const linked = bundle.sources.find((s) => s.knowledgeId === block.sourceKnowledgeId);
      if (linked) return linked.sourceId;
    }
    return `proof-block:${block.id}`;
  };

  const fullKey = normalizeBlockKey(text);
  const direct = enabled.find((b) => normalizeBlockKey(b.text) === fullKey);
  if (direct) {
    const sid = blockSourceId(direct);
    const quoteText = direct.text.trim();
    return {
      matched: [direct],
      sourceIds: [sid],
      quotes: [{ sourceId: sid, quote: quoteText, start: 0, end: Array.from(quoteText).length }],
    };
  }

  // Check sentence-by-sentence when Paragraph 2 combines [identity block] + [proof block]
  const sentences = text.split(/(?<=[.!?。！？])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return undefined;
  const matched: ProjectApprovedProofBlock[] = [];
  for (const sentence of sentences) {
    const skey = normalizeBlockKey(sentence);
    const hit = enabled.find((b) => normalizeBlockKey(b.text) === skey);
    if (!hit) return undefined;
    matched.push(hit);
  }
  const sourceIds = [...new Set(matched.map(blockSourceId))];
  const quotes = matched.map((b) => {
    const q = b.text.trim();
    return { sourceId: blockSourceId(b), quote: q, start: 0, end: Array.from(q).length };
  });
  return { matched, sourceIds, quotes };
}

/**
 * Ensure any synthetic `proof-block:<id>` source used in verified claims is recorded
 * on `review.sources` as an authorized `knowledge` source so `automatedReviewIssue`
 * recognizes Step-1 supplier evidence cleanly.
 */
export function syntheticProofBlockSources(
  usedBlocks: ProjectApprovedProofBlock[],
  existingSources: KnowledgeSource[],
): KnowledgeSource[] {
  const existingIds = new Set(existingSources.map((s) => s.sourceId));
  const extra: KnowledgeSource[] = [];
  for (const block of usedBlocks) {
    if (block.sourceKnowledgeId && existingSources.some((s) => s.knowledgeId === block.sourceKnowledgeId)) {
      continue;
    }
    const sourceId = `proof-block:${block.id}`;
    if (existingIds.has(sourceId)) continue;
    existingIds.add(sourceId);
    extra.push({
      sourceId,
      version: 1,
      title: `预审卖点块：${block.label}`,
      category: block.slot === 'identity' ? 'company' : 'product',
      kind: 'knowledge',
      content: block.text.trim(),
      source: 'project_approved_proof_block',
      applicability: 'outreach',
      products: [],
      validFrom: new Date(0).toISOString(),
      terms: [],
    });
  }
  return extra;
}

/**
 * Smart quote anchor recovery for non-red-tier outreach claims when the verifier
 * explicitly judged `status === 'supported'` and named an authorized `sourceId`,
 * but minor wording/plural variance caused exact substring matching to miss.
 * Never rescues fabricated quotes (requires >=3 content tokens and >=65% single-sentence overlap).
 */
export function recoverNonCriticalQuoteAnchor(
  quote: EvidenceQuote,
  sourceText: string,
  segmentText: string,
): EvidenceQuote | undefined {
  if (isRedTierClaim(segmentText)) return undefined;
  const qTokens = contentTokens(quote.quote);
  if (qTokens.length < 3) return undefined;

  const sentences: { text: string; offset: number }[] = [];
  const regex = /[^.!?\n。！？]+[.!?。！？]?/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sourceText)) !== null) {
    const trimmed = match[0].trim();
    if (!trimmed) continue;
    const lead = match[0].indexOf(trimmed);
    sentences.push({ text: trimmed, offset: match.index + Math.max(0, lead) });
  }

  let best: { text: string; offset: number; score: number } | undefined;
  for (const sent of sentences) {
    if (NEGATIVE_RE.test(segmentText) !== NEGATIVE_RE.test(sent.text)) continue;
    const sTokens = contentTokens(sent.text);
    if (!sTokens.length) continue;
    const matchedCount = qTokens.filter((qt) => sTokens.some((st) => tokenStemMatch(qt, st))).length;
    const score = matchedCount / qTokens.length;
    if (score >= 0.65 && (!best || score > best.score)) {
      best = { ...sent, score };
    }
  }
  if (!best) return undefined;
  const start = Array.from(sourceText.slice(0, best.offset)).length;
  const end = start + Array.from(best.text).length;
  return { sourceId: quote.sourceId, quote: best.text, start, end };
}

/**
 * Normalize question marks in Step 1/2 outreach drafts so an accidental extra `?`
 * in Paragraph 1 never triggers `cta_count` rejection when Paragraph 3 already
 * ends with a clean single CTA question.
 */
export function normalizeOutreachQuestionCount(body: string, step?: number): string {
  if (step !== 1 && step !== 2) return body;
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) return body;
  const totalQ = (body.match(/[?？]/g) ?? []).length;
  if (totalQ <= 1) return body;
  const last = paragraphs[paragraphs.length - 1]!;
  if (!/[?？]/.test(last)) return body;
  // Keep only the final paragraph's last question mark; soften earlier rhetorical questions to periods.
  const normalized = paragraphs.map((p, idx) => {
    if (idx < paragraphs.length - 1) return p.replace(/[?？]+/g, '.');
    const matches = [...p.matchAll(/[?？]/g)];
    if (matches.length <= 1) return p;
    const lastIdx = matches[matches.length - 1]!.index!;
    return p.slice(0, lastIdx).replace(/[?？]+/g, '.') + p.slice(lastIdx);
  });
  return normalized.join('\n\n');
}

/**
 * Extract suggested Approved Proof Blocks from a project's already-published
 * `AgentKnowledge` entries (company & product categories) for 1-click admin review.
 */
export function extractSuggestedProofBlocks(
  entries: { id: string; title: string; category: string; content: string }[],
): ProjectApprovedProofBlock[] {
  const seen = new Set<string>();
  const results: ProjectApprovedProofBlock[] = [];

  for (const entry of entries) {
    if (!['company', 'product', 'faq'].includes(entry.category)) continue;
    const sentences = entry.content
      .replace(/\r\n/g, '\n')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter((s) => s.length >= 30 && s.length <= 240);

    for (const sentence of sentences) {
      // Keep clean English sentences only (outreach emails are English)
      const asciiLetters = (sentence.match(/[A-Za-z]/g) ?? []).length;
      if (asciiLetters < 20 || asciiLetters / sentence.length < 0.55) continue;
      // Exclude unconfirmed red-tier commercial terms, URLs, and email addresses
      if (isRedTierClaim(sentence)) continue;
      if (/https?:\/\/|www\.|@/i.test(sentence)) continue;
      if (!/[.!?]$/.test(sentence)) continue;

      const key = normalizeBlockKey(sentence);
      if (seen.has(key)) continue;
      seen.add(key);

      const isIdentity = entry.category === 'company'
        || /\b(?:we are|manufacturer|factory|oem|odm|supplier|specializ)/i.test(sentence);
      const slot: ProjectApprovedProofBlock['slot'] = isIdentity ? 'identity' : 'proof';
      const idx = results.length + 1;
      results.push({
        id: `auto_${slot}_${idx}`,
        slot,
        label: `${entry.title.slice(0, 28)}（${slot === 'identity' ? '定位' : '卖点'}）`,
        text: sentence,
        sourceKnowledgeId: entry.id,
        enabled: true,
      });
      if (results.length >= 10) break;
    }
    if (results.length >= 10) break;
  }

  // Add 2 universal low-pressure CTA options if fewer than 12 blocks
  const defaultCtas: ProjectApprovedProofBlock[] = [
    {
      id: 'auto_cta_1',
      slot: 'cta',
      label: '低压力提问：了解优先产品线',
      text: 'Which product line would be most useful to review first?',
      enabled: true,
    },
    {
      id: 'auto_cta_2',
      slot: 'cta',
      label: '低压力提问：确认采购对接人',
      text: 'Would you be the right person to look at a brief product overview, or should I reach out to a colleague?',
      enabled: true,
    },
  ];
  for (const cta of defaultCtas) {
    const key = normalizeBlockKey(cta.text);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(cta);
    }
  }
  return results;
}

/**
 * Slot-Level Graceful Fallback for outreach sequence drafts (Steps 1, 2, 3):
 * When a non-red-tier paragraph fails after rewrite (e.g. risky opener or fluff),
 * preserve verified supplier paragraphs (or substitute enabled Approved Proof Blocks),
 * drop ONLY the unverified non-red-tier slot, ensure clean CTA question count, and
 * produce a 100%-grounded send-ready email instead of dead-ending the customer.
 *
 * NEVER triggers if any failed check is a Red-Tier commercial/numeric claim or
 * `contradicted` — those MUST still go to the Exception Queue for human review.
 */
export function trySlotLevelFallback(input: {
  checks: ClaimCheck[];
  outreachStep: number;
  approvedProofBlocks?: ProjectApprovedProofBlock[];
  bundle: KnowledgeBundle;
}): {
  bodyWithoutSalutation: string;
  checks: ClaimCheck[];
  usedBlocks: ProjectApprovedProofBlock[];
  note: string;
} | undefined {
  const { checks, outreachStep, approvedProofBlocks, bundle } = input;
  const failed = checks.filter((c) => c.status !== 'supported' && c.status !== 'non_claim');
  if (!failed.length) return undefined;

  // HARD SECURITY GATE: Never silently drop a contradicted claim or a Red-Tier commercial/numeric claim!
  if (failed.some((c) => c.status === 'contradicted' || isRedTierClaim(c.text))) {
    return undefined;
  }

  // Keep verified non-courtesy paragraphs grouped by original block order
  const keptChecks: ClaimCheck[] = [];
  const usedBlocks: ProjectApprovedProofBlock[] = [];
  const enabledBlocks = (approvedProofBlocks ?? []).filter((b) => b.enabled && b.text.trim().length > 0);
  const blockSourceId = (block: ProjectApprovedProofBlock): string => {
    if (block.sourceKnowledgeId) {
      const linked = bundle.sources.find((s) => s.knowledgeId === block.sourceKnowledgeId);
      if (linked) return linked.sourceId;
    }
    return `proof-block:${block.id}`;
  };

  for (const item of checks) {
    if (item.status !== 'supported' && item.status !== 'non_claim') continue;
    // Skip salutation here; caller re-applies server-owned salutation via ensureSalutation
    if (/^(?:dear|hello|hi|hey|good\s+(?:morning|afternoon|evening))\b/i.test(item.text.trim())) continue;
    if (keptChecks.some((k) => k.text === item.text)) continue;
    keptChecks.push(item);
  }

  const hasSupplierClaim = () =>
    keptChecks.some((c) => c.status === 'supported' && c.sourceIds.some((id) => id.startsWith('knowledge:') || id.startsWith('proof-block:')));

  // If Step 1 lost its supplier capability paragraph, try substituting enabled Approved Proof Blocks verbatim
  if (outreachStep === 1 && !hasSupplierClaim() && enabledBlocks.length > 0) {
    const identity = enabledBlocks.find((b) => b.slot === 'identity');
    const proof = enabledBlocks.find((b) => b.slot === 'proof');
    const chosen = [identity, proof].filter((b): b is ProjectApprovedProofBlock => Boolean(b));
    for (const block of chosen) {
      const sid = blockSourceId(block);
      const q = block.text.trim();
      usedBlocks.push(block);
      keptChecks.push({
        id: `fallback_${block.id}`,
        text: q,
        status: 'supported',
        sourceIds: [sid],
        quotes: [{ sourceId: sid, quote: q, start: 0, end: Array.from(q).length }],
        reason: '槽位安全降级：已替换为项目预审卖点块原文',
        block: 100 + usedBlocks.length,
      });
    }
  }

  // Step 1 MUST have at least 1 real verified supplier capability claim; otherwise stay fail-closed!
  if (outreachStep === 1 && !hasSupplierClaim()) {
    return undefined;
  }

  // Ensure Step 1/2 ends with a clean low-pressure CTA question if CTA was dropped
  const hasQuestion = keptChecks.some((c) => /[?？]/.test(c.text));
  if ((outreachStep === 1 || outreachStep === 2) && !hasQuestion) {
    const ctaBlock = enabledBlocks.find((b) => b.slot === 'cta');
    const ctaText = ctaBlock?.text.trim()
      || (outreachStep === 2
        ? 'Would this be worth a quick look?'
        : 'Which product line would be most useful to review first?');
    keptChecks.push({
      id: 'fallback_cta',
      text: ctaText,
      status: 'non_claim',
      sourceIds: [],
      reason: '槽位安全降级：补全低压力结尾问句',
      block: 200,
    });
  }

  if (keptChecks.length < 2) return undefined;

  // Group kept checks by block index into clean paragraphs
  const groups = new Map<number, string[]>();
  for (const item of keptChecks) {
    const key = item.block ?? 0;
    const list = groups.get(key) ?? [];
    if (!list.includes(item.text)) list.push(item.text);
    groups.set(key, list);
  }
  const paragraphs = [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)!.join(' '));
  const bodyWithoutSalutation = normalizeOutreachQuestionCount(paragraphs.join('\n\n'), outreachStep);

  return {
    bodyWithoutSalutation,
    checks: keptChecks,
    usedBlocks,
    note: usedBlocks.length
      ? `已安全降级 ${failed.length} 处非红线段落并锚定 ${usedBlocks.length} 条项目预审卖点块`
      : `已安全移除 ${failed.length} 处非红线未通过段落并保留全部已核验内容`,
  };
}
