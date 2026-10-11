import { ArchiveInput, archiveProduct } from "@/modules/catalog";
import { apiRoute, bodyOf, json, type Params } from "../../../_lib/route";

/** POST /api/products/{productId}/archive { expectedUpdatedAt } → ProductDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"productId">, { tenant, requestId }) => {
  const { productId } = await params;
  const input = await bodyOf(request, ArchiveInput);
  return json(await archiveProduct(tenant, productId, input, { requestId }));
});
