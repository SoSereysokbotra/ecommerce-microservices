import { Request } from 'express';
import { LOCALE_HEADER } from '@libs/common';

export const SUPPORTED_LOCALES = ['en', 'km'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Resolves the active locale from an incoming edge request:
 * 1. Query parameter: ?lang=... or ?locale=...
 * 2. Cookie: commerce_locale=...
 * 3. Header: x-locale
 * 4. Header: Accept-Language (RFC 9110 language-range parsing)
 * 5. Default fallback: 'en'
 */
export function resolveLocale(req: Request): SupportedLocale {
  // 1. Query parameter
  const queryParam = req.query?.lang || req.query?.locale;
  if (typeof queryParam === 'string') {
    const candidate = queryParam.trim().toLowerCase();
    if (SUPPORTED_LOCALES.includes(candidate as SupportedLocale)) {
      return candidate as SupportedLocale;
    }
  }

  // 2. Cookie (cookie-parser populated)
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  const cookieLocale = cookies?.commerce_locale;
  if (typeof cookieLocale === 'string') {
    const candidate = cookieLocale.trim().toLowerCase();
    if (SUPPORTED_LOCALES.includes(candidate as SupportedLocale)) {
      return candidate as SupportedLocale;
    }
  }

  // 3. Header: x-locale
  const headerLocale = req.headers?.[LOCALE_HEADER];
  if (typeof headerLocale === 'string') {
    const candidate = headerLocale.trim().toLowerCase();
    if (SUPPORTED_LOCALES.includes(candidate as SupportedLocale)) {
      return candidate as SupportedLocale;
    }
  }

  // 4. Header: Accept-Language
  const acceptLang = req.headers?.['accept-language'];
  if (typeof acceptLang === 'string') {
    const candidate = acceptLang.toLowerCase();
    if (candidate.startsWith('km') || candidate.includes('km-')) {
      return 'km';
    }
    if (candidate.startsWith('en') || candidate.includes('en-')) {
      return 'en';
    }
  }

  return DEFAULT_LOCALE;
}
