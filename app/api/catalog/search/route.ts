import { searchSellable, SearchSellableQuery } from "@/modules/catalog";
import { apiRoute, json, queryOf } from "../../_lib/route";

/** GET /api/catalog/search?q=&limit= → SellableSummary[] (POS type-to-search; active items, no cost). */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const { q, limit } = SearchSellableQuery.parse(queryOf(request));
  return json(await searchSellable(tenant, q, limit));
});
