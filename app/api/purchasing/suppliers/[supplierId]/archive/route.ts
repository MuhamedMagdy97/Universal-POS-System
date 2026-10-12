import { archiveSupplier } from "@/modules/purchasing";
import { apiRoute, json, type Params } from "../../../../_lib/route";

/** POST /api/purchasing/suppliers/{supplierId}/archive → SupplierRow (purchases.manage). */
export const POST = apiRoute({}, async (_request, { params }: Params<"supplierId">, { tenant, requestId }) => {
  const { supplierId } = await params;
  return json(await archiveSupplier(tenant, supplierId, { requestId }));
});
