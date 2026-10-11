import { createProduct, type CreateProduct, listProducts, ListProductsQuery } from "@/modules/catalog";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../_lib/route";

/** GET /api/products?q&categoryId&status&limit&cursor&sort → Page<ProductSummary>. */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const query = validInput(ListProductsQuery, queryOf(request));
  return json(await listProducts(tenant, query));
});

/** POST /api/products → 201 ProductDetail (+ warnings). */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof CreateProduct>(request);
  return json(await createProduct(tenant, input, { requestId }), 201);
});
