import { getCount } from "@/modules/inventory";
import { apiRoute, json, type Params } from "../../../_lib/route";

/** GET /api/inventory/counts/{countId} → CountDetail. */
export const GET = apiRoute(
  { permission: "inventory.read" },
  async (_request, { params }: Params<"countId">, { tenant }) => {
    const { countId } = await params;
    return json(await getCount(tenant, countId));
  },
);
