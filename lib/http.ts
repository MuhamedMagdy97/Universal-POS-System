import "server-only";
import type { z } from "zod";
import { getDb } from "@/lib/db";
import { AppError, envelopeResponse, ERROR_STATUS, toErrorBody, type ErrorBody } from "@/lib/errors";
import { logger, type Logger } from "@/lib/logger";

export const REQUEST_ID_HEADER = "x-request-id";

export function getRequestId(headers: Headers): string {
  return headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
}

export type RouteMeta = { requestId: string; log: Logger };

const PING_TIMEOUT_MS = 2000;

/** True when the database does not answer `SELECT 1` within 2 s. */
export async function databaseUnreachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
  });
  try {
    const answered = await Promise.race([getDb().$queryRaw`SELECT 1`.then(() => true), timeout]);
    return !answered;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The envelope for a failure. An unexpected error while the database does not
 * answer becomes 503 `DB_UNAVAILABLE`: the cause is often wrapped beyond
 * recognition (Better-Auth reports "Failed to get session"), so it is checked
 * with a ping rather than by matching the error.
 */
export async function failureOf(err: unknown): Promise<{ status: number; body: ErrorBody }> {
  const result = toErrorBody(err);
  if (result.body.code !== "INTERNAL" || !(await databaseUnreachable())) return result;
  return {
    status: ERROR_STATUS.DB_UNAVAILABLE,
    body: { code: "DB_UNAVAILABLE", message: "Database is unavailable", details: null },
  };
}

/**
 * The error body a Server Action returns. Server failures (5xx) are logged with
 * the action's name, like Route Handler failures are.
 */
export async function actionError(err: unknown, action: string, requestId?: string): Promise<ErrorBody> {
  const { status, body } = await failureOf(err);
  if (status >= 500) logger.child({ requestId }).error("action failed", { action, code: body.code, error: err });
  return body;
}

/**
 * Wraps a route handler: attaches a request id, logs failures with context
 * and turns every thrown error into the `{ code, message, details }` envelope.
 */
export function handleRoute<Ctx>(
  handler: (request: Request, context: Ctx, meta: RouteMeta) => Promise<Response>,
): (request: Request, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    const requestId = getRequestId(request.headers);
    const log = logger.child({ requestId });
    try {
      const response = await handler(request, context, { requestId, log });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    } catch (err) {
      const failure = await failureOf(err);
      const { status, body } = failure;
      if (status >= 500) {
        log.error("request failed", { code: body.code, error: err, path: new URL(request.url).pathname });
      } else {
        log.warn("request rejected", { code: body.code, path: new URL(request.url).pathname });
      }
      return envelopeResponse(failure, requestId);
    }
  };
}

/** Parse and validate a JSON body with Zod. Bad JSON or schema → 422. */
export async function parseJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
  return schema.parse(raw);
}
