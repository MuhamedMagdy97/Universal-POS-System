import { updateSupplier, type SupplierPatch } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** PATCH /api/purchasing/suppliers/{supplierId} → SupplierRow (purchases.manage). */
export const PATCH = apiRoute({}, async (request, { params }: Params<"supplierId">, { tenant, requestId }) => {
  const { supplierId } = await params;
  const body = await bodyFor<typeof SupplierPatch>(request);
  return json(await updateSupplier(tenant, supplierId, body, { requestId }));
});
