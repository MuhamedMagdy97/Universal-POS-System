"use client";

import { useState, useTransition } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { setProductOptionGroupsAction } from "../actions";
import { mapErrorBody } from "../_lib/form-errors";

/** The item's option groups (restaurant-cafe-spec R7): tick the groups the cashier picks from, in list order. */
export function ProductOptions({
  locale,
  productId,
  groups,
  linked,
  canEdit,
}: {
  locale: Locale;
  productId: string;
  groups: { id: string; name: string; nameAr: string | null }[];
  linked: string[];
  canEdit: boolean;
}) {
  const tr = translator(locale);
  const [picked, setPicked] = useState(linked);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const toggle = (id: string, on: boolean) =>
    setPicked((current) => (on ? [...current, id] : current.filter((groupId) => groupId !== id)));

  function save() {
    startTransition(async () => {
      const result = await setProductOptionGroupsAction(productId, picked);
      if (!result.ok) {
        const mapped = mapErrorBody(result.error, tr);
        setNotice({
          ok: false,
          text: mapped.summary ?? Object.values(mapped.fields)[0] ?? tr("catalog.options.invalid"),
        });
        return;
      }
      setNotice({ ok: true, text: tr("catalog.options.groupsSaved") });
    });
  }

  return (
    <section className="card flex max-w-3xl flex-col gap-3" aria-labelledby="product-options">
      <h2 id="product-options" className="text-lg font-semibold">
        {tr("catalog.options.groups")}
      </h2>
      <p className="text-sm text-muted">{tr("catalog.options.groupsHint")}</p>
      <fieldset className="flex flex-col gap-2" disabled={!canEdit || pending}>
        {groups.map((group) => (
          <label key={group.id} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={picked.includes(group.id)}
              onChange={(event) => toggle(group.id, event.target.checked)}
            />
            {(locale === "ar" && group.nameAr) || group.name}
          </label>
        ))}
      </fieldset>
      {notice ? (
        <p role={notice.ok ? "status" : "alert"} className={`notice ${notice.ok ? "notice-success" : "notice-error"}`}>
          {notice.text}
        </p>
      ) : null}
      {canEdit ? (
        <button type="button" className="btn self-start" disabled={pending} onClick={save}>
          {tr("catalog.options.save")}
        </button>
      ) : null}
    </section>
  );
}
