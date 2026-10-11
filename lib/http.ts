import "server-only";
import type { z } from "zod";
import { AppError, errorResponse, toErrorBody } from "@/lib/errors";
import { logger, type Logger } from "@/lib/logger";

export const REQUEST_ID_HEADER = "x-request-id";

export function getRequestId(headers: Headers): string {
  return headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
}

export type RouteMeta = { requestId: string; log: Logger };

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
      const { status, body } = toErrorBody(err);
      if (status >= 500) {
        log.error("request failed", { code: body.code, error: err, path: new URL(request.url).pathname });
      } else {
        log.warn("request rejected", { code: body.code, path: new URL(request.url).pathname });
      }
      return errorResponse(err, requestId);
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
