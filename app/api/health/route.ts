import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handleRoute } from "@/lib/http";

/** Liveness + database ping. Never cached. */
export const GET = handleRoute(async (_request, _context: unknown, { log }) => {
  await connection();
  const started = Date.now();
  try {
    await getDb().$queryRaw`SELECT 1`;
  } catch (err) {
    log.error("health check: database ping failed", { error: err });
    throw new AppError("DB_UNAVAILABLE", "Database is unavailable");
  }
  return Response.json(
    { status: "ok", db: "up", dbLatencyMs: Date.now() - started, time: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
});
