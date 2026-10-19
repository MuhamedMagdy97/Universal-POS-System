"use server";
/** My account (onboarding O10): change your own password. */
import { headers } from "next/headers";
import type { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { requireTenant } from "@/lib/auth/tenant";
import { unauthenticated, type ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import { changeOwnPassword } from "@/modules/org";
import type { PasswordChangeInput } from "@/modules/org/schemas";

export type AccountResult = { ok: true } | { ok: false; error: ErrorBody };

export async function changePasswordAction(input: z.input<typeof PasswordChangeInput>): Promise<AccountResult> {
  try {
    const h = await headers();
    const session = await getSession(h);
    if (!session) throw unauthenticated();
    const ctx = await requireTenant(h);
    await changeOwnPassword(ctx, input, { keepSessionId: session.session.id, meta: { requestId: getRequestId(h) } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionError(err, "account") };
  }
}
