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

/** Opens a shift on the current register (Q1: open only; closing is T7). */
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
      <label className="flex flex-col gap-1">
        <span>
          {tr("pos.shift.float")} ({currency})
        </span>
        <input
          dir="ltr"
          inputMode="decimal"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
          className="w-40 rounded-md border border-border bg-background px-3 py-2"
        />
      </label>
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {pending ? tr("pos.shift.opening") : tr("pos.shift.open")}
      </button>
    </form>
  );
}
