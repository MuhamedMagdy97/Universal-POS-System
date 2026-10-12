import { createSupplier, listSuppliers, SupplierQuery, type SupplierInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../../_lib/route";

/**
 * GET /api/purchasing/suppliers?q&includeArchived → SupplierRow[] (purchases.manage or purchases.receive).
 * POST /api/purchasing/suppliers → 201 SupplierRow (purchases.manage). Permissions are checked in the service.
 */
export const GET = apiRoute({}, async (request, _context: unknown, { tenant }) => {
  const query = validInput(SupplierQuery, queryOf(request));
  return json(await listSuppliers(tenant, query));
});

export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof SupplierInput>(request);
  return json(await createSupplier(tenant, body, { requestId }), 201);
});
