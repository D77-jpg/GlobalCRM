import { Types } from 'mongoose';
import { Customer } from '../../models';
import { WebsiteResearch } from '../../models/WebsiteResearch';
import type { AuthUser } from '../../types/express';
import { requireProjectId } from '../../utils/access';
import { getCustomerByIdOrThrow } from '../customer.service';
import { domainOf } from './lead-source';
import { classifyContactRole, hunterDomainSearch, isGenericRoleEmail, type HunterResult } from './hunter';

export interface ContactEnrichmentResult {
  customerId: string;
  primaryEmail?: string;
  wasGeneric: boolean;
  upgradedPrimary: boolean;
  discoveredContacts: {
    name?: string;
    email: string;
    title?: string;
    roleCategory: 'brand' | 'procurement' | 'other';
    source: string;
    confidence?: number;
  }[];
  websitePeopleHints: string[];
  hunterUsed: boolean;
  note: string;
}

/**
 * 针对只有通用邮箱（info@/hello@ 等）或缺少决策人的客户：
 * 1. 先检查已有官网研究提取到的品牌/采购负责人线索与个人邮箱；
 * 2. 若仍缺少明确负责人且配置了 Hunter，可按需调用 Hunter 补全品牌或采购负责人；
 * 3. 新发现的联系人全部写入 Customer.alternateContacts，不静默覆盖人工维护的主邮箱（除非 promoteIfGeneric=true）。
 */
export async function enrichCustomerContact(
  customerId: string,
  actor: AuthUser,
  options: { useHunter?: boolean; promoteIfGeneric?: boolean; hunterSearch?: (domain: string) => Promise<HunterResult> } = {},
): Promise<ContactEnrichmentResult> {
  const customer = await getCustomerByIdOrThrow(customerId, actor);
  const projectId = requireProjectId(actor);
  const currentEmail = customer.email?.trim().toLowerCase();
  const wasGeneric = !currentEmail || isGenericRoleEmail(currentEmail);

  const discovered = new Map<string, {
    name?: string;
    email: string;
    title?: string;
    roleCategory: 'brand' | 'procurement' | 'other';
    source: string;
    confidence?: number;
  }>();

  // 1. Check website research report for person & non-generic email clues
  const latestResearch = await WebsiteResearch.findOne({
    projectId,
    customerId: new Types.ObjectId(customerId),
    state: { $in: ['ready', 'partial'] },
  }).sort({ createdAt: -1 }).lean();

  const websitePeopleHints = (latestResearch?.report?.facts ?? [])
    .filter((f) => f.kind === 'person')
    .map((f) => f.value)
    .slice(0, 6);

  for (const email of latestResearch?.report?.emails ?? []) {
    const clean = email.trim().toLowerCase();
    if (!clean || clean === currentEmail || isGenericRoleEmail(clean)) continue;
    discovered.set(clean, {
      email: clean,
      roleCategory: 'other',
      source: 'website',
      confidence: 70,
    });
  }

  // 2. Selectively call Hunter when mailbox is generic/missing and caller allows Hunter
  let hunterUsed = false;
  const domain = domainOf(customer.website || (currentEmail ? `https://${currentEmail.split('@')[1]}` : ''));
  const shouldCallHunter = Boolean(
    domain
    && (options.useHunter !== false)
    && (wasGeneric || !customer.title)
    && (options.hunterSearch || process.env.LEAD_HUNTER_API_KEY),
  );
  if (shouldCallHunter) {
    try {
      hunterUsed = true;
      const found = await (options.hunterSearch ?? hunterDomainSearch)(domain);
      for (const item of found.emails.slice(0, 6)) {
        const clean = item.value.trim().toLowerCase();
        if (!clean || isGenericRoleEmail(clean)) continue;
        const name = [item.firstName, item.lastName].filter(Boolean).join(' ').trim() || undefined;
        discovered.set(clean, {
          ...(name ? { name } : {}),
          email: clean,
          ...(item.position ? { title: item.position } : {}),
          roleCategory: classifyContactRole(item.position),
          source: 'hunter',
          confidence: item.confidence,
        });
      }
    } catch {
      // Non-fatal: keep website clues
    }
  }

  const list = [...discovered.values()].sort((a, b) => {
    const roleRank = (r: string) => (r === 'procurement' || r === 'brand' ? 2 : 1);
    return roleRank(b.roleCategory) - roleRank(a.roleCategory) || (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  let upgradedPrimary = false;
  let primaryEmail = currentEmail;
  if (list.length) {
    const doc = await Customer.findOne({ _id: customerId, projectId });
    if (doc) {
      const existingByEmail = new Map((doc.alternateContacts ?? []).map((c) => [c.email.toLowerCase(), c]));
      for (const c of list) {
        if (!existingByEmail.has(c.email)) {
          existingByEmail.set(c.email, { ...c, discoveredAt: new Date() });
        }
      }
      const update: Record<string, unknown> = { alternateContacts: [...existingByEmail.values()].slice(0, 12) };
      if (options.promoteIfGeneric && wasGeneric && list[0]) {
        // Keep previous generic email in alternateContacts before promoting decision-maker
        if (currentEmail && !existingByEmail.has(currentEmail)) {
          existingByEmail.set(currentEmail, { email: currentEmail, roleCategory: 'other', source: 'original', discoveredAt: new Date() });
          update.alternateContacts = [...existingByEmail.values()].slice(0, 12);
        }
        update.email = list[0].email;
        if (list[0].title && !doc.title) update.title = list[0].title;
        if (list[0].name && (!doc.name || doc.name === doc.company)) update.name = list[0].name;
        upgradedPrimary = true;
        primaryEmail = list[0].email;
      }
      await Customer.updateOne({ _id: doc._id, projectId }, { $set: update });
    }
  }

  return {
    customerId,
    primaryEmail,
    wasGeneric,
    upgradedPrimary,
    discoveredContacts: list,
    websitePeopleHints,
    hunterUsed,
    note: list.length
      ? `已发现 ${list.length} 个候选负责人邮箱${upgradedPrimary ? '，并已将首选负责人升级为主邮箱' : '，已保存至备选联系人列表'}`
      : websitePeopleHints.length
        ? '未发现个人直达邮箱，但已从官网提取到负责人线索'
        : '暂未发现比当前邮箱更具体的品牌或采购负责人',
  };
}
