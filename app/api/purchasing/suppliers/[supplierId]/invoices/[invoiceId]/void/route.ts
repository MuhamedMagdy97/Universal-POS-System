import { voidSupplierInvoice, type VoidInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../../../_lib/route";

/** POST /api/purchasing/suppliers/{supplierId}/invoices/{invoiceId}/void { reason } → 200 { invoiceId }; voiding again changes nothing (I6). */
export const POST = apiRoute(
  {},
  async (request, { params }: Params<"supplierId" | "invoiceId">, { tenant, requestId }) => {
    const { supplierId, invoiceId } = await params;
    const body = await bodyFor<typeof VoidInput>(request);
    const result = await voidSupplierInvoice(tenant, supplierId, invoiceId, body, { requestId });
    return json({ invoiceId: result.invoiceId });
  },
);
