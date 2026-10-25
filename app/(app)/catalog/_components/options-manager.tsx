"use client";

import { useState, useTransition, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { MoneyError, parseMajor, toMajorString, type CurrencyCode } from "@/lib/money";
import type { OptionGroupDetail } from "@/modules/catalog";
import { createOptionGroupAction, updateOptionGroupAction } from "../actions";
import { mapErrorBody } from "../_lib/form-errors";

type ChoiceDraft = { id?: string; name: string; nameAr: string; price: string };
type GroupDraft = { name: string; nameAr: string; minSelect: number; maxSelect: number; choices: ChoiceDraft[] };

const EMPTY: GroupDraft = {
  name: "",
  nameAr: "",
  minSelect: 0,
  maxSelect: 1,
  choices: [{ name: "", nameAr: "", price: "" }],
};

function draftOf(group: OptionGroupDetail, currency: CurrencyCode): GroupDraft {
  return {
    name: group.name,
    nameAr: group.nameAr ?? "",
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    choices: group.choices.map((choice) => ({
      id: choice.id,
      name: choice.name,
      nameAr: choice.nameAr ?? "",
      price: choice.priceDeltaMinor === 0 ? "" : toMajorString(choice.priceDeltaMinor, currency),
    })),
  };
}

/** The draft as the service takes it, or null when a price cannot be read. An empty price is 0. */
function payloadOf(draft: GroupDraft, currency: CurrencyCode) {
  const choices = [];
  for (const choice of draft.choices) {
    let priceDeltaMinor = 0;
    if (choice.price.trim() !== "") {
      try {
        priceDeltaMinor = parseMajor(choice.price, currency);
      } catch (err) {
        if (err instanceof MoneyError) return null;
        throw err;
      }
    }
    choices.push({
      ...(choice.id ? { id: choice.id } : {}),
      name: choice.name,
      nameAr: choice.nameAr.trim() ? choice.nameAr : null,
      priceDeltaMinor,
    });
  }
  return {
    name: draft.name,
    nameAr: draft.nameAr.trim() ? draft.nameAr : null,
    minSelect: draft.minSelect,
    maxSelect: draft.maxSelect,
    choices,
  };
}

/** Option groups (restaurant-cafe-spec R7): one card per group with its choices, and a card for a new one. */
export function OptionsManager({
  locale,
  currency,
  groups,
  canEdit,
}: {
  locale: Locale;
  currency: CurrencyCode;
  groups: OptionGroupDetail[];
  canEdit: boolean;
}) {
  const tr = translator(locale);
  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 ? <p className="text-muted">{tr("catalog.options.none")}</p> : null}
      {groups.map((group) => (
        <GroupCard key={group.id} locale={locale} currency={currency} group={group} canEdit={canEdit} />
      ))}
      {canEdit ? <GroupCard locale={locale} currency={currency} group={null} canEdit /> : null}
    </div>
  );
}

function GroupCard({
  locale,
  currency,
  group,
  canEdit,
}: {
  locale: Locale;
  currency: CurrencyCode;
  group: OptionGroupDetail | null;
  canEdit: boolean;
}) {
  const tr = translator(locale);
  const [draft, setDraft] = useState<GroupDraft>(group ? draftOf(group, currency) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const title = group ? group.name : tr("catalog.options.new");
  const setChoice = (index: number, patch: Partial<ChoiceDraft>) =>
    setDraft((current) => ({
      ...current,
      choices: current.choices.map((choice, i) => (i === index ? { ...choice, ...patch } : choice)),
    }));

  function save(event: FormEvent, isActive?: boolean) {
    event.preventDefault();
    const payload = payloadOf(draft, currency);
    if (!payload) {
      setError(tr("catalog.options.badPrice"));
      return;
    }
    startTransition(async () => {
      const result = group
        ? await updateOptionGroupAction(group.id, { ...payload, ...(isActive !== undefined && { isActive }) })
        : await createOptionGroupAction(payload);
      if (!result.ok) {
        const mapped = mapErrorBody(result.error, tr);
        setError(mapped.summary ?? Object.values(mapped.fields)[0] ?? tr("catalog.options.invalid"));
        setSaved(false);
        return;
      }
      setError(null);
      setSaved(true);
      if (!group) setDraft(EMPTY);
    });
  }

  return (
    <form onSubmit={(event) => save(event)} className="card flex max-w-3xl flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {group && !group.isActive ? <span className="badge">{tr("catalog.status.archived")}</span> : null}
        {group ? (
          <span className="text-sm text-muted">{tr("catalog.options.usedBy", { count: group.productCount })}</span>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-3" disabled={!canEdit || pending}>
        <div className="flex flex-wrap gap-3">
          <label className="field">
            <span className="text-sm">{tr("catalog.form.name")}</span>
            <input
              className="input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="text-sm">{tr("catalog.form.nameAr")}</span>
            <input
              className="input"
              dir="rtl"
              value={draft.nameAr}
              onChange={(event) => setDraft({ ...draft, nameAr: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="text-sm">{tr("catalog.options.min")}</span>
            <input
              className="input w-20"
              type="number"
              min={0}
              max={20}
              value={draft.minSelect}
              onChange={(event) => setDraft({ ...draft, minSelect: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span className="text-sm">{tr("catalog.options.max")}</span>
            <input
              className="input w-20"
              type="number"
              min={1}
              max={20}
              value={draft.maxSelect}
              onChange={(event) => setDraft({ ...draft, maxSelect: Number(event.target.value) })}
            />
          </label>
        </div>
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th className="text-start">{tr("catalog.options.choice")}</th>
              <th className="text-start">{tr("catalog.form.nameAr")}</th>
              <th className="text-end">{tr("catalog.options.price", { currency })}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.choices.map((choice, index) => (
              <tr key={choice.id ?? `new-${index}`}>
                <td>
                  <input
                    className="input"
                    aria-label={tr("catalog.options.choiceName", { n: index + 1 })}
                    value={choice.name}
                    onChange={(event) => setChoice(index, { name: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    dir="rtl"
                    aria-label={tr("catalog.options.choiceNameAr", { n: index + 1 })}
                    value={choice.nameAr}
                    onChange={(event) => setChoice(index, { nameAr: event.target.value })}
                  />
                </td>
                <td className="text-end">
                  <input
                    className="input w-28 text-end"
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={tr("catalog.options.choicePrice", { n: index + 1 })}
                    value={choice.price}
                    onChange={(event) => setChoice(index, { price: event.target.value })}
                  />
                </td>
                <td>
                  {draft.choices.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={tr("catalog.options.removeChoice", { n: index + 1 })}
                      onClick={() => setDraft({ ...draft, choices: draft.choices.filter((_, i) => i !== index) })}
                    >
                      ×
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="btn btn-sm self-start"
          onClick={() => setDraft({ ...draft, choices: [...draft.choices, { name: "", nameAr: "", price: "" }] })}
        >
          {tr("catalog.options.addChoice")}
        </button>
      </fieldset>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : saved ? (
        <p role="status" className="notice notice-success">
          {tr("catalog.options.saved")}
        </p>
      ) : null}
      {canEdit ? (
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {tr(group ? "catalog.options.save" : "catalog.options.create")}
          </button>
          {group ? (
            <button type="button" className="btn" disabled={pending} onClick={(event) => save(event, !group.isActive)}>
              {tr(group.isActive ? "catalog.options.archive" : "catalog.options.restore")}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
