import { Types } from 'mongoose';
import * as XLSX from 'xlsx';
import { Customer, CustomerRfq, type CustomerRfqDocument, type ICustomerRfq, type IRfqLine, type RfqStatus } from '../models';
import type { AuthUser } from '../types/express';
import { ApiError } from '../utils/ApiError';
import { customerRefScope, requireProjectId } from '../utils/access';
import { getCustomerByIdOrThrow } from './customer.service';
import { createQuotation } from './quotation.service';

export interface RfqEvaluation {
  status: RfqStatus;
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
  status: RfqStatus;
  lines: IRfqLine[];
  notes: string;
  quotationId?: string;
  evaluation: RfqEvaluation;
  createdAt: Date;
  updatedAt: Date;
}

const MAT_RE = /velvet|satin|cotton|canvas|muslin|linen|burlap|jute|organza|microfib|suede|丝绒|绒布|缎|棉|麻|欧根纱|超纤/i;
const BOXISH_RE = /box|bag|mailer|tag|ribbon|card|insert|tissue|seal|盒|袋子|纸袋|吊牌|丝带|卡片|内托/i;

function parseQtyList(raw?: string): number[] {
  if (!raw) return [];
  return String(raw)
    .split(/[/,;、\s]+|\bor\b|和|或/i)
    .map((token) => Number(token.replace(/,/g, '').trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseDims(raw?: string): number[] {
  if (!raw) return [];
  return (String(raw).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

export function evaluateRfq(lines: IRfqLine[], destination = '', incoterm = ''): RfqEvaluation {
  const breaks = new Set<number>();
  const issues: string[] = [];
  const lineEvaluations: RfqEvaluation['lineEvaluations'] = [];
  let minTotalPieces = 0;
  const isUs = /\b(us|usa|united states|america)\b|美国/i.test(destination);

  for (let i = 0; i < lines.length; i += 1) {
    const it = lines[i];
    const qtys = parseQtyList(it.qty);
    const dims = parseDims(it.size);
    const flags: string[] = [];
    const prod = `${it.product || ''} ${it.material || ''}`;
    const logo = it.logo || '';
    const note = it.note || '';

    if (qtys.length > 0 && Math.min(...qtys) < 100) {
      flags.push(`低于常规起订量 100 件（最低档 ${Math.min(...qtys)} 件）`);
    }
    if (dims.length > 0 && Math.max(...dims) <= 8 && /foil|烫金/i.test(logo)) {
      flags.push('小尺寸 + 烫金 Logo：需工程确认图稿可行性');
    }
    if (/linen|麻/i.test(prod) && /foil|烫金|fine|细/i.test(logo)) {
      flags.push('亚麻纹理 + 细 Logo：需确认烫金/印制清晰度');
    }
    if (/velvet|丝绒/i.test(prod) && /foil|烫金/i.test(logo) && /fine|detail|small text|细|小字/i.test(`${note} ${logo}`)) {
      flags.push('丝绒 + 细小文字烫金：需确认图稿线条宽度');
    }
    if (/cotton|linen|棉|麻/i.test(prod) && /food|tea|coffee|candy|chocolate|cookie|食品|茶|咖啡|糖/i.test(`${note} ${prod}`)) {
      flags.push('可能直接接触食品：需确认食品接触合规性（FOOD-CONTACT CHECK）');
    }
    if (isUs && /paper (shopping )?bag|纸袋/i.test(prod)) {
      flags.push('美国带提手纸袋面临高额反倾销/反补贴税，建议优先报价布袋或礼盒方案');
    }
    if (/insert|内托/i.test(`${it.insert || ''} ${prod}`) && !note.trim()) {
      flags.push('含内托结构：需按实物产品尺寸试装，产品变动需重核');
    }
    if (/organza|欧根纱/i.test(prod)) {
      flags.push('欧根纱单价较低，核价时注意最小起做金额');
    }

    for (const q of qtys) breaks.add(Math.round(q));
    const minQty = qtys.length > 0 ? Math.round(Math.min(...qtys)) : null;
    if (minQty) minTotalPieces += minQty;
    lineEvaluations.push({ index: i, minQty, qtys: qtys.map((q) => Math.round(q)), flags });
    for (const f of flags) {
      issues.push(`第 ${i + 1} 行 ${it.product || ''} ${it.size || ''}：${f}`);
    }
  }

  const coreMissing: string[] = [];
  if (lines.length === 0) {
    coreMissing.push('产品与规格行');
  } else {
    const requiredCols: [keyof IRfqLine, string][] = [
      ['product', '产品/结构'],
      ['size', '尺寸'],
      ['qty', '数量档'],
      ['logo', 'Logo 工艺'],
      ['color', '颜色（PMS）'],
    ];
    for (const [key, label] of requiredCols) {
      if (lines.some((it) => !String(it[key] ?? '').trim())) coreMissing.push(label);
    }
    for (const it of lines) {
      const pm = `${it.product || ''} ${it.material || ''}`;
      if (!MAT_RE.test(pm) && !BOXISH_RE.test(it.product || '')) {
        coreMissing.push('材质（丝绒/缎面/棉/麻/超纤/纸板）');
        break;
      }
    }
    if (lines.some((it) => String(it.size || '').trim() && parseDims(it.size).length < 2)) {
      coreMissing.push('完整长宽尺寸');
    }
  }

  const hasPaperBag = lines.some((it) => /paper bag|纸袋/i.test(it.product || ''));
  const hasBox = lines.some((it) => /box|盒/i.test(it.product || ''));
  if (hasPaperBag && hasBox) {
    issues.push('纸袋 + 礼盒属于同一包装系统：尺寸匹配、色差与品牌视觉需一并核对');
  }

  const sortedBreaks = [...breaks].sort((a, b) => a - b);
  const ready = coreMissing.length === 0;
  const allApproved = lines.length > 0 && lines.every((l) => l.pricingStatus === 'approved' && typeof l.approvedUnitPrice === 'number' && l.approvedUnitPrice > 0);
  const status: RfqStatus = allApproved ? 'costing_done' : ready ? 'ready_for_costing' : 'missing_info';
  const statusText = allApproved
    ? '核算已完成，可一键生成正式报价单'
    : ready
      ? `READY FOR COSTING${sortedBreaks.length > 1 ? `｜多数量档 ${sortedBreaks.join('/')} pcs` : ''}${!destination.trim() ? `（默认按 ${incoterm || 'FOB'}）` : ''}`
      : `待补核心信息：${[...new Set(coreMissing)].join('、')}`;

  return {
    status,
    ready,
    statusText,
    breaks: sortedBreaks,
    minTotalPieces,
    coreMissing: [...new Set(coreMissing)],
    issues,
    lineEvaluations,
  };
}

function toRfqDto(doc: CustomerRfqDocument | (ICustomerRfq & { _id: Types.ObjectId }), customerMap?: Map<string, { id: string; name: string; company?: string; country?: string }>): RfqDto {
  const evaluation = evaluateRfq(doc.lines ?? [], doc.destination ?? '', doc.incoterm ?? '');
  const computedStatus: RfqStatus = doc.quotationId ? 'quoted' : evaluation.status;
  return {
    id: String(doc._id),
    rfqNo: doc.rfqNo,
    customerId: String(doc.customerId),
    customer: customerMap?.get(String(doc.customerId)),
    title: doc.title,
    destination: doc.destination ?? '',
    incoterm: doc.incoterm ?? '',
    channel: doc.channel ?? 'Email',
    status: computedStatus,
    lines: doc.lines ?? [],
    notes: doc.notes ?? '',
    quotationId: doc.quotationId ? String(doc.quotationId) : undefined,
    evaluation,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function generateRfqNo(projectId: Types.ObjectId): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `RFQ-${stamp}-`;
  const count = await CustomerRfq.countDocuments({ projectId, rfqNo: new RegExp(`^${prefix}`) });
  return `${prefix}${String(count + 1).padStart(3, '0')}`;
}

export async function listRfqs(actor: AuthUser, customerId?: string): Promise<RfqDto[]> {
  const projectId = requireProjectId(actor);
  const query: Record<string, unknown> = { projectId };
  if (customerId) {
    if (!Types.ObjectId.isValid(customerId)) throw ApiError.badRequest('客户 ID 格式不正确');
    await getCustomerByIdOrThrow(customerId, actor);
    query.customerId = new Types.ObjectId(customerId);
  } else {
    Object.assign(query, await customerRefScope(actor));
  }
  const rows = await CustomerRfq.find(query).sort({ updatedAt: -1 }).limit(100).lean();
  const cIds = [...new Set(rows.map((r) => String(r.customerId)))];
  const customers = cIds.length
    ? await Customer.find({ _id: { $in: cIds } }).select('name company country').lean()
    : [];
  const map = new Map(customers.map((c) => [String(c._id), { id: String(c._id), name: c.name, company: c.company, country: c.country }]));
  return rows.map((r) => toRfqDto(r as ICustomerRfq & { _id: Types.ObjectId }, map));
}

export async function createRfq(
  input: {
    customerId: string;
    title: string;
    destination?: string;
    incoterm?: string;
    channel?: string;
    lines: IRfqLine[];
    notes?: string;
  },
  actor: AuthUser,
): Promise<RfqDto> {
  if (!Types.ObjectId.isValid(input.customerId)) throw ApiError.badRequest('客户 ID 格式不正确');
  await getCustomerByIdOrThrow(input.customerId, actor);
  const projectId = requireProjectId(actor);
  const rfqNo = await generateRfqNo(projectId);
  const ev = evaluateRfq(input.lines, input.destination, input.incoterm);
  const doc = await CustomerRfq.create({
    projectId,
    customerId: new Types.ObjectId(input.customerId),
    rfqNo,
    title: input.title.trim(),
    destination: input.destination?.trim() || undefined,
    incoterm: input.incoterm?.trim() || undefined,
    channel: input.channel?.trim() || 'Email',
    status: ev.status,
    lines: input.lines,
    notes: input.notes?.trim() || undefined,
    createdBy: new Types.ObjectId(actor.id),
    updatedBy: new Types.ObjectId(actor.id),
  });
  return toRfqDto(doc);
}

export async function updateRfq(
  id: string,
  input: Partial<{
    title: string;
    destination: string;
    incoterm: string;
    channel: string;
    lines: IRfqLine[];
    notes: string;
  }>,
  actor: AuthUser,
): Promise<RfqDto> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('RFQ ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerRfq.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('RFQ 核价单不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  if (input.title !== undefined) doc.title = input.title.trim();
  if (input.destination !== undefined) doc.destination = input.destination.trim();
  if (input.incoterm !== undefined) doc.incoterm = input.incoterm.trim();
  if (input.channel !== undefined) doc.channel = input.channel.trim();
  if (input.lines !== undefined) doc.lines = input.lines;
  if (input.notes !== undefined) doc.notes = input.notes.trim();
  const ev = evaluateRfq(doc.lines, doc.destination, doc.incoterm);
  doc.status = doc.quotationId ? 'quoted' : ev.status;
  doc.updatedBy = new Types.ObjectId(actor.id);
  await doc.save();
  return toRfqDto(doc);
}

export async function deleteRfq(id: string, actor: AuthUser): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('RFQ ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerRfq.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('RFQ 核价单不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  await doc.deleteOne();
}

export async function exportRfqCostingXlsx(id: string, actor: AuthUser): Promise<{ filename: string; buffer: Buffer }> {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('RFQ ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerRfq.findOne({ _id: id, projectId }).lean();
  if (!doc) throw ApiError.notFound('RFQ 核价单不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  const ev = evaluateRfq(doc.lines, doc.destination, doc.incoterm);

  const header = ['RFQ编号', '产品/结构', '材料', '尺寸', '数量档', 'Logo 工艺', '颜色(PMS)', '印刷', '开合/抽绳', '内托', '包装', '核算单价', '币种', '状态', '备注', '系统风控提示'];
  const rows: (string | number)[][] = [header];
  doc.lines.forEach((it, idx) => {
    rows.push([
      doc.rfqNo,
      it.product || '',
      it.material || '',
      it.size || '',
      it.qty || '',
      it.logo || '',
      it.color || '',
      it.print || '',
      it.closure || '',
      it.insert || '',
      it.packaging || '',
      it.approvedUnitPrice ?? '',
      it.approvedCurrency ?? 'USD',
      it.pricingStatus === 'approved' ? '已批准' : '待核算',
      it.note || '',
      (ev.lineEvaluations[idx]?.flags ?? []).join('；'),
    ]);
  });
  rows.push([]);
  rows.push(['数量档汇总', ev.breaks.join('/'), '目的地', doc.destination || '', '贸易条款', doc.incoterm || 'FOB', '核算状态', ev.statusText]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'RFQ核价表');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { filename: `${doc.rfqNo}-costing.xlsx`, buffer };
}

export async function convertRfqToQuotation(id: string, actor: AuthUser) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest('RFQ ID 格式不正确');
  const projectId = requireProjectId(actor);
  const doc = await CustomerRfq.findOne({ _id: id, projectId });
  if (!doc) throw ApiError.notFound('RFQ 核价单不存在');
  await getCustomerByIdOrThrow(String(doc.customerId), actor);
  if (doc.lines.length === 0) throw ApiError.badRequest('RFQ 至少需要一行规格才能生成报价单');

  const currency = doc.lines.find((l) => l.approvedCurrency)?.approvedCurrency ?? 'USD';
  const items = doc.lines.map((l) => {
    const qtys = parseQtyList(l.qty);
    const quantity = qtys[0] ?? 100;
    const isApproved = l.pricingStatus === 'approved' && typeof l.approvedUnitPrice === 'number' && l.approvedUnitPrice > 0;
    const specSummary = [l.material, l.size, l.color, l.logo].filter(Boolean).join(' / ');
    return {
      productName: l.product,
      model: specSummary || l.sku || undefined,
      sku: l.sku || undefined,
      colorSpec: [l.color, l.size].filter(Boolean).join(' ') || undefined,
      moq: undefined,
      quantity,
      unitPrice: isApproved ? Number(l.approvedUnitPrice) : 0,
      pricingStatus: (isApproved ? 'approved' : 'pending') as 'approved' | 'pending',
    };
  });

  const incotermMatch = /\b(EXW|FOB|CIF|CFR|DDP|DDU|DAP)\b/i.exec(doc.incoterm || '');
  const parsedIncoterm = incotermMatch?.[1]?.toUpperCase() as 'EXW' | 'FOB' | 'CIF' | 'CFR' | 'DDP' | 'DDU' | 'DAP' | undefined;

  const created = await createQuotation(
    String(doc.customerId),
    {
      title: `${doc.title} (${doc.rfqNo})`,
      items,
      currency,
      incoterm: parsedIncoterm,
      destinationPort: doc.destination || undefined,
      paymentTerms: undefined,
      leadTime: undefined,
      moq: undefined,
      notes: doc.notes || `由核价单 ${doc.rfqNo} 转换生成`,
      status: 'draft',
      markCustomerAsQuoting: false,
    },
    actor,
  );

  doc.quotationId = new Types.ObjectId(created.id);
  doc.status = 'quoted';
  await doc.save();
  return { rfq: toRfqDto(doc), quotation: created };
}
