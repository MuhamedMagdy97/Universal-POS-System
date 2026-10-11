import { describe, expect, it } from "vitest";
import { LOCALES, MESSAGES, dirOf, interpolate, isLocale, t, translator } from "@/lib/i18n";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("EN/AR dictionary", () => {
  it("has identical key sets in every locale", () => {
    const enKeys = Object.keys(MESSAGES.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(enKeys);
    }
  });

  it("has no empty strings and the same placeholders in every locale", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(MESSAGES[locale])) {
        expect(text.trim(), `${locale}:${key}`).not.toBe("");
        expect(placeholders(text), `${locale}:${key}`).toEqual(
          placeholders(MESSAGES.en[key as keyof typeof MESSAGES.en]),
        );
      }
    }
  });

  it("covers the catalog keys the UI needs", () => {
    for (const key of [
      "catalog.nav",
      "catalog.products.column.price",
      "catalog.state.empty.title",
      "catalog.state.noResults",
      "catalog.state.error",
      "catalog.state.forbidden",
      "catalog.form.sku",
      "catalog.archive.action",
      "catalog.restore.action",
      "catalog.form.priceChangeHint",
      "catalog.conflict.skuTaken",
      "catalog.conflict.barcodeTaken",
      "catalog.conflict.itemArchived",
    ]) {
      expect(MESSAGES.en).toHaveProperty([key]);
    }
  });
});

describe("t()", () => {
  it("looks up by locale and fills placeholders", () => {
    expect(t("en", "catalog.nav")).toBe("Catalog");
    expect(t("ar", "catalog.nav")).toBe("الكتالوج");
    expect(t("en", "catalog.conflict.skuTaken", { product: "Tea" })).toBe("SKU already used by Tea");
    expect(t("ar", "catalog.lookup.barcodeNotFound", { code: "622" })).toBe("الباركود 622 غير موجود");
  });

  it("binds a locale with translator()", () => {
    const tr = translator("en");
    expect(tr("catalog.state.noResults", { q: "milk" })).toBe("No match for “milk”");
  });

  it("leaves unknown placeholders visible", () => {
    expect(interpolate("Hi {name} {missing}", { name: "Sara" })).toBe("Hi Sara {missing}");
  });

  it("validates locales and maps direction", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });
});
