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

/**
 * Counts one hit on `key` in the current window; null when the limiter itself failed (fail open).
 * The window comes from the database clock, so every server instance agrees on it, and it only
 * moves forward: a late request from the previous window counts in the current one instead of
 * resetting it. RATE_WINDOW_SECONDS is one minute, hence date_trunc('minute').
 */
async function countHit(key: string, log: Logger): Promise<{ count: number; secondsLeft: number } | null> {
  try {
    const rows = await getDb().$queryRaw<{ count: number; secondsLeft: number }[]>`
      INSERT INTO "ApiRateLimit" ("key", "windowStart", "count") VALUES (${key}, date_trunc('minute', now()), 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "ApiRateLimit"."windowStart" >= EXCLUDED."windowStart" THEN "ApiRateLimit"."count" + 1 ELSE 1 END,
        "windowStart" = GREATEST("ApiRateLimit"."windowStart", EXCLUDED."windowStart")
      RETURNING "count", EXTRACT(EPOCH FROM ("windowStart" + interval '1 minute' - now()))::float8 AS "secondsLeft"`;
    return {
      count: Number(rows[0]?.count ?? 0),
      secondsLeft: Number(rows[0]?.secondsLeft ?? RATE_WINDOW_SECONDS),
    };
  } catch (error) {
    log.error("rate limiter unavailable, request allowed", { error });
    return null;
  }
}

const retryAfter = (secondsLeft: number) => Math.min(RATE_WINDOW_SECONDS, Math.max(1, Math.ceil(secondsLeft)));

/**
 * Public forms with no session (shop setup): `limit` hits per minute per client IP, like the
 * Better-Auth sign-up limit. Keys look like `ip:onboarding:203.0.113.7`; the table is shared.
 */
export async function enforceIpRateLimit(scope: string, headers: Headers, limit: number, log: Logger): Promise<void> {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  const hit = await countHit(`ip:${scope}:${ip}`, log);
  if (hit && hit.count > limit) throw rateLimited(retryAfter(hit.secondsLeft));
}

/** Counts this request; throws 429 `RATE_LIMITED` (details.retryAfterSeconds) once the bucket is over its limit. */
export async function enforceRateLimit(ctx: TenantContext, request: Request, log: Logger): Promise<void> {
  const bucket = bucketOf(request);
  const limit = RATE_LIMITS[bucket];
  const hit = await countHit(`${ctx.orgId}:${ctx.userId}:${bucket}`, log);
  if (!hit) return;
  const { count, secondsLeft } = hit;
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
  throw rateLimited(retryAfter(secondsLeft));
}
