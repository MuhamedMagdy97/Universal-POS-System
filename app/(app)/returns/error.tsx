"use client";

import { useClientLocale } from "@/lib/i18n/client";
import { translator } from "@/lib/i18n";

/** Error boundary for returns: a retry, never raw error text. */
export default function ReturnsError({ reset }: { error: Error; reset: () => void }) {
  const tr = translator(useClientLocale());
  return (
    <section role="alert" className="flex flex-col items-start gap-3 rounded-md border border-border p-6">
      <p>{tr("returns.state.error")}</p>
      <button type="button" onClick={reset} className="rounded-md border border-border px-4 py-2">
        {tr("returns.state.retry")}
      </button>
    </section>
  );
}
