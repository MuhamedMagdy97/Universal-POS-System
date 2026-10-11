import { describe, expect, it } from "vitest";
import { translator } from "@/lib/i18n";
import type { ErrorBody } from "@/lib/errors";
import { mapErrorBody, normalizeFieldPath, scopeError } from "@/app/(app)/catalog/_lib/form-errors";

const tr = translator("en");

describe("normalizeFieldPath", () => {
  it("turns bracket indexes into dotted paths", () => {
    expect(normalizeFieldPath("barcodes[0]")).toBe("barcodes.0");
    expect(normalizeFieldPath("variants[1].sku")).toBe("variants.1.sku");
    expect(normalizeFieldPath("sku")).toBe("sku");
  });
});

describe("scopeError", () => {
  it("prefixes zod issue paths", () => {
    const body: ErrorBody = {
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      details: [{ path: "sku", code: "too_small", message: "x" }],
    };
    expect(scopeError(body, "variants.2").details).toEqual([
      { path: "variants.2.sku", code: "too_small", message: "x" },
    ]);
  });

  it("prefixes or overrides details.field", () => {
    const body: ErrorBody = {
      code: "CONFLICT",
      message: "m",
      details: { reason: "BARCODE_TAKEN", field: "barcodes[1]" },
    };
    expect(scopeError(body, "variants.0")).toMatchObject({ details: { field: "variants.0.barcodes.1" } });
    const addBody: ErrorBody = { code: "CONFLICT", message: "m", details: { reason: "BARCODE_TAKEN", field: "code" } };
    expect(scopeError(addBody, "barcodes", "barcodes.3")).toMatchObject({ details: { field: "barcodes.3" } });
  });

  it("leaves bodies without fields alone", () => {
    const body: ErrorBody = { code: "FORBIDDEN", message: "no", details: null };
    expect(scopeError(body, "variants.0")).toBe(body);
  });
});

describe("mapErrorBody", () => {
  it("maps zod issues to field messages with a summary", () => {
    const result = mapErrorBody(
      {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: [
          { path: "name", code: "too_small", message: "" },
          { path: "sku", code: "invalid_format", message: "" },
          { path: "barcodes.1", code: "custom", message: "Duplicate barcode in request" },
          { path: "variants.0.priceMinor", code: "too_big", message: "" },
        ],
      },
      tr,
    );
    expect(result.fields).toEqual({
      name: tr("catalog.form.error.required"),
      sku: tr("catalog.form.error.skuInvalid"),
      "barcodes.1": tr("catalog.conflict.barcodeDuplicateInForm"),
      "variants.0.priceMinor": tr("catalog.form.error.invalidAmount"),
    });
    expect(result.summary).toBe(tr("catalog.form.errorSummary"));
    expect(result.stale).toBe(false);
  });

  it("names the holder of a taken SKU or barcode", () => {
    const sku = mapErrorBody(
      { code: "CONFLICT", message: "m", details: { reason: "SKU_TAKEN", field: "sku", existingName: "Tea" } },
      tr,
    );
    expect(sku.fields.sku).toBe("SKU already used by Tea");
    const barcode = mapErrorBody(
      { code: "CONFLICT", message: "m", details: { reason: "BARCODE_TAKEN", field: "barcodes[2]", existingId: null } },
      tr,
    );
    expect(barcode.fields["barcodes.2"]).toBe("Barcode already assigned to another product");
  });

  it("flags stale writes", () => {
    const result = mapErrorBody({ code: "CONFLICT", message: "m", details: { reason: "STALE_WRITE" } }, tr);
    expect(result.stale).toBe(true);
    expect(result.summary).toBe(tr("catalog.conflict.staleWrite"));
  });

  it("maps catalog validation reasons onto their field", () => {
    const result = mapErrorBody(
      { code: "VALIDATION_FAILED", message: "m", details: { reason: "CATEGORY_INACTIVE", field: "categoryId" } },
      tr,
    );
    expect(result.fields.categoryId).toBe(tr("catalog.form.error.categoryInactive"));
  });

  it("uses a summary when there is no field", () => {
    expect(
      mapErrorBody(
        { code: "CONFLICT", message: "m", details: { reason: "CATEGORY_HAS_ACTIVE_CHILDREN", count: 2 } },
        tr,
      ).summary,
    ).toBe(tr("catalog.conflict.categoryHasChildren"));
    expect(mapErrorBody({ code: "FORBIDDEN", message: "m", details: null }, tr).summary).toBe(
      tr("catalog.form.error.forbidden"),
    );
    expect(mapErrorBody({ code: "INTERNAL", message: "m", details: null }, tr).summary).toBe(
      tr("catalog.form.error.generic"),
    );
  });
});
