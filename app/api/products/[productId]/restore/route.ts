import { ArchiveInput, restoreProduct } from "@/modules/catalog";
import { apiRoute, bodyOf, json, type Params } from "../../../_lib/route";

/** POST /api/products/{productId}/restore { expectedUpdatedAt } → ProductDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"productId">, { tenant, requestId }) => {
  const { productId } = await params;
  const input = await bodyOf(request, ArchiveInput);
  return json(await restoreProduct(tenant, productId, input, { requestId }));
});
