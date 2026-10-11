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

export function dirOf(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

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
