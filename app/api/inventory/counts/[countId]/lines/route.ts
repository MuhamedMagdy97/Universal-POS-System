import { recordCountEntry, type CountEntryInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** POST /api/inventory/counts/{countId}/lines { ref, add? | set? } → { countedQty }. */
export const POST = apiRoute({}, async (request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  const input = await bodyFor<typeof CountEntryInput>(request);
  return json(await recordCountEntry(tenant, countId, input, { requestId }));
});
