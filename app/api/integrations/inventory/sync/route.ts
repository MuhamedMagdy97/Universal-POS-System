import { syncInventoryNow } from "@/modules/integrations/inventory-sys";
import { apiRoute, json } from "../../../_lib/route";

/** POST /api/integrations/inventory/sync → "Sync now" summary (`settings.manage`, linked shops only). */
export const POST = apiRoute({}, async (_request, _context: unknown, { tenant, requestId }) =>
  json(await syncInventoryNow(tenant, { requestId })),
);
