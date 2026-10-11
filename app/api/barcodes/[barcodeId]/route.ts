import { removeBarcode } from "@/modules/catalog";
import { apiRoute, noContent, type Params } from "../../_lib/route";

/** DELETE /api/barcodes/{barcodeId} → 204 (hard delete, audited). */
export const DELETE = apiRoute({}, async (_request, { params }: Params<"barcodeId">, { tenant, requestId }) => {
  const { barcodeId } = await params;
  await removeBarcode(tenant, barcodeId, { requestId });
  return noContent();
});
