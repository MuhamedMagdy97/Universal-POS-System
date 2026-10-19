import { getInventoryLinkStatus, saveInventoryLink } from "@/modules/integrations/inventory-sys";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** GET /api/integrations/inventory → link status (`settings.manage`). Never the API key. */
export const GET = apiRoute({}, async (_request, _context: unknown, { tenant }) =>
  json(await getInventoryLinkStatus(tenant)),
);

/** PUT /api/integrations/inventory { baseUrl, apiKey? } → the connection check (`integrations.manage`). */
export const PUT = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) =>
  json(await saveInventoryLink(tenant, await bodyFor(request), { requestId })),
);
