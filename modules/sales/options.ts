import { AppError } from "@/lib/errors";
import type { OptionGroupView } from "@/modules/catalog/schemas";

/**
 * Options on a sale line (docs/planning/ui-refresh/restaurant-cafe-spec.md R7, R9). Pure and client-safe: the till,
 * offline pricing and checkout resolve options the same way. Unit-tested in tests/unit/sales-options.test.ts.
 */

/** A chosen option as the sale line keeps it, so receipts and reports never change later. */
export type OptionSnapshot = {
  group: string;
  groupAr: string | null;
  name: string;
  nameAr: string | null;
  priceDeltaMinor: number;
};

function optionsInvalid(details: Record<string, unknown>): AppError {
  return new AppError("VALIDATION_FAILED", "Choose the item's options", { reason: "OPTIONS_INVALID", ...details });
}

/**
 * The line's unit price (base + chosen choices) and its snapshot, in group then choice order. 422 OPTIONS_INVALID
 * for an unknown or repeated choice, or a group outside its minimum and maximum.
 */
export function resolveOptions(
  item: { unitPriceMinor: number; optionGroups?: readonly OptionGroupView[] },
  optionIds: readonly string[],
): { unitPriceMinor: number; snapshot: OptionSnapshot[] } {
  const wanted = new Set(optionIds);
  if (wanted.size !== optionIds.length) throw optionsInvalid({ cause: "REPEATED" });
  const snapshot: OptionSnapshot[] = [];
  let unitPriceMinor = item.unitPriceMinor;
  for (const group of item.optionGroups ?? []) {
    const picked = group.choices.filter((choice) => wanted.has(choice.id));
    if (picked.length < group.minSelect || picked.length > group.maxSelect) {
      throw optionsInvalid({ cause: "COUNT", groupId: group.id });
    }
    for (const choice of picked) {
      wanted.delete(choice.id);
      unitPriceMinor += choice.priceDeltaMinor;
      snapshot.push({
        group: group.name,
        groupAr: group.nameAr,
        name: choice.name,
        nameAr: choice.nameAr,
        priceDeltaMinor: choice.priceDeltaMinor,
      });
    }
  }
  if (wanted.size > 0) throw optionsInvalid({ cause: "UNKNOWN" });
  return { unitPriceMinor, snapshot };
}

/**
 * One key per distinct line (R9): the item, its options in any order, and its note. An item without options or
 * note keys as `productId|variantId`, as lines always have.
 */
export function lineKeyOf(
  ref: { productId: string; variantId: string | null },
  optionIds: readonly string[],
  note: string | null | undefined,
): string {
  const base = `${ref.productId}|${ref.variantId ?? ""}`;
  const options = optionIds.length > 0 ? `|o:${[...optionIds].sort().join(",")}` : "";
  return `${base}${options}${note ? `|n:${note}` : ""}`;
}

type ItemRef = { productId: string; variantId: string | null };

/**
 * Stock moves once per item (R9): lines of one item with different options or notes are one movement, their
 * quantities added up, in first-seen order. The stock ledger refuses an item twice in one movement.
 */
export function stockLinesOf(lines: readonly { ref: ItemRef; qty: number }[]): { ref: ItemRef; qty: number }[] {
  const byRef = new Map<string, { ref: ItemRef; qty: number }>();
  for (const line of lines) {
    const key = lineKeyOf(line.ref, [], null);
    const current = byRef.get(key);
    if (current) current.qty += line.qty;
    else byRef.set(key, { ref: line.ref, qty: line.qty });
  }
  return [...byRef.values()];
}
