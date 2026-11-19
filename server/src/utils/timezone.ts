/**
 * 买家当地时间、夏令时与当地工作日解析
 * ------------------------------------------------------------------
 * 全部基于标准 IANA 时区 + Intl.DateTimeFormat，天然支持各地区夏令时 (DST) 切换。
 */
import { normalizeCountry } from './country';

export interface ResolvedBuyerSchedule {
  timezone: string;
  source: 'explicit' | 'country' | 'fallback';
  /** 0=Sun .. 6=Sat */
  workdays: number[];
}

const MON_FRI = [1, 2, 3, 4, 5];
const SUN_THU = [0, 1, 2, 3, 4];

const COUNTRY_TIMEZONES: Record<string, { timezone: string; workdays?: number[] }> = {
  'united states': { timezone: 'America/New_York' },
  usa: { timezone: 'America/New_York' },
  us: { timezone: 'America/New_York' },
  canada: { timezone: 'America/Toronto' },
  ca: { timezone: 'America/Toronto' },
  mexico: { timezone: 'America/Mexico_City' },
  brazil: { timezone: 'America/Sao_Paulo' },
  argentina: { timezone: 'America/Argentina/Buenos_Aires' },
  chile: { timezone: 'America/Santiago' },
  colombia: { timezone: 'America/Bogota' },
  'united kingdom': { timezone: 'Europe/London' },
  uk: { timezone: 'Europe/London' },
  gb: { timezone: 'Europe/London' },
  ireland: { timezone: 'Europe/Dublin' },
  france: { timezone: 'Europe/Paris' },
  germany: { timezone: 'Europe/Berlin' },
  italy: { timezone: 'Europe/Rome' },
  spain: { timezone: 'Europe/Madrid' },
  portugal: { timezone: 'Europe/Lisbon' },
  netherlands: { timezone: 'Europe/Amsterdam' },
  belgium: { timezone: 'Europe/Brussels' },
  switzerland: { timezone: 'Europe/Zurich' },
  austria: { timezone: 'Europe/Vienna' },
  sweden: { timezone: 'Europe/Stockholm' },
  norway: { timezone: 'Europe/Oslo' },
  denmark: { timezone: 'Europe/Copenhagen' },
  finland: { timezone: 'Europe/Helsinki' },
  poland: { timezone: 'Europe/Warsaw' },
  czechia: { timezone: 'Europe/Prague' },
  'czech republic': { timezone: 'Europe/Prague' },
  greece: { timezone: 'Europe/Athens' },
  turkey: { timezone: 'Europe/Istanbul' },
  'united arab emirates': { timezone: 'Asia/Dubai', workdays: MON_FRI },
  uae: { timezone: 'Asia/Dubai', workdays: MON_FRI },
  'saudi arabia': { timezone: 'Asia/Riyadh', workdays: SUN_THU },
  qatar: { timezone: 'Asia/Qatar', workdays: SUN_THU },
  kuwait: { timezone: 'Asia/Kuwait', workdays: SUN_THU },
  bahrain: { timezone: 'Asia/Bahrain', workdays: SUN_THU },
  oman: { timezone: 'Asia/Muscat', workdays: SUN_THU },
  israel: { timezone: 'Asia/Jerusalem', workdays: SUN_THU },
  egypt: { timezone: 'Africa/Cairo', workdays: SUN_THU },
  'south africa': { timezone: 'Africa/Johannesburg' },
  india: { timezone: 'Asia/Kolkata' },
  singapore: { timezone: 'Asia/Singapore' },
  malaysia: { timezone: 'Asia/Kuala_Lumpur' },
  thailand: { timezone: 'Asia/Bangkok' },
  vietnam: { timezone: 'Asia/Ho_Chi_Minh' },
  indonesia: { timezone: 'Asia/Jakarta' },
  philippines: { timezone: 'Asia/Manila' },
  japan: { timezone: 'Asia/Tokyo' },
  'south korea': { timezone: 'Asia/Seoul' },
  korea: { timezone: 'Asia/Seoul' },
  china: { timezone: 'Asia/Shanghai' },
  'hong kong': { timezone: 'Asia/Hong_Kong' },
  taiwan: { timezone: 'Asia/Taipei' },
  australia: { timezone: 'Australia/Sydney' },
  'new zealand': { timezone: 'Pacific/Auckland' },
  // 中文规范国家名映射（normalizeCountry 输出中文全称）
  美国: { timezone: 'America/New_York' },
  加拿大: { timezone: 'America/Toronto' },
  墨西哥: { timezone: 'America/Mexico_City' },
  巴西: { timezone: 'America/Sao_Paulo' },
  阿根廷: { timezone: 'America/Argentina/Buenos_Aires' },
  智利: { timezone: 'America/Santiago' },
  哥伦比亚: { timezone: 'America/Bogota' },
  英国: { timezone: 'Europe/London' },
  爱尔兰: { timezone: 'Europe/Dublin' },
  法国: { timezone: 'Europe/Paris' },
  德国: { timezone: 'Europe/Berlin' },
  意大利: { timezone: 'Europe/Rome' },
  西班牙: { timezone: 'Europe/Madrid' },
  葡萄牙: { timezone: 'Europe/Lisbon' },
  荷兰: { timezone: 'Europe/Amsterdam' },
  比利时: { timezone: 'Europe/Brussels' },
  瑞士: { timezone: 'Europe/Zurich' },
  奥地利: { timezone: 'Europe/Vienna' },
  瑞典: { timezone: 'Europe/Stockholm' },
  挪威: { timezone: 'Europe/Oslo' },
  丹麦: { timezone: 'Europe/Copenhagen' },
  芬兰: { timezone: 'Europe/Helsinki' },
  波兰: { timezone: 'Europe/Warsaw' },
  捷克: { timezone: 'Europe/Prague' },
  希腊: { timezone: 'Europe/Athens' },
  土耳其: { timezone: 'Europe/Istanbul' },
  阿联酋: { timezone: 'Asia/Dubai', workdays: MON_FRI },
  阿拉伯联合酋长国: { timezone: 'Asia/Dubai', workdays: MON_FRI },
  沙特阿拉伯: { timezone: 'Asia/Riyadh', workdays: SUN_THU },
  沙特: { timezone: 'Asia/Riyadh', workdays: SUN_THU },
  卡塔尔: { timezone: 'Asia/Qatar', workdays: SUN_THU },
  科威特: { timezone: 'Asia/Kuwait', workdays: SUN_THU },
  巴林: { timezone: 'Asia/Bahrain', workdays: SUN_THU },
  阿曼: { timezone: 'Asia/Muscat', workdays: SUN_THU },
  以色列: { timezone: 'Asia/Jerusalem', workdays: SUN_THU },
  埃及: { timezone: 'Africa/Cairo', workdays: SUN_THU },
  南非: { timezone: 'Africa/Johannesburg' },
  印度: { timezone: 'Asia/Kolkata' },
  新加坡: { timezone: 'Asia/Singapore' },
  马来西亚: { timezone: 'Asia/Kuala_Lumpur' },
  泰国: { timezone: 'Asia/Bangkok' },
  越南: { timezone: 'Asia/Ho_Chi_Minh' },
  印度尼西亚: { timezone: 'Asia/Jakarta' },
  印尼: { timezone: 'Asia/Jakarta' },
  菲律宾: { timezone: 'Asia/Manila' },
  日本: { timezone: 'Asia/Tokyo' },
  韩国: { timezone: 'Asia/Seoul' },
  中国: { timezone: 'Asia/Shanghai' },
  中国香港: { timezone: 'Asia/Hong_Kong' },
  香港: { timezone: 'Asia/Hong_Kong' },
  中国台湾: { timezone: 'Asia/Taipei' },
  台湾: { timezone: 'Asia/Taipei' },
  澳大利亚: { timezone: 'Australia/Sydney' },
  新西兰: { timezone: 'Pacific/Auckland' },
};

const US_WEST_HINT = /\b(?:CA|WA|OR|NV|california|los angeles|san francisco|seattle|portland|las vegas|san diego)\b/i;
const US_MOUNTAIN_HINT = /\b(?:CO|AZ|UT|NM|MT|ID|WY|denver|phoenix|salt lake)\b/i;
const US_CENTRAL_HINT = /\b(?:TX|IL|MN|MO|TN|LA|WI|KS|OK|texas|chicago|dallas|houston|austin|minneapolis|nashville)\b/i;
const CA_WEST_HINT = /\b(?:BC|vancouver|victoria|british columbia)\b/i;
const CA_MOUNTAIN_HINT = /\b(?:AB|calgary|edmonton|alberta)\b/i;
const AU_WEST_HINT = /\b(?:WA|perth|western australia)\b/i;

export function isValidIanaTimezone(value?: string | null): boolean {
  const tz = value?.trim();
  if (!tz || tz.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveBuyerTimezone(
  customer: { timezone?: string; country?: string; address?: string; phone?: string },
  fallbackTimezone = 'Asia/Shanghai',
): ResolvedBuyerSchedule {
  const rawCountry = (customer.country || '').trim().toLowerCase();
  const normalizedCountry = (normalizeCountry(customer.country) || customer.country || '').trim().toLowerCase();
  const countryEntry = COUNTRY_TIMEZONES[normalizedCountry] ?? COUNTRY_TIMEZONES[rawCountry];

  if (customer.timezone && isValidIanaTimezone(customer.timezone)) {
    return {
      timezone: customer.timezone.trim(),
      source: 'explicit',
      workdays: countryEntry?.workdays ?? MON_FRI,
    };
  }

  if (countryEntry) {
    const addr = `${customer.address ?? ''} ${customer.phone ?? ''}`;
    let timezone = countryEntry.timezone;
    if (normalizedCountry === 'united states' || normalizedCountry === 'usa' || normalizedCountry === 'us' || normalizedCountry === '美国' || rawCountry === 'united states' || rawCountry === 'usa' || rawCountry === 'us') {
      if (US_WEST_HINT.test(addr)) timezone = 'America/Los_Angeles';
      else if (US_MOUNTAIN_HINT.test(addr)) timezone = 'America/Denver';
      else if (US_CENTRAL_HINT.test(addr)) timezone = 'America/Chicago';
    } else if (normalizedCountry === 'canada' || normalizedCountry === 'ca' || normalizedCountry === '加拿大' || rawCountry === 'canada') {
      if (CA_WEST_HINT.test(addr)) timezone = 'America/Vancouver';
      else if (CA_MOUNTAIN_HINT.test(addr)) timezone = 'America/Edmonton';
    } else if (normalizedCountry === 'australia' || normalizedCountry === '澳大利亚' || rawCountry === 'australia') {
      if (AU_WEST_HINT.test(addr)) timezone = 'Australia/Perth';
    }
    return {
      timezone,
      source: 'country',
      workdays: countryEntry.workdays ?? MON_FRI,
    };
  }

  return {
    timezone: isValidIanaTimezone(fallbackTimezone) ? fallbackTimezone : 'UTC',
    source: 'fallback',
    workdays: MON_FRI,
  };
}
