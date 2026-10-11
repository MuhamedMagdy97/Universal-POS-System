import { updateCategory, type UpdateCategory } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../_lib/route";

/** PATCH /api/categories/{categoryId} → CategoryDetail (rename / re-parent). */
export const PATCH = apiRoute({}, async (request, { params }: Params<"categoryId">, { tenant, requestId }) => {
  const { categoryId } = await params;
  const input = await bodyFor<typeof UpdateCategory>(request);
  return json(await updateCategory(tenant, categoryId, input, { requestId }));
});
