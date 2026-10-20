import { getCustomer, updateCustomer, type CustomerPatch } from "@/modules/customers";
import { apiRoute, bodyFor, json, type Params } from "../../_lib/route";

/** GET /api/customers/{customerId} → CustomerDetail (customers.read). */
export const GET = apiRoute({}, async (_request, { params }: Params<"customerId">, { tenant }) => {
  const { customerId } = await params;
  return json(await getCustomer(tenant, customerId));
});

/** PATCH /api/customers/{customerId} → CustomerRow (customers.manage); `{ isActive }` archives or restores. */
export const PATCH = apiRoute({}, async (request, { params }: Params<"customerId">, { tenant, requestId }) => {
  const { customerId } = await params;
  const body = await bodyFor<typeof CustomerPatch>(request);
  return json(await updateCustomer(tenant, customerId, body, { requestId }));
});
