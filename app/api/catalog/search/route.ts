import { browseSellable, searchSellable, SearchSellableQuery } from "@/modules/catalog";
import { apiRoute, json, queryOf } from "../../_lib/route";

/**
 * GET /api/catalog/search?q=&limit= → SellableSummary[] (POS type-to-search; active items, no cost).
 * Without `q`: `categoryId=` or `all=1` browses for the till tiles (business-profiles-spec BP8), `limit` up to 60.
 */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const { q, all, ...browse } = queryOf(request);
  if (q === undefined && (browse.categoryId !== undefined || all === "1")) {
    return json(await browseSellable(tenant, browse));
  }
  const { q: text, limit } = SearchSellableQuery.parse({ q, limit: browse.limit });
  return json(await searchSellable(tenant, text, limit));
});
