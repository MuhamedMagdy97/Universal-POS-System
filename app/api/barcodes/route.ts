import { addBarcode, type AddBarcode, lookupCode, LookupQuery } from "@/modules/catalog";
import { apiRoute, bodyFor, json, queryOf } from "../_lib/route";

/** GET /api/barcodes?code= → LookupResult (scanner). Unknown code → 404 UNKNOWN_CODE. */
export const GET = apiRoute({ permission: "products.read" }, async (request, _context: unknown, { tenant }) => {
  const { code } = LookupQuery.parse(queryOf(request));
  return json(await lookupCode(tenant, code));
});

/** POST /api/barcodes → 201 BarcodeDetail. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof AddBarcode>(request);
  return json(await addBarcode(tenant, input, { requestId }), 201);
});
