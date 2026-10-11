import { describe, expect, it } from "vitest";
import { localeFromCookieString, toLocale } from "@/lib/i18n";
import {
  addBarcodeChip,
  displayName,
  duplicateCodes,
  exactMatchId,
  formShortcut,
  listShortcut,
  makePrimaryChip,
  minorToInput,
  parseMoneyField,
  primaryFirstCodes,
  removeBarcodeChip,
} from "@/app/(app)/catalog/_lib/form-helpers";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("barcode chips", () => {
  it("adds a trimmed code and reports it", () => {
    expect(addBarcodeChip([], " 6221234567890 ")).toEqual({
      codes: ["6221234567890"],
      error: null,
      added: "6221234567890",
    });
  });

  it("ignores blank input", () => {
    expect(addBarcodeChip(["1"], "   ")).toEqual({ codes: ["1"], error: null, added: null });
  });

  it("rejects duplicates in the list or elsewhere in the form (case-sensitive)", () => {
    expect(addBarcodeChip(["A1"], "A1").error).toBe("duplicate");
    expect(addBarcodeChip([], "A1", ["A1"]).error).toBe("duplicate");
    expect(addBarcodeChip(["A1"], "a1").error).toBeNull();
  });

  it("rejects codes with spaces or non-ASCII characters", () => {
    expect(addBarcodeChip([], "12 34").error).toBe("invalid");
    expect(addBarcodeChip([], "١٢٣").error).toBe("invalid");
    expect(addBarcodeChip([], "x".repeat(65)).error).toBe("invalid");
  });

  it("removes a chip and finds cross-list duplicates", () => {
    expect(removeBarcodeChip(["1", "2"], "1")).toEqual(["2"]);
    expect([...duplicateCodes([["1", "2"], ["2"], ["3"]])]).toEqual(["2"]);
  });

  it("makes a chip primary by moving it to the front", () => {
    expect(makePrimaryChip(["1", "2", "3"], "3")).toEqual(["3", "1", "2"]);
    expect(makePrimaryChip(["1", "2"], "1")).toEqual(["1", "2"]);
    expect(makePrimaryChip(["1", "2"], "9")).toEqual(["1", "2"]);
  });

  it("orders stored barcodes primary first, the rest as stored", () => {
    const rows = [
      { code: "a", isPrimary: false },
      { code: "b", isPrimary: false },
      { code: "c", isPrimary: true },
    ];
    expect(primaryFirstCodes(rows)).toEqual(["c", "a", "b"]);
    expect(primaryFirstCodes(rows.map((r) => ({ ...r, isPrimary: false })))).toEqual(["a", "b", "c"]);
    expect(primaryFirstCodes([])).toEqual([]);
  });
});

describe("keyboard shortcuts", () => {
  it("Ctrl/Cmd+S saves, Esc cancels", () => {
    expect(formShortcut(key("s", { ctrlKey: true }))).toBe("save");
    expect(formShortcut(key("S", { metaKey: true }))).toBe("save");
    expect(formShortcut(key("Escape"))).toBe("cancel");
    expect(formShortcut(key("s"))).toBeNull();
    expect(formShortcut(key("s", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("list shortcuts only fire outside inputs", () => {
    expect(listShortcut(key("/"), false)).toBe("focusSearch");
    expect(listShortcut(key("n"), false)).toBe("newProduct");
    expect(listShortcut(key("N"), false)).toBe("newProduct");
    expect(listShortcut(key("n"), true)).toBeNull();
    expect(listShortcut(key("n", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("money fields", () => {
  it("parses major units, including Arabic-Indic digits", () => {
    expect(parseMoneyField("12.50", "EGP", false)).toEqual({ ok: true, value: 1250 });
    expect(parseMoneyField("١٢٫٥٠", "SAR", false)).toEqual({ ok: true, value: 1250 });
  });

  it("treats blank as inherit only when optional", () => {
    expect(parseMoneyField("", "EGP", true)).toEqual({ ok: true, value: null });
    expect(parseMoneyField(" ", "EGP", false)).toEqual({ ok: false });
  });

  it("rejects negatives, extra decimals, text and overflow", () => {
    for (const raw of ["-1", "12.345", "abc", "99999999999"]) {
      expect(parseMoneyField(raw, "EGP", false)).toEqual({ ok: false });
    }
  });

  it("formats minor units for editing", () => {
    expect(minorToInput(1250, "EGP")).toBe("12.50");
    expect(minorToInput(null, "EGP")).toBe("");
  });
});

describe("display and search", () => {
  it("uses the Arabic name in AR with fallback", () => {
    expect(displayName("ar", { name: "Tea", nameAr: "شاي" })).toBe("شاي");
    expect(displayName("ar", { name: "Tea", nameAr: null })).toBe("Tea");
    expect(displayName("en", { name: "Tea", nameAr: "شاي" })).toBe("Tea");
  });

  it("opens an exact SKU match", () => {
    const items = [
      { id: "1", sku: "TEA-10", name: "Tea big", nameAr: null },
      { id: "2", sku: "TEA-1", name: "Tea", nameAr: null },
    ];
    expect(exactMatchId("tea-1", items)).toBe("2");
    expect(exactMatchId("tea", items)).toBeNull();
  });

  it("opens the barcode hit the service puts first", () => {
    const items = [{ id: "9", sku: "MILK-1", name: "Milk", nameAr: "حليب" }];
    expect(exactMatchId("6221234567890", items)).toBe("9");
    expect(exactMatchId("6221234567890", [])).toBeNull();
  });
});

describe("locale cookie", () => {
  it("reads the locale from a cookie string", () => {
    expect(localeFromCookieString("a=1; pos_locale=ar; b=2")).toBe("ar");
    expect(localeFromCookieString("pos_locale=fr")).toBe("en");
    expect(localeFromCookieString("")).toBe("en");
    expect(toLocale(undefined)).toBe("en");
  });
});
