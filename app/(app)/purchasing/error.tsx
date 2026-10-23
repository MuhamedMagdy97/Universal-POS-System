"use client";

import { useClientLocale } from "@/lib/i18n/client";
import { translator } from "@/lib/i18n";

/** Error boundary for purchasing: a retry, never raw error text. */
export default function PurchasingError({ reset }: { error: Error; reset: () => void }) {
  const tr = translator(useClientLocale());
  return (
    <section role="alert" className="card flex flex-col items-start gap-3">
      <p>{tr("purchasing.state.error")}</p>
      <button type="button" onClick={reset} className="btn">
        {tr("purchasing.state.retry")}
      </button>
    </section>
  );
}
