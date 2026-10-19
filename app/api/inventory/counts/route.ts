import { CountListQuery, createCount, listCounts, type CountCreateInput } from "@/modules/inventory";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../../_lib/route";

/** GET /api/inventory/counts?branchId → { rows } (newest 50). */
export const GET = apiRoute({ permission: "inventory.read" }, async (request, _context: unknown, { tenant }) => {
  return json({ rows: await listCounts(tenant, validInput(CountListQuery, queryOf(request))) });
});

/** POST /api/inventory/counts { branchId, scope, categoryId?, note? } → 201 { id } (open count exists ⇒ 409 COUNT_OPEN). */
export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const input = await bodyFor<typeof CountCreateInput>(request);
  return json(await createCount(tenant, input, { requestId }), 201);
});
