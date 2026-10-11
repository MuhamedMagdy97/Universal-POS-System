import { addCashMovement } from "@/modules/registers";
import { type CashMovementInput } from "@/modules/sales";
import { apiRoute, bodyFor, json, type Params } from "../../../_lib/route";

/** POST /api/shifts/{shiftId}/cash-movements → 201 CashMovementSummary. Permission and scope are checked inside the service. */
export const POST = apiRoute({}, async (request, { params }: Params<"shiftId">, { tenant, requestId }) => {
  const { shiftId } = await params;
  const body = await bodyFor<typeof CashMovementInput>(request);
  return json(await addCashMovement(tenant, shiftId, body, { requestId }), 201);
});
