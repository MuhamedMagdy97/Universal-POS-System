import { transferStock, type TransferInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/**
 * POST /api/inventory/transfer → 201 on the first apply, 200 when the same transferId is
 * retried (the original result is replayed and nothing is applied twice).
 */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof TransferInput>(request);
  const result = await transferStock(tenant, input, { requestId });
  return json(result, result.replayed ? 200 : 201);
});
