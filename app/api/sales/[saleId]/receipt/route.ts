import { z } from "zod";
import { getReceipt } from "@/modules/sales";
import { apiRoute, json, queryOf, type Params } from "../../../_lib/route";

const Query = z.strictObject({
  kind: z.enum(["SALE", "REFUND", "VOID"]).default("SALE"),
  refund: z.string().optional(),
  copy: z.enum(["0", "1"]).default("0"),
});

/**
 * GET /api/sales/{saleId}/receipt?kind=SALE|REFUND|VOID&refund={refundId}&copy=1 → 200 the printable receipt.
 * `copy=1` marks a reprint and audits it (T10 H4). Scope and permission are checked inside the service.
 */
export const GET = apiRoute({}, async (request, { params }: Params<"saleId">, { tenant, requestId }) => {
  const { saleId } = await params;
  const query = Query.parse(queryOf(request));
  const doc = await getReceipt(
    tenant,
    saleId,
    { kind: query.kind, refundId: query.refund, copy: query.copy === "1" },
    { requestId },
  );
  return json(doc);
});
