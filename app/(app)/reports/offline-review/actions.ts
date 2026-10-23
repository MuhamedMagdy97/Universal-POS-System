"use server";
/**
 * Offline review Server Action: a thin adapter over modules/sales. A public POST, so it re-resolves the tenant and
 * relies on the service's permission and branch checks.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth/tenant";
import { getRequestId } from "@/lib/http";
import { markOfflineSaleReviewed } from "@/modules/sales";

export async function markReviewedAction(formData: FormData): Promise<void> {
  const h = await headers();
  const ctx = await requireTenant(h);
  await markOfflineSaleReviewed(ctx, String(formData.get("saleId") ?? ""), { requestId: getRequestId(h) });
  revalidatePath("/reports/offline-review");
}
