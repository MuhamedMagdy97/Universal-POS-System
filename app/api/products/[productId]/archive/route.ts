import { type ArchiveInput, archiveProduct } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** POST /api/products/{productId}/archive { expectedUpdatedAt } → ProductDetail. */
export const POST = apiRoute({}, async (request, { params }: Params<"productId">, { tenant, requestId }) => {
  const { productId } = await params;
  const input = await bodyFor<typeof ArchiveInput>(request);
  return json(await archiveProduct(tenant, productId, input, { requestId }));
});
