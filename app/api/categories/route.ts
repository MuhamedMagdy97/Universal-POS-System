import { createCategory, CreateCategory, listCategories, ListCategoriesQuery } from "@/modules/catalog";
import { apiRoute, bodyOf, json, queryOf, validInput } from "../_lib/route";

/** GET /api/categories?status → CategoryNode[] (the whole tree; no cursor). */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const query = validInput(ListCategoriesQuery, queryOf(request));
  return json(await listCategories(tenant, query));
});

/** POST /api/categories → 201 CategoryDetail. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyOf(request, CreateCategory);
  return json(await createCategory(tenant, input, { requestId }), 201);
});
