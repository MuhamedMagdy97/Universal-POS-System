import { retryInventoryPosting } from "@/modules/integrations/inventory-sys";
import { apiRoute, json, type Params } from "../../../../../_lib/route";

/** POST /api/integrations/inventory/postings/{postingId}/retry → { status } after sending (`settings.manage`). */
export const POST = apiRoute({}, async (_request, { params }: Params<"postingId">, { tenant, requestId }) => {
  const { postingId } = await params;
  return json(await retryInventoryPosting(tenant, postingId, { requestId }));
});
