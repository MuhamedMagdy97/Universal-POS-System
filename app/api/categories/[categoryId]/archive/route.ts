import { ArchiveInput, archiveCategory } from "@/modules/catalog";
import { apiRoute, bodyOf, json, type Params } from "../../../_lib/route";

/** POST /api/categories/{categoryId}/archive { expectedUpdatedAt } → CategoryDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"categoryId">, { tenant, requestId }) => {
  const { categoryId } = await params;
  const input = await bodyOf(request, ArchiveInput);
  return json(await archiveCategory(tenant, categoryId, input, { requestId }));
});
