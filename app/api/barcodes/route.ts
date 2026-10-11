import { addBarcode, AddBarcode, lookupCode, LookupQuery } from "@/modules/catalog";
import { apiRoute, bodyOf, json, queryOf } from "../_lib/route";

/** GET /api/barcodes?code= → LookupResult (scanner). Unknown code → 404 UNKNOWN_CODE. */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const { code } = LookupQuery.parse(queryOf(request));
  return json(await lookupCode(tenant, code));
});

/** POST /api/barcodes → 201 BarcodeDetail. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyOf(request, AddBarcode);
  return json(await addBarcode(tenant, input, { requestId }), 201);
});
