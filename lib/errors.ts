import { ZodError } from "zod";

/**
 * Uniform API error envelope: `{ code, message, details }`.
 * See docs/architecture/api-contracts.md.
 */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DB_UNAVAILABLE: 503,
  // A shop linked to the inventory system cannot reach it (integration spec I17): the sale was not made.
  INVENTORY_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  details: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export const unauthenticated = () => new AppError("UNAUTHENTICATED", "Authentication required");
export const forbidden = (message = "You do not have access to this resource") => new AppError("FORBIDDEN", message);
/** Use for cross-tenant access too: callers must not learn the record exists elsewhere. */
export const notFound = (entity = "Resource") => new AppError("NOT_FOUND", `${entity} not found`);

type PrismaKnownError = { name: string; code: string; meta?: Record<string, unknown> };

function isPrismaKnownError(err: unknown): err is PrismaKnownError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** Map any thrown value to a status + envelope. Unknown errors never leak internals. */
export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return { status: err.status, body: { code: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof ZodError) {
    return {
      status: ERROR_STATUS.VALIDATION_FAILED,
      body: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    };
  }
  if (isPrismaKnownError(err)) {
    if (err.code === "P2002") {
      return {
        status: ERROR_STATUS.CONFLICT,
        body: { code: "CONFLICT", message: "A record with these values already exists", details: null },
      };
    }
    if (err.code === "P2003" || err.code === "P2025") {
      return {
        status: ERROR_STATUS.NOT_FOUND,
        body: { code: "NOT_FOUND", message: "Referenced record not found", details: null },
      };
    }
  }
  return {
    status: ERROR_STATUS.INTERNAL,
    body: { code: "INTERNAL", message: "An unexpected error occurred", details: null },
  };
}

export function errorResponse(err: unknown, requestId?: string): Response {
  return envelopeResponse(toErrorBody(err), requestId);
}

/** The JSON response for an already-mapped failure. */
export function envelopeResponse({ status, body }: { status: number; body: ErrorBody }, requestId?: string): Response {
  const headers: Record<string, string> = {};
  if (requestId) headers["x-request-id"] = requestId;
  const retryAfter = (body.details as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (body.code === "RATE_LIMITED" && typeof retryAfter === "number") headers["retry-after"] = String(retryAfter);
  return Response.json(body, { status, headers });
}
