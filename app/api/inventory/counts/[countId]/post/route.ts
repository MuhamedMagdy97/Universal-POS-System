import { postCount } from "@/modules/inventory";
import { apiRoute, json, type Params } from "../../../../_lib/route";

/** POST /api/inventory/counts/{countId}/post → 201 { lines, totalDelta, replayed }; 200 when already posted. */
export const POST = apiRoute({}, async (_request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  const result = await postCount(tenant, countId, { requestId });
  return json(result, result.replayed ? 200 : 201);
});
