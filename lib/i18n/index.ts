/**
 * EN/AR UI strings (catalog Q11): a typed dictionary, no i18n library.
 * All catalog UI text goes through `t()` so T10 only has to wire locale
 * persistence. Keys are flat and dotted; English defines the key set.
 */
import { ar } from "./messages/ar";
import { en } from "./messages/en";
import type { Locale, MessageArgs, MessageKey, Messages } from "./types";

export { LOCALES } from "./types";
export type { Locale, MessageKey, MessageParams, Messages } from "./types";

export const DEFAULT_LOCALE: Locale = "en";

export const MESSAGES: Record<Locale, Messages> = { en, ar };

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ar";
}

/** Cookie holding the UI locale chosen with the EN/AR toggle (not sensitive; readable by JS). */
export const LOCALE_COOKIE = "pos_locale";

/** Any cookie/header value → a supported locale (default English). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Reads the locale cookie out of a `document.cookie`-style string. */
export function localeFromCookieString(cookieString: string): Locale {
  for (const part of cookieString.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LOCALE_COOKIE) return toLocale(rest.join("="));
  }
  return DEFAULT_LOCALE;
}

export function dirOf(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * Inline `<head>` script for the root layout: sets `lang`/`dir` on <html> from
 * the locale cookie while the HTML is parsed, before first paint. The root
 * layout stays statically prerendered (`lang="en" dir="ltr"`); reading the
 * cookie with `cookies()` there would make every route dynamic under Cache
 * Components (next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md,
 * "Storing the theme in a cookie"). Only known locales are applied.
 */
export const DOCUMENT_LOCALE_SCRIPT =
  `(function(){try{var m=document.cookie.match(/(?:^|; )${LOCALE_COOKIE}=([^;]*)/);` +
  `var l=m&&m[1];var d=${JSON.stringify({ en: dirOf("en"), ar: dirOf("ar") })};` +
  `if(l&&Object.prototype.hasOwnProperty.call(d,l)){var e=document.documentElement;e.lang=l;e.dir=d[l]}}catch(e){}})()`;

/** Fill `{name}` placeholders. Unknown placeholders are left visible so gaps are easy to spot. */
export function interpolate(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/**
 * Look up a message. Params are type-checked against the English template:
 * `t("ar", "catalog.state.noResults", { q })`.
 */
export function t<K extends MessageKey>(locale: Locale, key: K, ...args: MessageArgs<K>): string {
  const params = args[0] as Record<string, string | number> | undefined;
  return interpolate(MESSAGES[locale][key], params);
}

/** Bind a locale once, e.g. in a page: `const tr = translator(locale); tr("catalog.nav")`. */
export function translator(locale: Locale) {
  return <K extends MessageKey>(key: K, ...args: MessageArgs<K>): string => t(locale, key, ...args);
}
