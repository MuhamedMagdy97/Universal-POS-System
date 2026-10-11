import { describe, expect, it } from "vitest";
import { canSubmitClose, closeErrorKey, countPreview } from "@/app/(app)/pos/_lib/close";
import type { ErrorBody } from "@/lib/errors";

/**
 * Shift close screen helpers (T7): count preview, note rule and error mapping. The expected
 * amount is in minor units (from the server); the count is typed in major units, as on the till.
 */

describe("count preview", () => {
  it("reads the typed count in major units and gives the difference in minor units", () => {
    expect(countPreview(700000, "6800", "EGP")).toEqual({
      countedMinor: 680000,
      differenceMinor: -20000,
      noteRequired: true,
    });
    expect(countPreview(700000, "7000", "EGP")).toEqual({
      countedMinor: 700000,
      differenceMinor: 0,
      noteRequired: false,
    });
  });

  it("reads Arabic-Indic digits and a decimal amount", () => {
    expect(countPreview(500000, "٥٠٠٠", "EGP")).toMatchObject({ countedMinor: 500000, differenceMinor: 0 });
    expect(countPreview(500000, "5000.50", "EGP")).toMatchObject({ countedMinor: 500050, differenceMinor: 50 });
  });

  it("has no difference until the count reads as an amount", () => {
    expect(countPreview(500000, "", "EGP")).toEqual({ countedMinor: null, differenceMinor: null, noteRequired: false });
    expect(countPreview(500000, "abc", "EGP").countedMinor).toBeNull();
    expect(countPreview(500000, "-5", "EGP").countedMinor).toBeNull();
  });
});

describe("submitting a close", () => {
  it("needs a readable count", () => {
    expect(canSubmitClose(countPreview(500000, "", "EGP"), "", false)).toBe(false);
    expect(canSubmitClose(countPreview(500000, "5000", "EGP"), "", false)).toBe(true);
  });

  it("needs a note when the difference is not zero", () => {
    const short = countPreview(500000, "4900", "EGP");
    expect(canSubmitClose(short, "", false)).toBe(false);
    expect(canSubmitClose(short, "   ", false)).toBe(false);
    expect(canSubmitClose(short, "Coins miscounted", false)).toBe(true);
  });

  it("is blocked while a request is pending", () => {
    expect(canSubmitClose(countPreview(500000, "5000", "EGP"), "", true)).toBe(false);
  });
});

describe("close error messages", () => {
  const error = (code: ErrorBody["code"], reason?: string): ErrorBody => ({
    code,
    message: "x",
    details: reason ? { reason } : null,
  });

  it("maps each server reason to its message", () => {
    expect(closeErrorKey(error("VALIDATION_FAILED", "DISCREPANCY_NOTE_REQUIRED"))).toBe("pos.close.noteRequired");
    expect(closeErrorKey(error("CONFLICT", "SHIFT_ALREADY_CLOSED"))).toBe("pos.close.alreadyClosed");
    expect(closeErrorKey(error("CONFLICT", "SHIFT_NOT_OPEN"))).toBe("pos.close.alreadyClosed");
    expect(closeErrorKey(error("VALIDATION_FAILED", "AMOUNT_TOO_LARGE"))).toBe("pos.close.tooLarge");
  });

  it("maps permission and not-found errors, and falls back to generic", () => {
    expect(closeErrorKey(error("FORBIDDEN"))).toBe("pos.close.forbidden");
    expect(closeErrorKey(error("NOT_FOUND"))).toBe("pos.close.notFound");
    expect(closeErrorKey(error("INTERNAL"))).toBe("pos.error.generic");
  });
});
