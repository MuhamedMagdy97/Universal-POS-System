import { listInventoryPostings } from "@/modules/integrations/inventory-sys";
import { apiRoute, json } from "../../../_lib/route";

/** GET /api/integrations/inventory/postings?page=N → postings waiting or refused, 20 a page (`settings.manage`). */
export const GET = apiRoute({}, async (request, _context: unknown, { tenant }) =>
  json(await listInventoryPostings(tenant, Number(new URL(request.url).searchParams.get("page") ?? 1))),
);
