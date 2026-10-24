import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { currentProfile, ITEM_WORD_KEYS } from "../_lib/business";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Catalog" sidebar link, shown only with `products.read` (cosmetic: pages and services re-check). */
export async function CatalogNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let canRead = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    canRead = hasPermission(ctx.role, "products.read");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!canRead) return null;
  const word = (await currentProfile())?.itemWord ?? "products";
  return (
    <NavItem
      href="/catalog/products"
      label={translator(locale)(ITEM_WORD_KEYS[word].nav)}
      icon="catalog"
      match="/catalog"
    />
  );
}
