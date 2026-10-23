"use client";

import { useClientLocale } from "@/lib/i18n/client";
import { translator } from "@/lib/i18n";

/** Error boundary for the till: a retry, never raw error text. */
export default function PosError({ reset }: { error: Error; reset: () => void }) {
  const tr = translator(useClientLocale());
  return (
    <section role="alert" className="card flex flex-col items-start gap-3">
      <p>{tr("pos.state.error")}</p>
      <button type="button" onClick={reset} className="btn">
        {tr("pos.state.retry")}
      </button>
    </section>
  );
}
