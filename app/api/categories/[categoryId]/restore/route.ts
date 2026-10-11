import { type ArchiveInput, restoreCategory } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** POST /api/categories/{categoryId}/restore { expectedUpdatedAt } → CategoryDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"categoryId">, { tenant, requestId }) => {
  const { categoryId } = await params;
  const input = await bodyFor<typeof ArchiveInput>(request);
  return json(await restoreCategory(tenant, categoryId, input, { requestId }));
});
