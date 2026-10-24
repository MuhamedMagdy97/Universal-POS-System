"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/app/_ui/icons";
import { translator, type Locale } from "@/lib/i18n";
import { BUSINESS_PRESETS, type BusinessTypeId } from "@/modules/presets";
import { safeAction } from "../../inventory/_lib/form";
import { saveBusinessTypeAction } from "../actions";

/** The six business types; Save for the Owner, a read-only list with a note for an Admin. */
export function ShopSettingsForm({
  locale,
  businessType,
  canManage,
}: {
  locale: Locale;
  businessType: BusinessTypeId;
  canManage: boolean;
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [saved, setSaved] = useState(businessType);
  const [value, setValue] = useState(businessType);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    key: "settings.shop.saved" | "settings.shop.error" | "settings.shop.ownerOnly";
  } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    const result = await safeAction(() => saveBusinessTypeAction(value));
    setPending(false);
    if (!result.ok) {
      setNotice({
        tone: "error",
        key: result.error.code === "FORBIDDEN" ? "settings.shop.ownerOnly" : "settings.shop.error",
      });
      return;
    }
    setSaved(value);
    setNotice({ tone: "ok", key: "settings.shop.saved" });
    // The accent, sidebar icon and dashboard come from the layout: reload them.
    router.refresh();
  }

  return (
    <form onSubmit={save} className="card flex max-w-xl flex-col gap-4">
      <fieldset className="flex flex-col gap-2" disabled={!canManage || pending}>
        <legend className="mb-1 font-medium">{tr("settings.shop.businessType")}</legend>
        {BUSINESS_PRESETS.map((preset) => (
          <label
            key={preset.id}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-border-strong px-4 py-3 transition-colors hover:bg-surface-sunken has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:disabled]:cursor-not-allowed"
          >
            <input
              type="radio"
              name="businessType"
              value={preset.id}
              checked={value === preset.id}
              onChange={() => setValue(preset.id)}
            />
            <Icon name={preset.icon} className="size-5 text-muted" />
            <span className="flex-1">{preset.label[locale]}</span>
          </label>
        ))}
      </fieldset>
      <p className="field-hint">{tr(canManage ? "settings.shop.hint" : "settings.shop.ownerOnly")}</p>
      {notice ? (
        <p
          role={notice.tone === "ok" ? "status" : "alert"}
          className={`notice ${notice.tone === "ok" ? "notice-success" : "notice-error"}`}
        >
          {tr(notice.key)}
        </p>
      ) : null}
      {canManage ? (
        <button type="submit" disabled={pending || value === saved} className="btn btn-primary self-start">
          {tr("settings.shop.save")}
        </button>
      ) : null}
    </form>
  );
}
