/**
 * 双模式部署能力配置（商业多租户 saas / 团队自用 self_hosted）
 * ------------------------------------------------------------------
 * 单一代码库与数据底座，按 CRM_EDITION 推导默认运行能力：
 * - saas（默认）：严格商业生产基线（HTTPS AI 网关、Secure Cookie、套餐限额、账单与多组织平台入口）。
 * - self_hosted：团队自用/局域网模式（支持精确白名单内的本地 AI 网关、可选内网 HTTP Cookie、
 *   关闭商业套餐限额拦截但保留用量统计、隐藏账单与平台管理入口、防止外发邮件携带内网追踪 URL）。
 */
import { isIP } from 'node:net';

export type CrmEdition = 'saas' | 'self_hosted';

export interface DeploymentFeatures {
  billing: boolean;
  multiOrg: boolean;
  publicPricing: boolean;
  internalAiGateway: boolean;
  enforcePlanLimits: boolean;
}

export interface DeploymentProfile {
  edition: CrmEdition;
  features: DeploymentFeatures;
}

const CLOUD_METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'instance-data',
]);

/** 解析精确 Origin 白名单（忽略空项与非法 URL，仅接受无凭据、无路径差异的 http/https origin）。 */
export function parseAllowedInternalOrigins(raw: string): string[] {
  const result = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (url.username || url.password || url.search || url.hash) continue;
      if (isMetadataOrLinkLocalHost(url.hostname)) continue;
      result.add(url.origin.toLowerCase());
    } catch {
      // 忽略无效项，不阻止服务启动
    }
  }
  return [...result];
}

/** 永远禁止的云元数据与链路本地地址（任何模式下都不得访问，防止 SSRF 窃取云主机凭证）。 */
export function isMetadataOrLinkLocalAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized) return true;
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === 'fd00:ec2::254') return true;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true;
    }
    if (normalized.startsWith('::ffff:')) {
      return isMetadataOrLinkLocalAddress(normalized.slice('::ffff:'.length));
    }
    return false;
  }
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  // 0.0.0.0/8, 169.254.0.0/16 (AWS/GCP/Azure metadata & link-local), multicast/reserved >= 224
  return a === 0 || (a === 169 && b === 254) || a >= 224;
}

export function isMetadataOrLinkLocalHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  if (CLOUD_METADATA_HOSTS.has(normalized)) return true;
  if (isIP(normalized)) return isMetadataOrLinkLocalAddress(normalized);
  return false;
}

/** 判断主机名是否指向回环、内网或保留地址（用于外发邮件追踪保护）。 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized === '::1'
    || normalized === '::'
  ) {
    return true;
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('::ffff:')) return isPrivateOrLoopbackHost(normalized.slice('::ffff:'.length));
    return false;
  }
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  // 单段主机名（如容器名 server / crm）默认视为内网主机
  return !normalized.includes('.');
}

/** 自用模式下，如果 TRACKING_BASE_URL 是内网或回环地址，则外发邮件不插入追踪像素/追踪跳转，避免暴露内网 IP。 */
export function shouldSkipMailTrackingForUrl(trackingBaseUrl: string, edition: CrmEdition): boolean {
  if (edition !== 'self_hosted') return false;
  try {
    const url = new URL(trackingBaseUrl);
    return isPrivateOrLoopbackHost(url.hostname);
  } catch {
    return true;
  }
}

export function resolveDeploymentProfile(input: {
  edition: CrmEdition;
  allowedInternalOrigins: string[];
  enforcePlanLimitsOverride?: boolean;
}): DeploymentProfile {
  const isSelfHosted = input.edition === 'self_hosted';
  const enforcePlanLimits = input.enforcePlanLimitsOverride ?? !isSelfHosted;
  return {
    edition: input.edition,
    features: {
      billing: !isSelfHosted,
      multiOrg: !isSelfHosted,
      publicPricing: !isSelfHosted,
      internalAiGateway: isSelfHosted && input.allowedInternalOrigins.length > 0,
      enforcePlanLimits,
    },
  };
}
