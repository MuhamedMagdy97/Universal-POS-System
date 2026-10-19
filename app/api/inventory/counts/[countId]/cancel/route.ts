import { cancelCount } from "@/modules/inventory";
import { apiRoute, noContent, type Params } from "../../../../_lib/route";

/** POST /api/inventory/counts/{countId}/cancel → 204. */
export const POST = apiRoute({}, async (_request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  await cancelCount(tenant, countId, { requestId });
  return noContent();
});
