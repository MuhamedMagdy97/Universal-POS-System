import { listSupplierInvoices, recordSupplierInvoice, type InvoiceInput } from "@/modules/purchasing";
import { apiRoute, bodyFor, json, type Params } from "../../../../_lib/route";

/** GET /api/purchasing/suppliers/{supplierId}/invoices → documents, uninvoiced receipts, uncredited returns (supplier-invoices-spec §4). */
export const GET = apiRoute({}, async (_request, { params }: Params<"supplierId">, { tenant }) => {
  const { supplierId } = await params;
  return json(await listSupplierInvoices(tenant, supplierId));
});

/** POST … (Idempotency-Key required) → 201 { invoiceId } · 200 replay of the same request (I12). */
export const POST = apiRoute({}, async (request, { params }: Params<"supplierId">, { tenant, requestId }) => {
  const { supplierId } = await params;
  const body = await bodyFor<typeof InvoiceInput>(request);
  const { invoiceId, created } = await recordSupplierInvoice(
    tenant,
    supplierId,
    request.headers.get("idempotency-key"),
    body,
    { requestId },
  );
  return json({ invoiceId }, created ? 201 : 200);
});
