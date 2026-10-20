import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { getReceiptSettings, updateReceiptSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { createSale, getReceipt, refundSale, voidSale, type ReceiptDoc } from "@/modules/sales";
import { zatcaAmount, zatcaTimestamp } from "@/modules/sales/zatca";
import { createMember, createProduct, createTenant, expectAppError, testDb } from "./helpers";

/** ZATCA Phase 1 receipt data (docs/planning/zatca/zatca-phase1-spec.md). */

const VAT = "310122393500003";
const KEY = () => `zatca-${randomUUID()}`;

let db: Db;

type Shop = {
  orgId: string;
  branchId: string;
  registerId: string;
  owner: TenantContext;
  manager: TenantContext;
  cashier: TenantContext;
};

async function shop(country: "SA" | "EG"): Promise<Shop> {
  const tenant = await createTenant(db, `Zatca ${country}`);
  if (country === "SA") {
    await db.organization.update({
      where: { id: tenant.org.id },
      data: { countryCode: "SA", currency: "SAR", vatRateBp: 1500, legalName: "متجر الرياض" },
    });
  }
  const s = {
    orgId: tenant.org.id,
    branchId: tenant.branchA.id,
    registerId: tenant.register.id,
    owner: await createMember(db, tenant.org.id, "OWNER"),
    manager: await createMember(db, tenant.org.id, "MANAGER"),
    cashier: await createMember(db, tenant.org.id, "CASHIER"),
  };
  await openShift(s.cashier, { branchId: s.branchId, registerId: s.registerId, openingFloatMinor: 0 });
  return s;
}

async function sell(s: Shop, qty = 2) {
  const product = await createProduct(db, s.orgId);
  await inventory.recordOpeningBalances(s.owner, {
    branchId: s.branchId,
    lines: [{ ref: { productId: product.id, variantId: null }, qty: 10 }],
  });
  const { sale } = await createSale(
    s.cashier,
    {
      branchId: s.branchId,
      registerId: s.registerId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty }],
      payments: [{ method: "CASH" as const, amountMinor: qty * 1000 }],
    },
    KEY(),
  );
  return sale;
}

function fields(base64: string): Record<number, string> {
  const bytes = Buffer.from(base64, "base64");
  const out: Record<number, string> = {};
  for (let i = 0; i < bytes.length; i += 2 + (bytes[i + 1] ?? 0)) {
    out[bytes[i] ?? 0] = bytes.subarray(i + 2, i + 2 + (bytes[i + 1] ?? 0)).toString("utf8");
  }
  return out;
}

function zatcaOf(doc: ReceiptDoc): NonNullable<ReceiptDoc["zatca"]> {
  if (!doc.zatca) throw new Error("expected ZATCA data on the receipt");
  return doc.zatca;
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Saudi VAT number setting", () => {
  it("refuses an invalid VAT number for an SA shop (422) and allows free text for an EG shop", async () => {
    const sa = await shop("SA");
    await expectAppError(updateReceiptSettings(sa.owner, { taxNumber: "300-111-222" }), 422, "INVALID_VAT_NUMBER");
    await expectAppError(updateReceiptSettings(sa.owner, { taxNumber: "210122393500003" }), 422, "INVALID_VAT_NUMBER");
    await updateReceiptSettings(sa.owner, { taxNumber: VAT });
    expect(await getReceiptSettings(sa.owner)).toMatchObject({ taxNumber: VAT, countryCode: "SA" });
    // Clearing it is allowed.
    await updateReceiptSettings(sa.owner, { taxNumber: "" });
    expect((await getReceiptSettings(sa.owner)).taxNumber).toBeNull();

    const eg = await shop("EG");
    await expect(updateReceiptSettings(eg.owner, { taxNumber: "300-111-222" })).resolves.toMatchObject({
      taxNumber: "300-111-222",
    });
  });
});

describe("ZATCA receipt data", () => {
  it("puts the QR on an SA sale, its copy, its refund and its void (credit notes)", async () => {
    const sa = await shop("SA");
    await updateReceiptSettings(sa.owner, { taxNumber: VAT });
    const sale = await sell(sa);

    const receipt = await getReceipt(sa.cashier, sale.id, { kind: "SALE", copy: false });
    expect(receipt.zatca).not.toBeNull();
    expect(fields(zatcaOf(receipt).tlv)).toEqual({
      1: "متجر الرياض",
      2: VAT,
      3: zatcaTimestamp(sale.createdAt),
      4: zatcaAmount(sale.totalMinor),
      5: zatcaAmount(sale.vatMinor),
    });
    expect(zatcaOf(receipt).qr.path).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(zatcaOf(receipt).qr.size).toBeGreaterThanOrEqual(25);

    // A reprint carries the same QR.
    const copy = await getReceipt(sa.manager, sale.id, { kind: "SALE", copy: true });
    expect(copy.zatca?.tlv).toBe(zatcaOf(receipt).tlv);

    const item = await db.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    const { refund } = await refundSale(sa.manager, sale.id, KEY(), {
      lines: [{ saleItemId: item.id, qty: 1 }],
      method: "CASH",
      reason: "Damaged",
    });
    const note = await getReceipt(sa.manager, sale.id, { kind: "REFUND", refundId: refund.id, copy: false });
    expect(fields(zatcaOf(note).tlv)).toMatchObject({
      2: VAT,
      3: zatcaTimestamp(refund.createdAt),
      4: zatcaAmount(refund.totalMinor),
      5: zatcaAmount(refund.vatMinor),
    });

    const other = await sell(sa, 1);
    await voidSale(sa.manager, other.id, { reason: "Mistake" });
    const voidSlip = await getReceipt(sa.manager, other.id, { kind: "VOID", copy: false });
    const voided = await db.sale.findUniqueOrThrow({ where: { id: other.id } });
    expect(fields(zatcaOf(voidSlip).tlv)[3]).toBe(zatcaTimestamp(String(voided.voidedAt?.toISOString())));
  });

  it("leaves the QR off for an SA shop without a valid VAT number and for an EG shop", async () => {
    const sa = await shop("SA");
    const saSale = await sell(sa);
    expect((await getReceipt(sa.cashier, saSale.id, { kind: "SALE", copy: false })).zatca).toBeNull();
    // An older free-text value stored before validation existed still prints no QR.
    await db.organization.update({ where: { id: sa.orgId }, data: { taxNumber: "300-111" } });
    expect((await getReceipt(sa.cashier, saSale.id, { kind: "SALE", copy: false })).zatca).toBeNull();

    const eg = await shop("EG");
    await updateReceiptSettings(eg.owner, { taxNumber: VAT });
    const egSale = await sell(eg);
    expect((await getReceipt(eg.cashier, egSale.id, { kind: "SALE", copy: false })).zatca).toBeNull();
  });
});
