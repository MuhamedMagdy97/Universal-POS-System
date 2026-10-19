import { addCountItems, removeCountItem, type CountItemInput, type CountItemsInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json, noContent, type Params } from "../../../../_lib/route";

/** POST /api/inventory/counts/{countId}/items { refs } → { items } (chosen-items draft only). */
export const POST = apiRoute({}, async (request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  const input = await bodyFor<typeof CountItemsInput>(request);
  return json(await addCountItems(tenant, countId, input, { requestId }));
});

/** DELETE /api/inventory/counts/{countId}/items { ref } → 204. */
export const DELETE = apiRoute({}, async (request, { params }: Params<"countId">, { tenant, requestId }) => {
  const { countId } = await params;
  const input = await bodyFor<typeof CountItemInput>(request);
  await removeCountItem(tenant, countId, input, { requestId });
  return noContent();
});
