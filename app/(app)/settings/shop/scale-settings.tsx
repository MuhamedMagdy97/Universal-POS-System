"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { normalizeDigits } from "@/lib/money";
import type { ScaleSettings, ScaleValueKind } from "@/lib/scale-label";
import { safeAction } from "../../inventory/_lib/form";
import { saveScaleSettingsAction } from "../actions";

/** Scale labels (weighed-selling-spec W6): Save for the Owner, read-only for an Admin. */
export function ScaleSettingsForm({
  locale,
  settings,
  canManage,
}: {
  locale: Locale;
  settings: ScaleSettings;
  canManage: boolean;
}) {
  const tr = translator(locale);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [prefixes, setPrefixes] = useState(settings.prefixes.join(", "));
  const [itemDigits, setItemDigits] = useState(settings.itemDigits);
  const [valueKind, setValueKind] = useState<ScaleValueKind>(settings.valueKind);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    key: "settings.shop.saved" | "settings.shop.error" | "settings.scale.invalid" | "settings.scale.ownerOnly";
  } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    const list = normalizeDigits(prefixes)
      .split(/[,،\s]+/)
      .filter(Boolean);
    const result = await safeAction(() => saveScaleSettingsAction({ enabled, prefixes: list, itemDigits, valueKind }));
    setPending(false);
    if (!result.ok) {
      const key =
        result.error.code === "FORBIDDEN"
          ? "settings.scale.ownerOnly"
          : result.error.code === "VALIDATION_FAILED"
            ? "settings.scale.invalid"
            : "settings.shop.error";
      setNotice({ tone: "error", key });
      return;
    }
    setNotice({ tone: "ok", key: "settings.shop.saved" });
  }

  return (
    <form onSubmit={save} className="card flex max-w-xl flex-col gap-4" aria-labelledby="scale-title">
      <h2 id="scale-title" className="text-lg font-semibold">
        {tr("settings.scale.title")}
      </h2>
      <p className="text-muted">{tr("settings.scale.intro")}</p>
      <fieldset className="flex flex-col gap-4" disabled={!canManage || pending}>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {tr("settings.scale.enabled")}
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("settings.scale.prefixes")}</span>
          <input
            className="input"
            dir="ltr"
            inputMode="numeric"
            value={prefixes}
            onChange={(event) => setPrefixes(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("settings.scale.itemDigits")}</span>
          <select className="input" value={itemDigits} onChange={(event) => setItemDigits(Number(event.target.value))}>
            {[4, 5, 6].map((digits) => (
              <option key={digits} value={digits}>
                {digits}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1">{tr("settings.scale.valueKind")}</legend>
          {(["WEIGHT", "PRICE"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-3">
              <input
                type="radio"
                name="scaleValueKind"
                checked={valueKind === kind}
                onChange={() => setValueKind(kind)}
              />
              {tr(`settings.scale.${kind}`)}
            </label>
          ))}
        </fieldset>
      </fieldset>
      {canManage ? null : <p className="field-hint">{tr("settings.scale.ownerOnly")}</p>}
      {notice ? (
        <p
          role={notice.tone === "ok" ? "status" : "alert"}
          className={`notice ${notice.tone === "ok" ? "notice-success" : "notice-error"}`}
        >
          {tr(notice.key)}
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
