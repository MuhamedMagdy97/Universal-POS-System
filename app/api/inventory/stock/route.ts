import { StockQuery, listStock } from "@/modules/inventory";
import { apiRoute, json, queryOf, validInput } from "../../_lib/route";

/** GET /api/inventory/stock?branchId&q&filter&cursor&limit → Page<StockRow> (no cost). */
export const GET = apiRoute({ permission: "inventory.read" }, async (request, _context: unknown, { tenant }) => {
  const query = validInput(StockQuery, queryOf(request));
  return json(await listStock(tenant, query));
});
