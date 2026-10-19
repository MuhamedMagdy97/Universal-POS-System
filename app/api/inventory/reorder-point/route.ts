import { setReorderPoint, type ReorderPointInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** POST /api/inventory/reorder-point { branchId, ref, reorderPoint | null } → 200 { reorderPoint }. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof ReorderPointInput>(request);
  return json(await setReorderPoint(tenant, input, { requestId }));
});
