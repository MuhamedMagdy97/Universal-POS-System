import { checkInventoryLink } from "@/modules/integrations/inventory-sys";
import { apiRoute, json } from "../../../_lib/route";

/** POST /api/integrations/inventory/check → re-runs the connection check (`integrations.manage`). */
export const POST = apiRoute({}, async (_request, _context: unknown, { tenant, requestId }) =>
  json(await checkInventoryLink(tenant, { requestId })),
);
