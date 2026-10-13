import "server-only";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import type { TenantContext } from "@/lib/auth/tenant";
import { record } from "@/modules/audit";

/**
 * Business API rate limit (T10 H6–H8): per user per org, fixed 60 s window, counted in
 * PostgreSQL so it holds across server instances. Fails open: a limiter fault is logged and
 * the request goes through, so it can never stop a sale.
 */

export type RateBucket = "read" | "write" | "export";

export const RATE_WINDOW_SECONDS = 60;
export const RATE_LIMITS: Record<RateBucket, number> = { read: 600, write: 120, export: 10 };

/** GET/HEAD are reads, a CSV download is an export, everything else is a write. */
export function bucketOf(request: Request): RateBucket {
  if (request.method !== "GET" && request.method !== "HEAD") return "write";
  return new URL(request.url).searchParams.get("format") === "csv" ? "export" : "read";
}

/** Start of the fixed window containing `now`: the same minute boundary the SQL uses (tests seed rows with it). */
export function windowStartOf(now: Date): Date {
  const ms = RATE_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError("RATE_LIMITED", "Too many requests, try again shortly", { retryAfterSeconds });
}

/** Counts this request; throws 429 `RATE_LIMITED` (details.retryAfterSeconds) once the bucket is over its limit. */
export async function enforceRateLimit(ctx: TenantContext, request: Request, log: Logger): Promise<void> {
  const bucket = bucketOf(request);
  const limit = RATE_LIMITS[bucket];
  let count: number;
  let secondsLeft: number;
  try {
    const key = `${ctx.orgId}:${ctx.userId}:${bucket}`;
    // The window comes from the database clock, so every server instance agrees on it, and it only
    // moves forward: a late request from the previous window counts in the current one instead of
    // resetting it. RATE_WINDOW_SECONDS is one minute, hence date_trunc('minute').
    const rows = await getDb().$queryRaw<{ count: number; secondsLeft: number }[]>`
      INSERT INTO "ApiRateLimit" ("key", "windowStart", "count") VALUES (${key}, date_trunc('minute', now()), 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "ApiRateLimit"."windowStart" >= EXCLUDED."windowStart" THEN "ApiRateLimit"."count" + 1 ELSE 1 END,
        "windowStart" = GREATEST("ApiRateLimit"."windowStart", EXCLUDED."windowStart")
      RETURNING "count", EXTRACT(EPOCH FROM ("windowStart" + interval '1 minute' - now()))::float8 AS "secondsLeft"`;
    count = Number(rows[0]?.count ?? 0);
    secondsLeft = Number(rows[0]?.secondsLeft ?? RATE_WINDOW_SECONDS);
  } catch (error) {
    log.error("rate limiter unavailable, request allowed", { error });
    return;
  }
  if (count <= limit) return;

  if (count === limit + 1) {
    // Audit once per user, bucket and window, not per refused request.
    try {
      await record(getDb(), {
        ctx,
        action: "api.rate_limited",
        entityType: "ApiRateLimit",
        metadata: { bucket, limit, path: new URL(request.url).pathname },
      });
    } catch {
      // A failed audit write must not turn a 429 into a 500.
    }
  }
  throw rateLimited(Math.min(RATE_WINDOW_SECONDS, Math.max(1, Math.ceil(secondsLeft))));
}
