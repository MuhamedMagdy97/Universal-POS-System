import { openShift } from "@/modules/registers";
import { type OpenShiftInput } from "@/modules/sales";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** POST /api/shifts/open → 201 ShiftSummary. Permission and branch scope are checked inside the service. */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof OpenShiftInput>(request);
  return json(await openShift(tenant, body, { requestId }), 201);
});
