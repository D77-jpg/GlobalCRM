/**
 * Cookie helpers for browser sessions.
 *
 * Access and refresh tokens stay in HttpOnly cookies. The CSRF cookie is
 * intentionally readable by the SPA so it can echo the value in a request
 * header (double-submit cookie pattern).
 */
import type { Request, Response } from 'express';
import env from '../config/env';
import type { CrmEdition } from '../config/edition';

export const AUTH_COOKIE_NAMES = {
  access: 'cdlm_access',
  refresh: 'cdlm_refresh',
  csrf: 'cdlm_csrf',
} as const;

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAge?: number;
}

export function parseCookieHeader(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore a malformed cookie rather than breaking authentication.
    }
  }
  return result;
}

export function getCookie(req: Request, name: string): string | undefined {
  return parseCookieHeader(req.headers.cookie)[name];
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

export function setCookie(res: Response, name: string, value: string, options: CookieOptions): void {
  res.append('Set-Cookie', serializeCookie(name, value, options));
}

export function secureCookieFlag(options?: {
  isProd?: boolean;
  edition?: CrmEdition;
  cookieSecure?: boolean;
}): boolean {
  const isProd = options?.isProd ?? env.isProd;
  const edition = options?.edition ?? env.CRM_EDITION;
  const cookieSecure = options?.cookieSecure ?? env.COOKIE_SECURE;
  // 商业版（saas）生产环境始终强制 Secure Cookie；团队自用版（self_hosted）允许通过 COOKIE_SECURE=false 支持受信任局域网 HTTP 访问
  if (edition === 'self_hosted') return cookieSecure;
  return isProd || cookieSecure;
}

export function setAuthCookies(
  res: Response,
  values: { accessToken: string; refreshToken: string; csrfToken: string; accessExpiresAt: string },
): void {
  const secure = secureCookieFlag();
  res.setHeader('Cache-Control', 'no-store');
  const accessAge = Math.max(1, Math.floor((new Date(values.accessExpiresAt).getTime() - Date.now()) / 1000));
  const refreshAge = env.JWT_REFRESH_EXPIRES_DAYS * 24 * 60 * 60;
  setCookie(res, AUTH_COOKIE_NAMES.access, values.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/api',
    maxAge: accessAge,
  });
  setCookie(res, AUTH_COOKIE_NAMES.refresh, values.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/api/auth',
    maxAge: refreshAge,
  });
  setCookie(res, AUTH_COOKIE_NAMES.csrf, values.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: refreshAge,
  });
}

export function clearAuthCookies(res: Response): void {
  const secure = secureCookieFlag();
  res.setHeader('Cache-Control', 'no-store');
  setCookie(res, AUTH_COOKIE_NAMES.access, '', { httpOnly: true, secure, sameSite: 'Lax', path: '/api', maxAge: 0 });
  setCookie(res, AUTH_COOKIE_NAMES.refresh, '', { httpOnly: true, secure, sameSite: 'Strict', path: '/api/auth', maxAge: 0 });
  setCookie(res, AUTH_COOKIE_NAMES.csrf, '', { httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: 0 });
}
