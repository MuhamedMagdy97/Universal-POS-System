"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { applyDocumentLocale, setClientLocale, useClientLocale } from "@/lib/i18n/client";

/**
 * EN/AR toggle. Stores the choice in a cookie so Server Components render the
 * right language, flips `lang`/`dir` on <html>, then refreshes the route.
 */
export function LocaleToggle() {
  const router = useRouter();
  const locale = useClientLocale();

  // The root layout prerenders `dir="ltr"`; apply the stored locale after hydration.
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  function toggle() {
    setClientLocale(locale === "en" ? "ar" : "en");
    router.refresh();
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
