import { refundSale, type RefundInput } from "@/modules/sales";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/**
 * POST /api/sales/{saleId}/refunds (Idempotency-Key required) → 201 new refund · 200 replay of the same request.
 * Permission and branch scope are checked inside the service.
 */
export const POST = apiRoute({}, async (request, { params }: Params<"saleId">, { tenant, requestId }) => {
  const { saleId } = await params;
  const body = await bodyFor<typeof RefundInput>(request);
  const { refund, created } = await refundSale(tenant, saleId, request.headers.get("idempotency-key"), body, {
    requestId,
  });
  return json(refund, created ? 201 : 200);
});
