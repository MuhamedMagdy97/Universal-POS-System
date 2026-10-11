import "server-only";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { Permission } from "@/lib/auth/permissions";
import { AppError } from "@/lib/errors";
import { handleRoute, type RouteMeta } from "@/lib/http";

/**
 * Shared plumbing for tenant-scoped JSON Route Handlers (catalog-api-and-rules.md §1).
 *
 * Every response — success or error envelope — carries `cache-control: no-store`:
 * tenant data must never be stored by a browser or shared cache.
 */

export type ApiMeta = RouteMeta & { tenant: TenantContext };

/** Dynamic segment params arrive as a Promise in this Next.js version. */
export type Params<K extends string> = { params: Promise<Record<K, string>> };

type ApiOptions = {
  /**
   * Checked by `requireTenant` before the handler runs. Write routes leave it
   * unset: the catalog service checks the permission itself and audit-logs a
   * denied write attempt (C-14), which an early 403 here would skip.
   */
  permission?: Permission;
};

const NO_STORE = "no-store";

export function apiRoute<Ctx>(
  options: ApiOptions,
  handler: (request: Request, context: Ctx, meta: ApiMeta) => Promise<Response>,
): (request: Request, context: Ctx) => Promise<Response> {
  const wrapped = handleRoute<Ctx>(async (request, context, meta) => {
    const tenant = await requireTenant(request.headers, { permission: options.permission });
    return handler(request, context, { ...meta, tenant });
  });
  return async (request, context) => {
    const response = await wrapped(request, context);
    response.headers.set("cache-control", NO_STORE);
    return response;
  };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": NO_STORE } });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": NO_STORE } });
}

/**
 * The request's query string as a plain object, ready for a strict zod schema.
 * Empty values (`?q=`) are dropped so an empty search box means "no filter".
 * Unknown keys are kept, so the strict schema rejects them with a 422.
 */
export function queryOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (value !== "") out[key] = value;
  }
  return out;
}

/**
 * Validate `raw` against `schema` (ZodError → 422) and hand back the raw value
 * typed as the schema's input. Services re-parse their own input, so passing the
 * untransformed value keeps transforms (e.g. cursor decoding) from running twice,
 * and any filter later added to the schema flows through without handler changes.
 */
export function validInput<S extends z.ZodType>(schema: S, raw: unknown): z.input<S> {
  schema.parse(raw);
  return raw as z.input<S>;
}

/**
 * JSON body for a catalog write (bad JSON → 422). It is deliberately not
 * validated here: the service checks the permission first (403, audit-logged
 * per C-14) and only then parses with the same strict schema `S` (422), so an
 * unauthorised caller always gets 403 whatever it sends.
 */
export async function bodyFor<S extends z.ZodType>(request: Request): Promise<z.input<S>> {
  try {
    return (await request.json()) as z.input<S>;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body must be valid JSON");
  }
}
