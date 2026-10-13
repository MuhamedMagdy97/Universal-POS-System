"use server";
/** Receipt settings Server Action (T10 H3): a thin adapter; the service checks `settings.manage`. */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant } from "@/lib/auth/tenant";
import { toErrorBody, type ErrorBody } from "@/lib/errors";
import { getRequestId } from "@/lib/http";
import { updateReceiptSettings, type ReceiptSettings, type ReceiptSettingsInput } from "@/modules/org";

export type SettingsActionResult = { ok: true; data: ReceiptSettings } | { ok: false; error: ErrorBody };

export async function saveReceiptSettingsAction(
  input: z.input<typeof ReceiptSettingsInput>,
): Promise<SettingsActionResult> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await updateReceiptSettings(ctx, input, { requestId: getRequestId(h) });
    revalidatePath("/settings/receipt");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorBody(err).body };
  }
}
