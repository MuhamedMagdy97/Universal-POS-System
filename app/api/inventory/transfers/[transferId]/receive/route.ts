import { receiveTransfer, type TransferReceiveInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** POST /api/inventory/transfers/{transferId}/receive → 201 { replayed, received, shortfall }; 200 on a replay. */
export const POST = apiRoute({}, async (request, { params }: Params<"transferId">, { tenant, requestId }) => {
  const { transferId } = await params;
  const input = await bodyFor<typeof TransferReceiveInput>(request);
  const result = await receiveTransfer(tenant, transferId, input, { requestId });
  return json(result, result.replayed ? 200 : 201);
});
