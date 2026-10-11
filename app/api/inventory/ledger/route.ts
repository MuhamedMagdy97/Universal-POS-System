import { LedgerQuery, getItemLedger } from "@/modules/inventory";
import { apiRoute, json, queryOf, validInput } from "../../_lib/route";

/** GET /api/inventory/ledger?branchId&productId&variantId&cursor&limit → { qty, rows, nextCursor }. */
export const GET = apiRoute({ permission: "inventory.read" }, async (request, _context: unknown, { tenant }) => {
  const query = validInput(LedgerQuery, queryOf(request));
  return json(await getItemLedger(tenant, query));
});
