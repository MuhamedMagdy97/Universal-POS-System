import { getTransfer } from "@/modules/inventory";
import { apiRoute, json, type Params } from "../../../_lib/route";

/** GET /api/inventory/transfers/{transferId} → TransferDetail. */
export const GET = apiRoute(
  { permission: "inventory.read" },
  async (_request, { params }: Params<"transferId">, { tenant }) => {
    const { transferId } = await params;
    return json(await getTransfer(tenant, transferId));
  },
);
