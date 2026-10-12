import { createPurchaseOrder, listPurchaseOrders, PoQuery, type PoInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../../_lib/route";

/**
 * GET /api/purchasing/pos?status&branchId&supplierId&q&cursor → PoPage (open POs by default).
 * POST /api/purchasing/pos → 201 PoDetail, a DRAFT (purchases.manage). Permissions are checked in the service.
 */
export const GET = apiRoute({}, async (request, _context: unknown, { tenant }) => {
  const query = validInput(PoQuery, queryOf(request));
  return json(await listPurchaseOrders(tenant, query));
});

export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof PoInput>(request);
  return json(await createPurchaseOrder(tenant, body, { requestId }), 201);
});
