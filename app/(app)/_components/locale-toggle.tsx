"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/app/_ui/icons";
import { setClientLocale, useClientLocale } from "@/lib/i18n/client";

/**
 * EN/AR toggle. Stores the choice in a cookie so Server Components render the
 * right language, flips `lang`/`dir` on <html>, then refreshes the route.
 */
export function LocaleToggle() {
  const router = useRouter();
  const locale = useClientLocale();

  function toggle() {
    setClientLocale(locale === "en" ? "ar" : "en");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={locale === "en" ? "Switch to Arabic" : "Switch to English"}
      className="btn btn-ghost btn-sm"
    >
      <Icon name="language" className="size-4" />
      {locale === "en" ? "عربي" : "English"}
    </button>
  );
}
