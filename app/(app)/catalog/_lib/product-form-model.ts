/**
 * Product form model (pure, client-safe): form state ⇄ ProductDetail and
 * form state → Server Action payload with client-side validation. Unit-tested
 * in tests/unit/catalog-product-form.test.ts. The server re-validates everything.
 */
import type { CurrencyCode } from "@/lib/money";
import type { ProductDetail, UnitType, VatCategory } from "@/modules/catalog/schemas";
import { minorToInput, parseMoneyField, primaryFirstCodes } from "./form-helpers";
import type { CreateProductPayload, UpdateProductPayload, VariantDraftPayload } from "./payloads";

export type VariantRow = {
  /** Stable React key (the variant id, or a generated one for new rows). */
  key: string;
  id?: string;
  expectedUpdatedAt?: string;
  isActive: boolean;
  sku: string;
  name: string;
  nameAr: string;
  price: string;
  cost: string;
  barcodes: string[];
};

export type ProductFormState = {
  sku: string;
  name: string;
  nameAr: string;
  categoryId: string;
  /** Chosen on create only; KG prices are per kg and a KG product has no variants (weighed-selling-spec W2, W4). */
  unitType: UnitType;
  /** Chosen on create only: a service holds no stock (salon-spec S2); `duration` is minutes, as typed. */
  isService: boolean;
  duration: string;
  vatCategory: VatCategory;
  price: string;
  cost: string;
  barcodes: string[];
  variants: VariantRow[];
};

export function emptyFormState(): ProductFormState {
  return {
    sku: "",
    name: "",
    nameAr: "",
    categoryId: "",
    unitType: "EACH",
    isService: false,
    duration: "30",
    vatCategory: "STANDARD",
    price: "",
    cost: "",
    barcodes: [],
    variants: [],
  };
}

export function emptyVariantRow(key: string): VariantRow {
  return { key, isActive: true, sku: "", name: "", nameAr: "", price: "", cost: "", barcodes: [] };
}

export function formStateFromProduct(product: ProductDetail, currency: CurrencyCode): ProductFormState {
  return {
    sku: product.sku,
    name: product.name,
    nameAr: product.nameAr ?? "",
    categoryId: product.categoryId ?? "",
    unitType: product.unitType,
    isService: product.isService,
    duration: String(product.durationMin ?? 30),
    vatCategory: product.vatCategory,
    price: minorToInput(product.priceMinor, currency),
    cost: minorToInput(product.costMinor, currency),
    barcodes: primaryFirstCodes(product.barcodes.filter((b) => b.variantId === null)),
    variants: product.variants.map((v) => ({
      key: v.id,
      id: v.id,
      expectedUpdatedAt: v.updatedAt,
      isActive: v.isActive,
      sku: v.sku,
      name: v.name,
      nameAr: v.nameAr ?? "",
      price: minorToInput(v.priceMinor, currency),
      cost: minorToInput(v.costMinor, currency),
      barcodes: primaryFirstCodes(product.barcodes.filter((b) => b.variantId === v.id)),
    })),
  };
}

export type BuildResult<P> = { ok: true; payload: P } | { ok: false; fields: Record<string, string> };

export type FieldMessages = { required: string; invalidAmount: string };

type Options = { currency: CurrencyCode; canSeeCost: boolean; messages: FieldMessages };

function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function buildCommon(state: ProductFormState, { currency, canSeeCost, messages }: Options) {
  const fields: Record<string, string> = {};
  if (state.name.trim() === "") fields.name = messages.required;
  if (state.sku.trim() === "") fields.sku = messages.required;

  const price = parseMoneyField(state.price, currency, false);
  if (!price.ok) fields.priceMinor = state.price.trim() === "" ? messages.required : messages.invalidAmount;
  const cost = canSeeCost ? parseMoneyField(state.cost, currency, true) : { ok: true as const, value: null };
  if (!cost.ok) fields.costMinor = messages.invalidAmount;

  const variants: VariantDraftPayload[] = state.variants.map((row, i) => {
    if (row.name.trim() === "") fields[`variants.${i}.name`] = messages.required;
    if (row.sku.trim() === "") fields[`variants.${i}.sku`] = messages.required;
    const vPrice = parseMoneyField(row.price, currency, true);
    if (!vPrice.ok) fields[`variants.${i}.priceMinor`] = messages.invalidAmount;
    const vCost = canSeeCost ? parseMoneyField(row.cost, currency, true) : { ok: true as const, value: null };
    if (!vCost.ok) fields[`variants.${i}.costMinor`] = messages.invalidAmount;
    return {
      ...(row.id ? { id: row.id, expectedUpdatedAt: row.expectedUpdatedAt } : {}),
      sku: row.sku,
      name: row.name,
      nameAr: blankToNull(row.nameAr),
      priceMinor: vPrice.ok ? vPrice.value : null,
      ...(canSeeCost ? { costMinor: vCost.ok ? vCost.value : null } : {}),
      barcodes: row.barcodes,
    };
  });

  const product = {
    sku: state.sku,
    name: state.name,
    nameAr: blankToNull(state.nameAr),
    categoryId: state.categoryId === "" ? null : state.categoryId,
    priceMinor: price.ok ? (price.value ?? 0) : 0,
    // Cost is only sent by users who may see it; blank means 0.
    ...(canSeeCost ? { costMinor: cost.ok ? (cost.value ?? 0) : 0 } : {}),
    vatCategory: state.vatCategory,
  };
  return { fields, product, variants };
}

export function buildCreatePayload(state: ProductFormState, options: Options): BuildResult<CreateProductPayload> {
  const { fields, product, variants } = buildCommon(state, options);
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    payload: {
      product: {
        ...product,
        unitType: state.unitType,
        ...(state.isService && { isService: true, durationMin: durationOf(state.duration) }),
      },
      barcodes: state.barcodes,
      variants,
    },
  };
}

export function buildUpdatePayload(
  state: ProductFormState,
  expectedUpdatedAt: string,
  options: Options,
): BuildResult<UpdateProductPayload> {
  const { fields, product, variants } = buildCommon(state, options);
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    payload: {
      product: {
        ...product,
        // A service's duration can change; whether it is a service cannot (salon-spec S2).
        ...(state.isService && { durationMin: durationOf(state.duration) }),
        expectedUpdatedAt,
      },
      barcodes: state.barcodes,
      variants,
    },
  };
}

/** Live, non-blocking hint: effective price below effective cost (only for users who see cost). */
export function priceBelowCost(state: ProductFormState, currency: CurrencyCode): boolean {
  const price = parseMoneyField(state.price, currency, false);
  const cost = parseMoneyField(state.cost, currency, true);
  if (!price.ok || !cost.ok || price.value === null) return false;
  const productCost = cost.value ?? 0;
  if (price.value < productCost) return true;
  return state.variants.some((row) => {
    const vPrice = parseMoneyField(row.price, currency, true);
    const vCost = parseMoneyField(row.cost, currency, true);
    if (!vPrice.ok || !vCost.ok) return false;
    return (vPrice.value ?? price.value ?? 0) < (vCost.value ?? productCost);
  });
}

/** Every barcode in the form except those of the list at `path` (for in-form duplicate checks). */
export function otherCodesThan(state: ProductFormState, path: string): string[] {
  const lists: [string, string[]][] = [
    ["barcodes", state.barcodes],
    ...state.variants.map((v, i): [string, string[]] => [`variants.${i}.barcodes`, v.barcodes]),
  ];
  return lists.filter(([p]) => p !== path).flatMap(([, codes]) => codes);
}

/** Minutes typed for a service (5-480); anything else is 30. */
export function durationOf(raw: string): number {
  const minutes = Number(raw.trim());
  return Number.isInteger(minutes) && minutes >= 5 && minutes <= 480 ? minutes : 30;
}
