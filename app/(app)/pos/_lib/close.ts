import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";
import { parseCash } from "./till";
import type { CurrencyCode } from "@/lib/money";

/**
 * Pure helpers for the shift close screen (client-safe). The server computes the expected cash
 * and the discrepancy again on close; these only drive the preview and the messages.
 * See docs/planning/phase-8/shift-close-spec.md (S1–S2) and shift-close-data-model-and-api.md.
 */

export type CountPreview = {
  countedMinor: number | null;
  differenceMinor: number | null;
  noteRequired: boolean;
};

/** Difference between the counted cash and the expected cash. Null until the count reads as an amount. */
export function countPreview(expectedMinor: number, countedRaw: string, currency: CurrencyCode): CountPreview {
  const countedMinor = parseCash(countedRaw, currency);
  if (countedMinor === null) return { countedMinor: null, differenceMinor: null, noteRequired: false };
  const differenceMinor = countedMinor - expectedMinor;
  return { countedMinor, differenceMinor, noteRequired: differenceMinor !== 0 };
}

/** Whether the form can be submitted: a readable count, and a note whenever the difference is not zero. */
export function canSubmitClose(preview: CountPreview, note: string, pending: boolean): boolean {
  if (pending || preview.countedMinor === null) return false;
  return !preview.noteRequired || note.trim() !== "";
}

/** Maps a close error to a message. The server's reason in `details.reason` decides the message. */
export function closeErrorKey(error: ErrorBody): MessageKey {
  if (error.code === "FORBIDDEN") return "pos.close.forbidden";
  if (error.code === "NOT_FOUND") return "pos.close.notFound";
  const reason = (error.details as { reason?: string } | null)?.reason;
  switch (reason) {
    case "DISCREPANCY_NOTE_REQUIRED":
      return "pos.close.noteRequired";
    case "SHIFT_ALREADY_CLOSED":
    case "SHIFT_NOT_OPEN":
      return "pos.close.alreadyClosed";
    case "AMOUNT_TOO_LARGE":
      return "pos.close.tooLarge";
    default:
      return "pos.error.generic";
  }
}

export type CashMovementType = "PAY_IN" | "PAY_OUT" | "DROP";

/** Types this role may record: pay-ins need `sales.create`, pay-outs and drops `registers.close` (shift-close spec S5). */
export function movementTypesFor(canCloseShift: boolean): CashMovementType[] {
  return canCloseShift ? ["PAY_IN", "PAY_OUT", "DROP"] : ["PAY_IN"];
}

/** The body the cash-movements API expects, or null until the amount is above zero and a reason is typed. */
export function movementDraft(
  type: CashMovementType,
  amountRaw: string,
  reason: string,
  currency: CurrencyCode,
): { type: CashMovementType; amountMinor: number; reason: string } | null {
  const amountMinor = parseCash(amountRaw, currency);
  const trimmed = reason.trim();
  if (amountMinor === null || amountMinor < 1 || trimmed === "" || trimmed.length > 200) return null;
  return { type, amountMinor, reason: trimmed };
}

/** Maps a cash movement error to a message. */
export function movementErrorKey(error: ErrorBody): MessageKey {
  if (error.code === "FORBIDDEN") return "pos.cash.forbidden";
  if (error.code === "NOT_FOUND") return "pos.close.notFound";
  if (error.code === "VALIDATION_FAILED") return "pos.cash.invalid";
  const reason = (error.details as { reason?: string } | null)?.reason;
  if (reason === "SHIFT_NOT_OPEN") return "pos.close.alreadyClosed";
  // No reply from the server: the movement may have been recorded, and a retry would record it twice.
  if (error.code === "INTERNAL") return "pos.cash.unknown";
  return "pos.error.generic";
}
