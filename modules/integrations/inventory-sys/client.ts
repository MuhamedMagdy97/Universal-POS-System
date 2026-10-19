import "server-only";
import { AppError } from "@/lib/errors";

/**
 * The only code that talks to the inventory system (integration spec I3, I17). Sends the key in
 * `x-api-key`; never logs it, never puts it or an IMS response body in an error.
 * Tests replace the global `fetch`.
 */

export type ImsLink = { baseUrl: string; apiKey: string };

export type ImsFailure = "INVENTORY_UNAVAILABLE" | "INVENTORY_LINK_BROKEN" | "INVENTORY_REJECTED";

const MESSAGES: Record<ImsFailure, string> = {
  INVENTORY_UNAVAILABLE: "Can't reach the inventory system. Try again",
  INVENTORY_LINK_BROKEN: "The inventory system refused the API key or its permissions",
  INVENTORY_REJECTED: "The inventory system refused the request",
};

/** `imsCode` is the IMS's own error code (never its message or body). */
export function imsError(reason: ImsFailure, details: { status?: number; imsCode?: string } = {}): AppError {
  return new AppError("CONFLICT", MESSAGES[reason], { reason, ...details });
}

export const IMS_TIMEOUT_MS = 10_000;

export function imsGet<T>(link: ImsLink, path: string, timeoutMs = IMS_TIMEOUT_MS): Promise<T> {
  return imsFetch<T>(link, path, {}, AbortSignal.timeout(timeoutMs));
}

/**
 * A write (integration spec I12–I15). `idempotencyKey` is derived from the POS document and reused on
 * every retry, so the IMS replays its first answer instead of acting twice (I13).
 */
export function imsPost<T>(
  link: ImsLink,
  path: string,
  body: unknown,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<T> {
  return imsFetch<T>(
    link,
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    },
    signal,
  );
}

async function imsFetch<T>(
  link: ImsLink,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, link.baseUrl), {
      ...init,
      headers: { ...init.headers, "x-api-key": link.apiKey, accept: "application/json" },
      signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw imsError("INVENTORY_UNAVAILABLE");
  }
  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch {
      throw imsError("INVENTORY_UNAVAILABLE", { status: response.status });
    }
  }
  const { imsCode, imsDetails } = await errorOf(response);
  throw classify(response.status, imsCode, imsDetails);
}

/** The IMS `code` and the few `details` the POS acts on (never its message or the whole body). */
async function errorOf(
  response: Response,
): Promise<{ imsCode?: string; imsDetails?: { available?: string; status?: string } }> {
  try {
    const body = (await response.json()) as { code?: unknown; details?: { available?: unknown; status?: unknown } };
    const pick = (value: unknown) => (typeof value === "string" ? value.slice(0, 40) : undefined);
    return {
      imsCode: pick(body.code),
      imsDetails: { available: pick(body.details?.available), status: pick(body.details?.status) },
    };
  } catch {
    return {};
  }
}

/** I17: 401/403 → link broken; 404 → not found; 5xx, 429 and the IMS's catch-all `409 conflict` → unavailable. */
export function classify(
  status: number,
  imsCode?: string,
  imsDetails?: { available?: string; status?: string },
): AppError {
  const details = { status, imsCode, ...(imsDetails && { imsDetails }) };
  if (status === 401 || status === 403) return imsError("INVENTORY_LINK_BROKEN", details);
  if (status === 404)
    return new AppError("NOT_FOUND", "Not found in the inventory system", { reason: "IMS_NOT_FOUND" });
  if (status >= 500 || status === 429 || (status === 409 && imsCode === "conflict")) {
    return imsError("INVENTORY_UNAVAILABLE", details);
  }
  return imsError("INVENTORY_REJECTED", details);
}
