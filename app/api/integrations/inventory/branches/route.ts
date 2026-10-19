import {
  getInventoryLinkStatus,
  listInventoryWarehouses,
  mapInventoryBranches,
} from "@/modules/integrations/inventory-sys";
import { apiRoute, bodyFor, json } from "../../../_lib/route";

/** GET /api/integrations/inventory/branches → branches with their warehouse, and the IMS warehouses (`settings.manage`). */
export const GET = apiRoute({}, async (_request, _context: unknown, { tenant }) => {
  const [status, warehouses] = await Promise.all([getInventoryLinkStatus(tenant), listInventoryWarehouses(tenant)]);
  return json({ branches: status.branches, warehouses });
});

/** PUT /api/integrations/inventory/branches { map: [{ branchId, warehouseId | null }] } (`integrations.manage`). */
export const PUT = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) =>
  json({ branches: await mapInventoryBranches(tenant, await bodyFor(request), { requestId }) }),
);
