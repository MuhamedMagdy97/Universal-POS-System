import { ArchiveInput, restoreCategory } from "@/modules/catalog";
import { apiRoute, bodyOf, json, type Params } from "../../../_lib/route";

/** POST /api/categories/{categoryId}/restore { expectedUpdatedAt } → CategoryDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"categoryId">, { tenant, requestId }) => {
  const { categoryId } = await params;
  const input = await bodyOf(request, ArchiveInput);
  return json(await restoreCategory(tenant, categoryId, input, { requestId }));
});
