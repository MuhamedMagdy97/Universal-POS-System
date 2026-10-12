import { csvResponse, exportReportCsv, getReport } from "@/modules/reports";
import { apiRoute, json, queryOf, type Params } from "../../_lib/route";

/**
 * GET /api/reports/{report}?branchId&from&to[&format=csv&locale] → report JSON, or a CSV download.
 * The service checks `reports.view` itself so a refusal is audit-logged.
 */
export const GET = apiRoute({}, async (request, { params }: Params<"report">, { tenant, requestId }) => {
  const { report } = await params;
  const query = queryOf(request);
  if (query.format === "csv") {
    const { filename, body } = await exportReportCsv(tenant, report, query, { requestId });
    return csvResponse(body, filename);
  }
  return json(await getReport(tenant, report, query, { requestId }));
});
