"use client";

import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/** Error state with Retry, used by the catalog `error.tsx` boundaries. No error details are shown. */
export function CatalogError({ retry }: { retry: () => void }) {
  const tr = translator(useClientLocale());
  return (
    <section role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-danger p-6">
      <p>{tr("catalog.state.error")}</p>
      <button type="button" onClick={() => retry()} className="btn">
        {tr("catalog.state.retry")}
      </button>
    </section>
  );
}
