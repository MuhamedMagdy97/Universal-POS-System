"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { parsePercentBp } from "@/lib/money";
import { safeAction } from "../../inventory/_lib/form";
import { saveServiceChargeAction } from "../actions";

/** The dine-in service charge (restaurant-cafe-spec R11): a percent, 0 = off. Save for the Owner. */
export function ServiceChargeForm({
  locale,
  serviceChargeBp,
  canManage,
}: {
  locale: Locale;
  serviceChargeBp: number;
  canManage: boolean;
}) {
  const tr = translator(locale);
  const [raw, setRaw] = useState(String(serviceChargeBp / 100));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const bp = raw.trim() === "" ? 0 : parsePercentBp(raw);
    if (bp === null || bp > 2_500) {
      setNotice({ ok: false, text: tr("settings.service.invalid") });
      return;
    }
    setPending(true);
    const result = await safeAction(() => saveServiceChargeAction(bp));
    setPending(false);
    if (!result.ok) {
      const key =
        result.error.code === "FORBIDDEN"
          ? "settings.service.ownerOnly"
          : result.error.code === "VALIDATION_FAILED"
            ? "settings.service.invalid"
            : "settings.shop.error";
      setNotice({ ok: false, text: tr(key) });
      return;
    }
    setNotice({ ok: true, text: tr("settings.shop.saved") });
  }

  return (
    <form onSubmit={save} className="card flex max-w-xl flex-col gap-3" aria-labelledby="service-title">
      <h2 id="service-title" className="text-lg font-semibold">
        {tr("settings.service.title")}
      </h2>
      <p className="text-muted">{tr("settings.service.intro")}</p>
      <label className="flex flex-col gap-1">
        <span>{tr("settings.service.percent")}</span>
        <input
          className="input w-32"
          dir="ltr"
          inputMode="decimal"
          value={raw}
          disabled={!canManage || pending}
          onChange={(event) => setRaw(event.target.value)}
        />
      </label>
      {canManage ? null : <p className="field-hint">{tr("settings.service.ownerOnly")}</p>}
      {notice ? (
        <p role={notice.ok ? "status" : "alert"} className={`notice ${notice.ok ? "notice-success" : "notice-error"}`}>
          {notice.text}
        </p>
      ) : null}
      {canManage ? (
        <button type="submit" disabled={pending} className="btn btn-primary self-start">
          {tr("settings.shop.save")}
        </button>
      ) : null}
    </form>
  );
}
