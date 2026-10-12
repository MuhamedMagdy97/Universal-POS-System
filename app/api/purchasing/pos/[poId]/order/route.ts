import { orderPurchaseOrder } from "@/modules/purchasing";
import { apiRoute, json, type Params } from "../../../../_lib/route";

/** POST /api/purchasing/pos/{poId}/order → PoDetail, DRAFT → ORDERED (purchases.manage). */
export const POST = apiRoute({}, async (_request, { params }: Params<"poId">, { tenant, requestId }) => {
  const { poId } = await params;
  return json(await orderPurchaseOrder(tenant, poId, { requestId }));
});
