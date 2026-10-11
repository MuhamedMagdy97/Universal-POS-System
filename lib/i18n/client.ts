"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, dirOf, localeFromCookieString, type Locale } from "@/lib/i18n";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readLocale(): Locale {
  return localeFromCookieString(document.cookie);
}

/** Current UI locale on the client (server snapshot: English, so hydration never mismatches). */
export function useClientLocale(): Locale {
  return useSyncExternalStore(subscribe, readLocale, () => DEFAULT_LOCALE);
}

/** Persists the locale for a year, flips `lang`/`dir` on <html> and notifies `useClientLocale` readers. */
export function setClientLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  applyDocumentLocale(locale);
  for (const listener of listeners) listener();
}

export function applyDocumentLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = dirOf(locale);
}

/**
 * Mounted once in the root layout. In production the inline
 * `DOCUMENT_LOCALE_SCRIPT` has already set `lang`/`dir`, so this is a no-op;
 * in development Strict Mode's remount resets <html> attributes to the JSX
 * ones, and this re-applies the cookie locale before paint (see the Next guide
 * "Preventing flash before hydration", "Re-applying attributes in development").
 */
export function DocumentLocaleSync(): null {
  useLayoutEffect(() => {
    applyDocumentLocale(readLocale());
  }, []);
  return null;
}
