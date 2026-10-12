import { cancelPurchaseOrder, type CancelInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** POST /api/purchasing/pos/{poId}/cancel { reason? } → PoDetail; only before anything is received. */
export const POST = apiRoute({}, async (request, { params }: Params<"poId">, { tenant, requestId }) => {
  const { poId } = await params;
  const body = await bodyFor<typeof CancelInput>(request);
  return json(await cancelPurchaseOrder(tenant, poId, body, { requestId }));
});
