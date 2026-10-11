import { createSale, type SaleInput } from "@/modules/sales";
import { apiRoute, bodyFor, json } from "../_lib/route";

/**
 * POST /api/sales (Idempotency-Key required) → 201 new sale · 200 replay of the same request.
 * Permission and branch scope are checked inside the service.
 */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof SaleInput>(request);
  const key = request.headers.get("idempotency-key");
  const { sale, created } = await createSale(tenant, body, key, { requestId });
  return json(sale, created ? 201 : 200);
});
