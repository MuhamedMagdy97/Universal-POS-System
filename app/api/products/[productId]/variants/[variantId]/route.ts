import { updateVariant, type UpdateVariant } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** PATCH /api/products/{productId}/variants/{variantId} → VariantDetail (+ warnings). */
export const PATCH = apiRoute(
  {},
  async (request, { params }: Params<"productId" | "variantId">, { tenant, requestId }) => {
    const { productId, variantId } = await params;
    const input = await bodyFor<typeof UpdateVariant>(request);
    return json(await updateVariant(tenant, productId, variantId, input, { requestId }));
  },
);
