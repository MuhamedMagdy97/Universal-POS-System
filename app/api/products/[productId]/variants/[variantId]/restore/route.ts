import { type ArchiveInput, restoreVariant } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../../../../_lib/route";

/** POST /api/products/{productId}/variants/{variantId}/restore { expectedUpdatedAt } → VariantDetail. */
export const POST = apiRoute(
  {},
  async (request, { params }: Params<"productId" | "variantId">, { tenant, requestId }) => {
    const { productId, variantId } = await params;
    const input = await bodyFor<typeof ArchiveInput>(request);
    return json(await restoreVariant(tenant, productId, variantId, input, { requestId }));
  },
);
