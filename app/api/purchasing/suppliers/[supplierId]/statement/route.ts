import { getSupplierStatement, StatementQuery } from "@/modules/purchasing";
import { apiRoute, json, queryOf, validInput, type Params } from "../../../../_lib/route";

/** GET /api/purchasing/suppliers/{supplierId}/statement?from&to → SupplierStatement (supplier-payments-spec S13). */
export const GET = apiRoute({}, async (request, { params }: Params<"supplierId">, { tenant }) => {
  const { supplierId } = await params;
  const query = validInput(StatementQuery, queryOf(request));
  return json(await getSupplierStatement(tenant, supplierId, query));
});
