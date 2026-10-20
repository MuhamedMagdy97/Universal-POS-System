import { reverseSupplierPayment, type ReversalInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../../../_lib/route";

/**
 * POST /api/purchasing/suppliers/{supplierId}/payments/{paymentId}/reverse { reason } (Idempotency-Key
 * required) → 201 { paymentId } of the reversal · 200 replay.
 */
export const POST = apiRoute(
  {},
  async (request, { params }: Params<"supplierId" | "paymentId">, { tenant, requestId }) => {
    const { supplierId, paymentId } = await params;
    const body = await bodyFor<typeof ReversalInput>(request);
    const result = await reverseSupplierPayment(
      tenant,
      supplierId,
      paymentId,
      request.headers.get("idempotency-key"),
      body,
      { requestId },
    );
    return json({ paymentId: result.paymentId }, result.created ? 201 : 200);
  },
);
