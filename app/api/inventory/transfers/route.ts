import { TransferListQuery, listTransfers, sendTransfer, type TransferInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../../_lib/route";

/** GET /api/inventory/transfers?branchId&direction=outgoing|incoming&status? → { rows } (newest 50). */
export const GET = apiRoute({ permission: "inventory.read" }, async (request, _context: unknown, { tenant }) => {
  return json({ rows: await listTransfers(tenant, validInput(TransferListQuery, queryOf(request))) });
});

/**
 * POST /api/inventory/transfers → 201 { transferId, replayed } when sent in transit; 200 when the
 * same transferId is retried with the same content (nothing is applied twice).
 */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof TransferInput>(request);
  const result = await sendTransfer(tenant, input, { requestId });
  return json(result, result.replayed ? 200 : 201);
});
