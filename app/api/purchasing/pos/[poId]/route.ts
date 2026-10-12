import { getPurchaseOrder, updatePurchaseOrder, type PoPatch } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/**
 * GET /api/purchasing/pos/{poId} → PoDetail.
 * PATCH /api/purchasing/pos/{poId} { supplierId?, note?, lines? } → PoDetail; only before the first receipt.
 */
export const GET = apiRoute({}, async (_request, { params }: Params<"poId">, { tenant }) => {
  const { poId } = await params;
  return json(await getPurchaseOrder(tenant, poId));
});

export const PATCH = apiRoute({}, async (request, { params }: Params<"poId">, { tenant, requestId }) => {
  const { poId } = await params;
  const body = await bodyFor<typeof PoPatch>(request);
  return json(await updatePurchaseOrder(tenant, poId, body, { requestId }));
});
