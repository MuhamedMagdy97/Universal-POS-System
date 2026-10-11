/**
 * Shapes the catalog forms send to the Server Actions (client-safe types only).
 * The actions treat every payload as untrusted and re-parse each part with the
 * modules/catalog zod schemas.
 */
import type { CategoryDetail } from "@/modules/catalog/categories";
import type { CatalogWarning } from "@/modules/catalog/rules";
import type { ProductDetail, VariantDetail, VatCategory } from "@/modules/catalog/schemas";

export type VariantDraftPayload = {
  /** Present for an existing variant. */
  id?: string;
  expectedUpdatedAt?: string;
  sku: string;
  name: string;
  nameAr: string | null;
  /** `null` = inherit the product price. */
  priceMinor: number | null;
  /** Omitted when the user cannot see cost; `null` = inherit. */
  costMinor?: number | null;
  barcodes: string[];
};

export type ProductFieldsPayload = {
  sku: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  priceMinor: number;
  /** Omitted when the user cannot see cost. */
  costMinor?: number;
  vatCategory: VatCategory;
};

export type CreateProductPayload = {
  product: ProductFieldsPayload & { unitType: "EACH" };
  barcodes: string[];
  variants: VariantDraftPayload[];
};

export type UpdateProductPayload = {
  product: ProductFieldsPayload & { expectedUpdatedAt: string };
  /** Desired product-level barcodes (first = primary); the action adds/removes the difference. */
  barcodes: string[];
  variants: VariantDraftPayload[];
};

export type SavedProduct = { product: ProductDetail; warnings: CatalogWarning[] };

export type CategoryPayload = { name: string; nameAr: string | null; parentId: string | null };

export type { CategoryDetail, ProductDetail, VariantDetail };
