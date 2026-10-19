import { setInventorySource } from "@/modules/integrations/inventory-sys";
import { apiRoute, bodyFor, json } from "../../../_lib/route";

/** PUT /api/integrations/inventory/source { source: "BUILT_IN" | "EXTERNAL" } (`integrations.manage`). */
export const PUT = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) =>
  json(await setInventorySource(tenant, await bodyFor(request), { requestId })),
);
