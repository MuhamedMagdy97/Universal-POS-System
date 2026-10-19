import { LowStockQuery, exportLowStockCsv, listLowStock } from "@/modules/inventory";
import { csvResponse } from "@/modules/reports";
import { apiRoute, json, queryOf, validInput } from "../../_lib/route";

/** GET /api/inventory/low-stock?branchId[&format=csv&locale] → { rows, truncated }, or a CSV download. */
export const GET = apiRoute(
  { permission: "inventory.read" },
  async (request, _context: unknown, { tenant, requestId }) => {
    const { format, locale, ...rest } = queryOf(request);
    const query = validInput(LowStockQuery, rest);
    if (format === "csv") {
      const { filename, body } = await exportLowStockCsv(tenant, query, locale, { requestId });
      return csvResponse(body, filename);
    }
    return json(await listLowStock(tenant, query));
  },
);
