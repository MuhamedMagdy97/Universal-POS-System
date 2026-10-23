"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { safeAction } from "../../inventory/_lib/form";
import { openShiftAction } from "../actions";
import { parseCash } from "../_lib/till";

type Props = {
  locale: Locale;
  branchId: string;
  registerId: string;
  currency: CurrencyCode;
};

/** Opens a shift on the current register (T6, Q1). Closing is `close-shift.tsx` (T7). */
export function OpenShiftForm({ locale, branchId, registerId, currency }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [float, setFloat] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const openingFloatMinor = parseCash(float, currency);
    if (openingFloatMinor === null) {
      setError(tr("pos.shift.invalidFloat"));
      return;
    }
    setPending(true);
    const result = await safeAction(() => openShiftAction({ branchId, registerId, openingFloatMinor }));
    setPending(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    const reason = (result.error.details as { reason?: string } | null)?.reason;
    if (reason === "SHIFT_ALREADY_OPEN") {
      // Someone opened it from another device: the page reloads into the till.
      setError(tr("pos.shift.alreadyOpen"));
      router.refresh();
      return;
    }
    setError(result.error.code === "FORBIDDEN" ? tr("pos.shift.cannotOpen") : tr("pos.error.generic"));
  }

  return (
    <form onSubmit={submit} className="flex flex-col items-start gap-3">
      <label className="field">
        <span>
          {tr("pos.shift.float")} ({currency})
        </span>
        <input
          dir="ltr"
          inputMode="decimal"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
          className="input w-40"
        />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? tr("pos.shift.opening") : tr("pos.shift.open")}
      </button>
    </form>
  );
}
