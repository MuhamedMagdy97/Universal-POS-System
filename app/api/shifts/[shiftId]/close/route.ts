import { closeShift } from "@/modules/registers";
import { type CloseShiftInput } from "@/modules/sales";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** POST /api/shifts/{shiftId}/close → 200 ShiftCloseSummary (a repeat with the same count is also 200). Scope and permission are checked inside the service. */
export const POST = apiRoute({}, async (request, { params }: Params<"shiftId">, { tenant, requestId }) => {
  const { shiftId } = await params;
  const body = await bodyFor<typeof CloseShiftInput>(request);
  return json(await closeShift(tenant, shiftId, body, { requestId }));
});
