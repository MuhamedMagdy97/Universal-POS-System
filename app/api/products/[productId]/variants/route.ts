import { createVariant, CreateVariant } from "@/modules/catalog";
import { apiRoute, bodyOf, json, type Params } from "../../../_lib/route";

/** POST /api/products/{productId}/variants → 201 VariantDetail (+ warnings). */
export const POST = apiRoute({}, async (request, { params }: Params<"productId">, { tenant, requestId }) => {
  const { productId } = await params;
  const input = await bodyOf(request, CreateVariant);
  return json(await createVariant(tenant, productId, input, { requestId }), 201);
});
