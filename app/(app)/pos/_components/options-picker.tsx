"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { resolveOptions } from "@/modules/sales/options";
import { displayName, type PickedOptions, type TillItem } from "../_lib/till";

/**
 * Options for one item (restaurant-cafe-spec R7): a fieldset per group, radios when one may be picked, check boxes
 * otherwise. Add is live once every group has its minimum; Esc cancels. The price shown is what the line will cost.
 */
export function OptionsPicker({
  locale,
  item,
  money,
  onAdd,
  onCancel,
}: {
  locale: Locale;
  item: TillItem;
  money: (minor: number) => string;
  onAdd: (picked: PickedOptions) => void;
  onCancel: () => void;
}) {
  const tr = translator(locale);
  const groups = item.optionGroups ?? [];
  // Each required single choice starts on its first choice, so a plain "Regular" is one tap.
  const [chosen, setChosen] = useState<string[]>(() =>
    groups.flatMap((group) => (group.minSelect === 1 && group.maxSelect === 1 ? [group.choices[0].id] : [])),
  );
  const firstRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => firstRef.current?.focus(), []);

  let resolved: ReturnType<typeof resolveOptions> | null;
  try {
    resolved = resolveOptions(item, chosen);
  } catch {
    resolved = null;
  }

  function toggle(groupIndex: number, choiceId: string, on: boolean) {
    const group = groups[groupIndex];
    const others = chosen.filter((id) => !group.choices.some((choice) => choice.id === id));
    const mine = chosen.filter((id) => group.choices.some((choice) => choice.id === id));
    if (group.maxSelect === 1) setChosen(on ? [...others, choiceId] : others);
    else if (on && mine.length < group.maxSelect) setChosen([...chosen, choiceId]);
    else if (!on) setChosen(chosen.filter((id) => id !== choiceId));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!resolved) return;
    onAdd({ options: chosen, labels: resolved.snapshot, unitPriceMinor: resolved.unitPriceMinor });
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="card flex flex-col gap-3"
      aria-label={tr("pos.options.for", { name: displayName(item, locale) })}
      data-testid="options-picker"
    >
      <h3 className="font-semibold">{displayName(item, locale)}</h3>
      {groups.map((group, groupIndex) => (
        <fieldset key={group.id} className="flex flex-col gap-1">
          <legend className="mb-1 text-sm text-muted">
            {(locale === "ar" && group.nameAr) || group.name}
            {" · "}
            {group.minSelect > 0
              ? tr("pos.options.pick", { min: group.minSelect, max: group.maxSelect })
              : tr("pos.options.upTo", { max: group.maxSelect })}
          </legend>
          <div className="flex flex-wrap gap-2">
            {group.choices.map((choice, choiceIndex) => {
              const on = chosen.includes(choice.id);
              return (
                <label
                  key={choice.id}
                  className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-border-strong px-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                >
                  <input
                    ref={groupIndex === 0 && choiceIndex === 0 ? firstRef : undefined}
                    type={group.maxSelect === 1 ? "radio" : "checkbox"}
                    name={`group-${group.id}`}
                    checked={on}
                    onChange={(event) => toggle(groupIndex, choice.id, event.target.checked)}
                  />
                  {(locale === "ar" && choice.nameAr) || choice.name}
                  {choice.priceDeltaMinor > 0 ? (
                    <span dir="ltr" className="text-sm text-muted">
                      +{money(choice.priceDeltaMinor)}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={!resolved}>
          {tr("pos.options.add", { price: resolved ? money(resolved.unitPriceMinor) : "—" })}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {tr("pos.options.cancel")}
        </button>
      </div>
    </form>
  );
}
