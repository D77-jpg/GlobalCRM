import type { Product } from './product';
import type { CustomerStatus, QuotationCurrency, QuotationStatus } from './models';

export type ProjectPolicyCategory =
  | 'moq'
  | 'pricing'
  | 'samples'
  | 'lead_time'
  | 'payment'
  | 'shipping'
  | 'material'
  | 'quality'
  | 'compliance'
  | 'company'
  | 'other';

export interface ProjectPolicyDto {
  id: string;
  code: string;
  topic: string;
  category: ProjectPolicyCategory;
  scope: string;
  valueZh: string;
  valueEn: string;
  external: boolean;
  confirmed: boolean;
  conflictNote: string;
  source: string;
  ownerRole: string;
  version: number;
  confirmedAt?: string;
  updatedAt: string;
}

export interface ProjectGuardrailRedline {
  id: string;
  pattern: string;
  message: string;
  severity: 'bad' | 'warn';
  skipSegment?: string;
  enabled: boolean;
}

export interface ProjectWritingRule {
  id: string;
  text: string;
  enabled: boolean;
  source?: string;
}

export interface WorkbenchConfigDto {
  pricingMode: 'catalog_tiered' | 'costing_approved';
  brandKey: string;
  guardrailRedlines: ProjectGuardrailRedline[];
  teamWritingRules: ProjectWritingRule[];
}

export interface GuardCheckItem {
  severity: 'ok' | 'warn' | 'bad';
  code: string;
  message: string;
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

export interface GuardSelftestResult {
  total: number;
  passed: number;
  failed: number;
  results: { name: string; expect: 'block' | 'pass'; ok: boolean; got: string[] }[];
}

export type WorkbenchItemKind = 'open_question' | 'commitment' | 'internal_task';
export type WorkbenchItemStatus = 'open' | 'result_ready' | 'resolved' | 'dismissed';
export type WorkbenchOwnerRole = 'Sales' | 'Costing' | 'Engineering' | 'QC' | 'Logistics' | 'Customs' | 'Management';
export type CommitmentGrade = 'A' | 'B' | 'C';

export interface CustomerWorkbenchItemDto {
  id: string;
  customerId: string;
  kind: WorkbenchItemKind;
  status: WorkbenchItemStatus;
  title: string;
  quote?: string;
  handling?: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED';
  grade?: CommitmentGrade;
  ownerRole: WorkbenchOwnerRole;
  dueAt?: string;
  resultNote?: string;
  sourceMailId?: string;
  sourceAnalysisId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MultiChannelDraftResult {
  scamSignals: string[];
  drafts: {
    K: { subject: string; body: string; score: ReplyScoreResult };
    B: { subject: string; body: string; score: ReplyScoreResult };
    A: { subject: string; body: string; score: ReplyScoreResult };
  };
  duelWinner: 'K' | 'B' | 'A';
  revisedDiff?: { before: string; problems: string[]; changesZh: string[] };
  analysis: {
    intentZh: string;
    summaryZh: string;
    openQuestions: {
      text: string;
      zh: string;
      handling: 'ANSWERED' | 'ASKED' | 'CHECKING' | 'NOTED' | 'DECLINED';
      ownerRole: WorkbenchOwnerRole;
    }[];
    commitments: {
      quote: string;
      grade: CommitmentGrade;
      ownerRole: WorkbenchOwnerRole;
      zh: string;
    }[];
    missingInfo: string[];
    preSendChecklist: { label: string; value: string; severity: 'ok' | 'warn' | 'bad' }[];
    knowledgeRefs?: { kind: 'policy' | 'knowledge' | 'product'; title: string; snippet: string }[];
    policyCount?: number;
  };
  usedAi: boolean;
  aiFallbackReason?: string;
}

export interface LearnedCandidate {
  type: 'writing_rule' | 'policy_change' | 'exemplar';
  text: string;
  why: string;
}

export interface KnowledgeQaResult {
  answer: string;
  matchedDocs: { id: string; title: string; category: string; relevance: 'high' | 'medium'; score: number; excerpt: string }[];
  matchedPolicies: { code: string; topic: string; external: boolean; confirmed: boolean; valueZh: string; valueEn: string }[];
  matchedProducts: Product[];
  confidenceChecks: { label: string; passed: boolean }[];
  suggestedQuestions: string[];
  usedAi: boolean;
}

export interface RfqLineDto {
  product: string;
  sku?: string;
  material?: string;
  size?: string;
  qty: string;
  logo?: string;
  color?: string;
  print?: string;
  closure?: string;
  insert?: string;
  packaging?: string;
  note?: string;
  approvedUnitPrice?: number;
  approvedCurrency?: QuotationCurrency;
  pricingStatus?: 'pending' | 'approved';
}

export interface RfqEvaluationDto {
  status: 'draft' | 'missing_info' | 'ready_for_costing' | 'costing_done' | 'quoted';
  ready: boolean;
  statusText: string;
  breaks: number[];
  minTotalPieces: number;
  coreMissing: string[];
  issues: string[];
  lineEvaluations: { index: number; minQty: number | null; qtys: number[]; flags: string[] }[];
}

export interface RfqDto {
  id: string;
  rfqNo: string;
  customerId: string;
  customer?: { id: string; name: string; company?: string; country?: string };
  title: string;
  destination: string;
  incoterm: string;
  channel: string;
  status: 'draft' | 'missing_info' | 'ready_for_costing' | 'costing_done' | 'quoted';
  lines: RfqLineDto[];
  notes: string;
  quotationId?: string;
  evaluation: RfqEvaluationDto;
  createdAt: string;
  updatedAt: string;
}

export interface QuotationSummaryDto {
  total: number;
  draft: number;
  sent: number;
  negotiating: number;
  accepted: number;
  pendingApproval: number;
  acceptedAmount: number;
  activePipelineAmount: number;
}

export interface ProductHistoricalQuoteRef {
  quotationId: string;
  quotationNo: string;
  customerName: string;
  customerCountry?: string;
  productName: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  currency: QuotationCurrency;
  status: QuotationStatus;
  createdAt: string;
}

export type StatsRangePreset = 'today' | '7d' | '30d' | 'month' | 'all' | 'custom';

export interface DecisionAnalytics {
  range: { preset: StatsRangePreset; from?: string; to?: string };
  countryDistribution: { country: string; count: number; pct: number }[];
  conversionFunnel: { stage: string; label: string; count: number; rate: number }[];
  quotationMetrics: {
    draft: number;
    sent: number;
    negotiating: number;
    accepted: number;
    acceptedAmount: number;
    pipelineAmount: number;
    pendingApproval: number;
  };
  openQuestionsCount: number;
  highIntentCount: number;
  priorityFollowUps: {
    customerId: string;
    name: string;
    company?: string;
    country?: string;
    status: CustomerStatus;
    score: number;
    openQuestions: number;
    reason: string;
    nextFollowUpAt?: string | null;
  }[];
}
