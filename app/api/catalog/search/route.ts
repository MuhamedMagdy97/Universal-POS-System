import { browseSellable, searchSellable, SearchSellableQuery } from "@/modules/catalog";
import { apiRoute, json, queryOf } from "../../_lib/route";

/**
 * GET /api/catalog/search?q=&limit= → SellableSummary[] (POS type-to-search; active items, no cost).
 * Without `q`: `categoryId=` or `all=1` browses for the till tiles (business-profiles-spec BP8), `limit` up to 60.
 * Both schemas are strict, so an unknown parameter is refused (422) either way.
 */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const query = queryOf(request);
  if (query.q === undefined && (query.categoryId !== undefined || query.all === "1")) {
    const { all: _all, ...browse } = query;
    return json(await browseSellable(tenant, browse));
  }
  const { q, limit } = SearchSellableQuery.parse(query);
  return json(await searchSellable(tenant, q, limit));
});
