import { cancelTransfer } from "@/modules/inventory";
import { apiRoute, json, type Params } from "../../../../_lib/route";

/** POST /api/inventory/transfers/{transferId}/cancel → 200 { replayed }. */
export const POST = apiRoute({}, async (_request, { params }: Params<"transferId">, { tenant, requestId }) => {
  const { transferId } = await params;
  return json(await cancelTransfer(tenant, transferId, { requestId }));
});
