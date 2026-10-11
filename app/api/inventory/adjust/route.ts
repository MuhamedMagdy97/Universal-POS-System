import { adjustStock, type AdjustInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** POST /api/inventory/adjust → 201 { qty } (stale expectedOnHand ⇒ 409 STALE_STOCK). */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof AdjustInput>(request);
  return json(await adjustStock(tenant, input, { requestId }), 201);
});
