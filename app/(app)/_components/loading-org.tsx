"use client";

import { t } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/** Fallback while the tenant badge streams in; the app layout itself stays static. */
export function LoadingOrg() {
  return <span className="text-muted">{t(useClientLocale(), "app.loadingOrg")}</span>;
}
