"use client";

import { useState } from "react";

type Locale = "en" | "ar";

/**
 * EN/AR placeholder: flips `lang`/`dir` on <html> so the RTL-ready layout can
 * be checked. Translated strings and persistence arrive with T10 (EN/AR).
 */
export function LocaleToggle() {
  const [locale, setLocale] = useState<Locale>("en");

  function toggle() {
    const next: Locale = locale === "en" ? "ar" : "en";
    document.documentElement.lang = next;
    document.documentElement.dir = next === "ar" ? "rtl" : "ltr";
    setLocale(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={locale === "en" ? "Switch to Arabic" : "Switch to English"}
      className="rounded-md border border-border px-3 py-1 text-sm"
    >
      {locale === "en" ? "عربي" : "English"}
    </button>
  );
}
