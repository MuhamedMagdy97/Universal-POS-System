import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { MAX_STORABLE_MINOR } from "@/lib/money";
import { toErrorBody } from "@/lib/errors";
import {
  AddBarcode,
  ArchiveInput,
  BarcodeCode,
  CreateCategory,
  CreateProduct,
  CreateProductAggregate,
  CreateVariant,
  ListProductsQuery,
  Minor,
  Name,
  Sku,
  UNIT_NOT_SUPPORTED,
  UpdateProduct,
  UpdateVariant,
  decodeCursor,
  encodeCursor,
  majorPrice,
} from "@/modules/catalog";

const validProduct = { sku: "ABC-1", name: "Cola 330ml", priceMinor: 1250 };
const now = new Date().toISOString();

function issuePaths(result: { success: boolean; error?: ZodError }): string[] {
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("Sku", () => {
  it("trims, collapses whitespace and upper-cases", () => {
    expect(Sku.parse("  abc-1/x.y_z  ")).toBe("ABC-1/X.Y_Z");
  });

  it("rejects characters outside [A-Z0-9._/-], including inner spaces", () => {
    for (const bad of ["AB C", "AB\tC", "A+B", "قلم", "A#1", "A,B"]) {
      expect(Sku.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("enforces 1–64 characters (C-29: empty after trim)", () => {
    expect(Sku.safeParse("").success).toBe(false);
    expect(Sku.safeParse("   ").success).toBe(false);
    expect(Sku.safeParse("A".repeat(64)).success).toBe(true);
    expect(Sku.safeParse("A".repeat(65)).success).toBe(false);
  });
});

describe("BarcodeCode", () => {
  it("trims but never case-folds", () => {
    expect(BarcodeCode.parse("  abc123XYZ \n")).toBe("abc123XYZ");
  });

  it("accepts printable ASCII only, no spaces", () => {
    expect(BarcodeCode.safeParse("6221234567890").success).toBe(true);
    expect(BarcodeCode.safeParse("!~#$%").success).toBe(true);
    for (const bad of ["622 123", "٦٢٢١", "abc\u0007", "é123", ""]) {
      expect(BarcodeCode.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("enforces a 64-character maximum", () => {
    expect(BarcodeCode.safeParse("1".repeat(64)).success).toBe(true);
    expect(BarcodeCode.safeParse("1".repeat(65)).success).toBe(false);
  });
});

describe("Name", () => {
  it("trims and NFC-normalises", () => {
    expect(Name.parse("  Café ")).toBe("Café");
  });

  it("rejects empty after trim and over 120 characters (C-29)", () => {
    expect(Name.safeParse("   ").success).toBe(false);
    expect(Name.safeParse("x".repeat(120)).success).toBe(true);
    expect(Name.safeParse("x".repeat(121)).success).toBe(false);
  });
});

describe("Minor (C-28)", () => {
  it("accepts 0 and the storable maximum", () => {
    expect(Minor.parse(0)).toBe(0);
    expect(Minor.parse(MAX_STORABLE_MINOR)).toBe(MAX_STORABLE_MINOR);
  });

  it("rejects negatives, fractions, overflow, NaN and strings", () => {
    for (const bad of [-1, 12.5, MAX_STORABLE_MINOR + 1, Number.NaN, Number.POSITIVE_INFINITY, "1250"]) {
      expect(Minor.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe("majorPrice (C-28)", () => {
  const egp = majorPrice("EGP");

  it("parses a decimal string into minor units", () => {
    expect(egp.parse("12.50")).toBe(1250);
    expect(egp.parse(" 0 ")).toBe(0);
  });

  it("rejects too many decimals, negatives, garbage and overflow", () => {
    for (const bad of ["12.345", "-1", "abc", "", "21474836.48"]) {
      const result = egp.safeParse(bad);
      expect(result.success, bad).toBe(false);
    }
    expect(egp.safeParse("21474836.47").success).toBe(true);
  });
});

describe("CreateProduct", () => {
  it("applies defaults", () => {
    expect(CreateProduct.parse(validProduct)).toEqual({
      sku: "ABC-1",
      name: "Cola 330ml",
      categoryId: null,
      unitType: "EACH",
      priceMinor: 1250,
      costMinor: 0,
      vatCategory: "STANDARD",
      barcodes: [],
    });
  });

  it("rejects unknown keys such as orgId, id, isActive and vatApplicable", () => {
    for (const key of ["orgId", "id", "isActive", "vatApplicable", "updatedAt"]) {
      const result = CreateProduct.safeParse({ ...validProduct, [key]: "x" });
      expect(result.success, key).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("accepts KG, but not a KG product with variants (weighed-selling-spec W4)", () => {
    expect(CreateProduct.parse({ ...validProduct, unitType: "KG" }).unitType).toBe("KG");
    const result = CreateProductAggregate.safeParse({
      ...validProduct,
      unitType: "KG",
      variants: [{ sku: "RICE-1KG", name: "1 kg bag" }],
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["unitType"]);
    expect(issue?.message).toBe(UNIT_NOT_SUPPORTED);
  });

  it("rejects an unknown unit and an unknown VAT category", () => {
    expect(CreateProduct.safeParse({ ...validProduct, unitType: "LITRE" }).success).toBe(false);
    expect(CreateProduct.safeParse({ ...validProduct, vatCategory: "REDUCED" }).success).toBe(false);
    expect(CreateProduct.parse({ ...validProduct, vatCategory: "EXEMPT" }).vatCategory).toBe("EXEMPT");
  });

  it("reports empty name and SKU per field (C-29)", () => {
    const result = CreateProduct.safeParse({ ...validProduct, sku: "  ", name: " " });
    expect(issuePaths(result)).toEqual(expect.arrayContaining(["sku", "name"]));
  });

  it("rejects bad money per field (C-28)", () => {
    expect(issuePaths(CreateProduct.safeParse({ ...validProduct, priceMinor: -1 }))).toEqual(["priceMinor"]);
    expect(issuePaths(CreateProduct.safeParse({ ...validProduct, costMinor: 1.5 }))).toEqual(["costMinor"]);
    expect(issuePaths(CreateProduct.safeParse({ ...validProduct, priceMinor: MAX_STORABLE_MINOR + 1 }))).toEqual([
      "priceMinor",
    ]);
  });

  it("rejects duplicate barcodes in one payload (C-19)", () => {
    const result = CreateProduct.safeParse({ ...validProduct, barcodes: ["111", "222", " 111 "] });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(["barcodes.2"]);
  });

  it("treats barcodes differing only by case as distinct", () => {
    expect(CreateProduct.parse({ ...validProduct, barcodes: ["abc", "ABC"] }).barcodes).toEqual(["abc", "ABC"]);
  });

  it("caps barcodes at 10", () => {
    const barcodes = Array.from({ length: 11 }, (_, i) => `CODE${i}`);
    expect(CreateProduct.safeParse({ ...validProduct, barcodes }).success).toBe(false);
  });

  it("maps to a 422 envelope through toErrorBody", () => {
    const result = CreateProduct.safeParse({ ...validProduct, orgId: randomUUID() });
    const { status, body } = toErrorBody(result.error);
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_FAILED");
  });
});

describe("UpdateProduct", () => {
  it("requires expectedUpdatedAt as an ISO datetime", () => {
    expect(UpdateProduct.safeParse({ priceMinor: 100 }).success).toBe(false);
    expect(UpdateProduct.safeParse({ priceMinor: 100, expectedUpdatedAt: "yesterday" }).success).toBe(false);
    expect(UpdateProduct.parse({ priceMinor: 100, expectedUpdatedAt: now })).toEqual({
      priceMinor: 100,
      expectedUpdatedAt: now,
    });
  });

  it("does not apply create-time defaults to omitted fields", () => {
    const parsed = UpdateProduct.parse({ name: "New", expectedUpdatedAt: now });
    expect(parsed).not.toHaveProperty("costMinor");
    expect(parsed).not.toHaveProperty("categoryId");
    expect(parsed).not.toHaveProperty("vatCategory");
  });

  it("rejects unitType and barcodes (immutable / separate endpoint)", () => {
    expect(UpdateProduct.safeParse({ unitType: "EACH", expectedUpdatedAt: now }).success).toBe(false);
    expect(UpdateProduct.safeParse({ barcodes: [], expectedUpdatedAt: now }).success).toBe(false);
  });

  it("upper-cases a new SKU", () => {
    expect(UpdateProduct.parse({ sku: "new-sku", expectedUpdatedAt: now }).sku).toBe("NEW-SKU");
  });
});

describe("variants", () => {
  it("defaults price and cost to null (inherit)", () => {
    const parsed = CreateVariant.parse({ sku: "abc-1-red", name: "Red" });
    expect(parsed).toMatchObject({ sku: "ABC-1-RED", priceMinor: null, costMinor: null, barcodes: [] });
  });

  it("accepts an override and an explicit null on update", () => {
    expect(CreateVariant.parse({ sku: "V1", name: "Big", priceMinor: 999 }).priceMinor).toBe(999);
    const update = UpdateVariant.parse({ priceMinor: null, expectedUpdatedAt: now });
    expect(update.priceMinor).toBeNull();
    expect(update).not.toHaveProperty("costMinor");
  });

  it("rejects negative overrides and productId in the body", () => {
    expect(CreateVariant.safeParse({ sku: "V1", name: "Big", costMinor: -5 }).success).toBe(false);
    expect(CreateVariant.safeParse({ sku: "V1", name: "Big", productId: randomUUID() }).success).toBe(false);
  });
});

describe("categories, barcodes, archive", () => {
  it("creates a root category by default", () => {
    expect(CreateCategory.parse({ name: " Drinks " })).toEqual({ name: "Drinks", parentId: null });
    expect(CreateCategory.safeParse({ name: "Drinks", parentId: "not-a-uuid" }).success).toBe(false);
  });

  it("validates AddBarcode with defaults", () => {
    const productId = randomUUID();
    expect(AddBarcode.parse({ code: " 6221 ", productId })).toEqual({
      code: "6221",
      productId,
      variantId: null,
      isPrimary: false,
    });
    expect(AddBarcode.safeParse({ code: "6221", productId, orgId: randomUUID() }).success).toBe(false);
  });

  it("archive input is strict and requires expectedUpdatedAt", () => {
    expect(ArchiveInput.parse({ expectedUpdatedAt: now })).toEqual({ expectedUpdatedAt: now });
    expect(ArchiveInput.safeParse({}).success).toBe(false);
    expect(ArchiveInput.safeParse({ expectedUpdatedAt: now, isActive: false }).success).toBe(false);
  });
});

describe("ListProductsQuery", () => {
  it("applies defaults", () => {
    expect(ListProductsQuery.parse({})).toEqual({ status: "active", limit: 25, sort: "name" });
  });

  it("coerces limit from a query-string value and bounds it", () => {
    expect(ListProductsQuery.parse({ limit: "50" }).limit).toBe(50);
    for (const bad of ["0", "101", "abc", "2.5"]) {
      expect(ListProductsQuery.safeParse({ limit: bad }).success, bad).toBe(false);
    }
  });

  it("validates q, status, sort and rejects unknown params", () => {
    expect(ListProductsQuery.safeParse({ q: "   " }).success).toBe(false);
    expect(ListProductsQuery.safeParse({ q: "x".repeat(65) }).success).toBe(false);
    expect(ListProductsQuery.safeParse({ status: "deleted" }).success).toBe(false);
    expect(ListProductsQuery.safeParse({ sort: "price" }).success).toBe(false);
    expect(ListProductsQuery.safeParse({ orgId: randomUUID() }).success).toBe(false);
  });

  it("decodes a cursor and rejects garbage with a validation issue", () => {
    const id = randomUUID();
    expect(ListProductsQuery.parse({ cursor: encodeCursor("Cola", id) }).cursor).toEqual({ sortKey: "Cola", id });
    const result = ListProductsQuery.safeParse({ cursor: "%%%garbage" });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(["cursor"]);
  });
});

describe("cursor codec", () => {
  it("round-trips sort keys including Arabic and timestamps", () => {
    const id = randomUUID();
    for (const sortKey of ["Cola 330ml", "قهوة عربية", now, ""]) {
      const encoded = encodeCursor(sortKey, id);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(encoded)).toEqual({ sortKey, id });
    }
  });

  it("throws a ZodError (not a raw exception) for garbage", () => {
    const garbage = [
      "",
      "not base64!",
      "AAAA",
      Buffer.from("{not json").toString("base64url"),
      Buffer.from(JSON.stringify({ k: "x", id: "nope" })).toString("base64url"),
      Buffer.from(JSON.stringify({ k: "x", id: randomUUID(), extra: 1 })).toString("base64url"),
      Buffer.from([0xff, 0xfe]).toString("base64url"),
    ];
    for (const value of garbage) {
      expect(() => decodeCursor(value), value).toThrow(ZodError);
    }
  });
});
