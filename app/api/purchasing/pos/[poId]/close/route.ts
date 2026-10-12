import { closePurchaseOrder, type CloseInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** POST /api/purchasing/pos/{poId}/close { reason } → PoDetail; closes a partially received PO short. */
export const POST = apiRoute({}, async (request, { params }: Params<"poId">, { tenant, requestId }) => {
  const { poId } = await params;
  const body = await bodyFor<typeof CloseInput>(request);
  return json(await closePurchaseOrder(tenant, poId, body, { requestId }));
});
