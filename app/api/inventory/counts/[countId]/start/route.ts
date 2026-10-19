import { startCount } from "@/modules/inventory";
import { apiRoute, noContent, type Params } from "../../../../_lib/route";

/** POST /api/inventory/counts/{countId}/start → 204. */
export const POST = apiRoute({}, async (_request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  await startCount(tenant, countId, { requestId });
  return noContent();
});
