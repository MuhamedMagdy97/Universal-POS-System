import { csvResponse, exportAuditCsv, listAuditEvents } from "@/modules/reports";
import { apiRoute, json, queryOf } from "../_lib/route";

/**
 * GET /api/audit?from&to&actor&action&entityType&entityId&cursor[&format=csv&locale] → { rows, nextCursor }.
 * Owner and Admin (`users.manage`), checked and audit-logged by the service.
 */
export const GET = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const query = queryOf(request);
  if (query.format === "csv") {
    const { filename, body } = await exportAuditCsv(tenant, query, { requestId });
    return csvResponse(body, filename);
  }
  return json(await listAuditEvents(tenant, query, { requestId }));
});
