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

export async function imsGet<T>(link: ImsLink, path: string, timeoutMs = IMS_TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, link.baseUrl), {
      headers: { "x-api-key": link.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
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
  const imsCode = await errorCode(response);
  throw classify(response.status, imsCode);
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

/** I17: 401/403 → link broken; 404 → not found; 5xx, 429 and the IMS's catch-all `409 conflict` → unavailable. */
export function classify(status: number, imsCode?: string): AppError {
  const details = { status, imsCode };
  if (status === 401 || status === 403) return imsError("INVENTORY_LINK_BROKEN", details);
  if (status === 404)
    return new AppError("NOT_FOUND", "Not found in the inventory system", { reason: "IMS_NOT_FOUND" });
  if (status >= 500 || status === 429 || (status === 409 && imsCode === "conflict")) {
    return imsError("INVENTORY_UNAVAILABLE", details);
  }
  return imsError("INVENTORY_REJECTED", details);
}
