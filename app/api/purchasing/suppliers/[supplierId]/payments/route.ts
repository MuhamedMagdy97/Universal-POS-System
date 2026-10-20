import { recordSupplierPayment, type PaymentInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/**
 * POST /api/purchasing/suppliers/{supplierId}/payments (Idempotency-Key required) → 201 { paymentId } ·
 * 200 replay of the same request. Permission and scope are checked inside the service.
 */
export const POST = apiRoute({}, async (request, { params }: Params<"supplierId">, { tenant, requestId }) => {
  const { supplierId } = await params;
  const body = await bodyFor<typeof PaymentInput>(request);
  const { paymentId, created } = await recordSupplierPayment(
    tenant,
    supplierId,
    request.headers.get("idempotency-key"),
    body,
    { requestId },
  );
  return json({ paymentId }, created ? 201 : 200);
});
