import { recordOpeningBalances, type OpeningInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** POST /api/inventory/opening → 201 { lines } (one-time opening stock, all lines or none). */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof OpeningInput>(request);
  return json(await recordOpeningBalances(tenant, input, { requestId }), 201);
});
