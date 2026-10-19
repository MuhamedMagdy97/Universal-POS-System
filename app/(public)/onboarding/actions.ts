"use server";
/**
 * Shop setup Server Action (onboarding O1, O6, O7). Public: anyone may create a shop, at most
 * five tries per minute per IP. A new owner is signed in straight after; a signed-in user without
 * a shop has their session moved into the new shop by the service.
 */
import { headers } from "next/headers";
import type { z } from "zod";
import { getAuth, LOGIN_RATE_LIMIT } from "@/lib/auth/auth";
import { getSession } from "@/lib/auth/session";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import { logger } from "@/lib/logger";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { createShop } from "@/modules/org";
import type { SetupInput } from "@/modules/org/schemas";

export type SetupResult = { ok: true } | { ok: false; error: ErrorBody };

export async function createShopAction(input: z.input<typeof SetupInput>): Promise<SetupResult> {
  try {
    const h = await headers();
    const requestId = getRequestId(h);
    await enforceIpRateLimit("onboarding", h, LOGIN_RATE_LIMIT.max, logger.child({ requestId }));
    const session = await getSession(h);
    await createShop(input, { signedInUserId: session?.user.id ?? null, meta: { requestId } });
    if (!session && input.account) {
      // nextCookies() sets the session cookie on this action's response. The shop exists by now, so a
      // failed sign-in is not a failed setup: the dashboard then sends the owner to the login page.
      try {
        await getAuth().api.signInEmail({
          body: { email: input.account.email.trim().toLowerCase(), password: input.account.password },
          headers: h,
        });
      } catch (error) {
        logger.child({ requestId }).warn("sign-in after shop setup failed", { error });
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionError(err, "onboarding") };
  }
}
