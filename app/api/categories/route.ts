import { createCategory, type CreateCategory, listCategories, ListCategoriesQuery } from "@/modules/catalog";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../_lib/route";

/** GET /api/categories?status → CategoryNode[] (the whole tree; no cursor). */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const query = validInput(ListCategoriesQuery, queryOf(request));
  return json(await listCategories(tenant, query));
});

/** POST /api/categories → 201 CategoryDetail. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof CreateCategory>(request);
  return json(await createCategory(tenant, input, { requestId }), 201);
});
