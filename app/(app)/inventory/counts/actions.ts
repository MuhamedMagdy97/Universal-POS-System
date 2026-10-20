"use server";
import { headers } from "next/headers";
import { requireTenant } from "@/lib/auth/tenant";
import { actionError } from "@/lib/http";
import { getCountSheet } from "@/modules/inventory";

/** Read-only: the items for a printed count sheet (inventory.read; the service checks scope). */
export async function countSheetAction(countId: string, showExpected: boolean) {
  try {
    const ctx = await requireTenant(await headers());
    return { ok: true as const, data: await getCountSheet(ctx, countId, { showExpected: showExpected === true }) };
  } catch (err) {
    return { ok: false as const, error: await actionError(err, "inventory") };
  }
}
