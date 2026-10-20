import { allocateSupplierPayment, type AllocationInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../../../_lib/route";

/**
 * POST /api/purchasing/suppliers/{supplierId}/payments/{paymentId}/allocations { allocations } (Idempotency-Key
 * required) → 201 { paymentId } · 200 replay (supplier-invoices-spec I9).
 */
export const POST = apiRoute(
  {},
  async (request, { params }: Params<"supplierId" | "paymentId">, { tenant, requestId }) => {
    const { supplierId, paymentId } = await params;
    const body = await bodyFor<typeof AllocationInput>(request);
    const result = await allocateSupplierPayment(
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
