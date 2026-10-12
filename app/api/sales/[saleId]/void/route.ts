import { voidSale, type VoidInput } from "@/modules/sales";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** POST /api/sales/{saleId}/void { reason } → 200 the sale with status VOIDED. Permission and scope are checked inside the service. */
export const POST = apiRoute({}, async (request, { params }: Params<"saleId">, { tenant, requestId }) => {
  const { saleId } = await params;
  const body = await bodyFor<typeof VoidInput>(request);
  const { sale } = await voidSale(tenant, saleId, body, { requestId });
  return json(sale);
});
