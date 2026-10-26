"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { clock } from "@/modules/appointments/slots";
import { safeAction } from "../../inventory/_lib/form";
import { saveOpeningHoursAction } from "../actions";

const minutesOf = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
};

/** Opening hours for the appointment calendar (salon-spec S6). Save for the Owner. */
export function OpeningHoursForm({
  locale,
  opensAt,
  closesAt,
  canManage,
}: {
  locale: Locale;
  opensAt: number;
  closesAt: number;
  canManage: boolean;
}) {
  const tr = translator(locale);
  const [opens, setOpens] = useState(clock(opensAt));
  const [closes, setCloses] = useState(clock(closesAt));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const from = minutesOf(opens);
    const to = minutesOf(closes);
    if (from === null || to === null || from >= to) {
      setNotice({ ok: false, text: tr("settings.hours.invalid") });
      return;
    }
    setPending(true);
    const result = await safeAction(() => saveOpeningHoursAction({ opensAt: from, closesAt: to }));
    setPending(false);
    setNotice(
      result.ok
        ? { ok: true, text: tr("settings.shop.saved") }
        : {
            ok: false,
            text: tr(result.error.code === "FORBIDDEN" ? "settings.shop.ownerOnly" : "settings.shop.error"),
          },
    );
  }

  return (
    <form onSubmit={save} className="card flex max-w-xl flex-col gap-3" aria-labelledby="hours-title">
      <h2 id="hours-title" className="text-lg font-semibold">
        {tr("settings.hours.title")}
      </h2>
      <p className="text-muted">{tr("settings.hours.intro")}</p>
      <fieldset className="flex flex-wrap gap-3" disabled={!canManage || pending}>
        <label className="field">
          <span>{tr("settings.hours.opens")}</span>
          <input className="input" type="time" step={900} value={opens} onChange={(e) => setOpens(e.target.value)} />
        </label>
        <label className="field">
          <span>{tr("settings.hours.closes")}</span>
          <input className="input" type="time" step={900} value={closes} onChange={(e) => setCloses(e.target.value)} />
        </label>
      </fieldset>
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
