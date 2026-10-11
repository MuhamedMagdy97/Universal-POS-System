import { getProduct, updateProduct, type UpdateProduct } from "@/modules/catalog";
import { apiRoute, bodyFor, json, type Params } from "../../_lib/route";

type Ctx = Params<"productId">;

/** GET /api/products/{productId} → ProductDetail. Bad uuid / other tenant → 404. */
export const GET = apiRoute({ permission: "products.read" }, async (_request, { params }: Ctx, { tenant }) => {
  const { productId } = await params;
  return json(await getProduct(tenant, productId));
});

/** PATCH /api/products/{productId} → ProductDetail (+ warnings). */
export const PATCH = apiRoute({}, async (request, { params }: Ctx, { tenant, requestId }) => {
  const { productId } = await params;
  const input = await bodyFor<typeof UpdateProduct>(request);
  return json(await updateProduct(tenant, productId, input, { requestId }));
});
