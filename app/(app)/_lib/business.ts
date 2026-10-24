import "server-only";
import { headers } from "next/headers";
import { requireTenant } from "@/lib/auth/tenant";
import { AppError } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";
import { orgBusinessType } from "@/modules/org";
import { profileOf, type BusinessPreset, type ItemWord } from "@/modules/presets";

/** The signed-in shop's business profile (business-profiles-spec §2), or null without a shop. */
export async function currentProfile(): Promise<BusinessPreset | null> {
  try {
    const ctx = await requireTenant(await headers());
    return profileOf(await orgBusinessType(ctx.orgId));
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

/** BP9: what the nav, the products page title and its add button say. "products" keeps "Catalog" in the nav. */
export const ITEM_WORD_KEYS = {
  products: { nav: "catalog.nav", title: "catalog.products.title", add: "catalog.products.add" },
  items: { nav: "catalog.word.items", title: "catalog.word.items", add: "catalog.word.items.add" },
  menuItems: { nav: "catalog.word.menuItems", title: "catalog.word.menuItems", add: "catalog.word.menuItems.add" },
  services: { nav: "catalog.word.services", title: "catalog.word.services", add: "catalog.word.services.add" },
} as const satisfies Record<ItemWord, Record<"nav" | "title" | "add", MessageKey>>;
