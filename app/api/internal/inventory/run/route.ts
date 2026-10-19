import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { handleRoute } from "@/lib/http";
import { drainPostings } from "@/modules/integrations/inventory-sys";

/**
 * POST /api/internal/inventory/run (integration spec I19): sends every inventory-system posting
 * that is due, for all linked shops. Called by the host scheduler every minute with
 * `x-cron-secret: $CRON_SECRET`; no session. 404 while CRON_SECRET is unset.
 */
export const POST = handleRoute(async (request) => {
  const secret = getConfig().CRON_SECRET;
  if (!secret) throw new AppError("NOT_FOUND", "Not found");
  const given = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError("UNAUTHENTICATED", "Authentication required");
  }
  return Response.json(await drainPostings(), { headers: { "cache-control": "no-store" } });
});
