import { receivePurchaseOrder, type ReceiptInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/**
 * POST /api/purchasing/pos/{poId}/receipts (Idempotency-Key required) → 201 PoDetail with the new receipt ·
 * 200 replay of the same request. Permission and branch scope are checked inside the service.
 */
export const POST = apiRoute({}, async (request, { params }: Params<"poId">, { tenant, requestId }) => {
  const { poId } = await params;
  const body = await bodyFor<typeof ReceiptInput>(request);
  const { po, receiptId, created } = await receivePurchaseOrder(
    tenant,
    poId,
    request.headers.get("idempotency-key"),
    body,
    { requestId },
  );
  return json({ receiptId, purchaseOrder: po }, created ? 201 : 200);
});
