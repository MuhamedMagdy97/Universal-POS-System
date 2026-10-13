import { getReceiptSettings, updateReceiptSettings, type ReceiptSettingsInput } from "@/modules/org";
import { apiRoute, bodyFor, json } from "../../_lib/route";

/** GET /api/org/receipt → 200 the shop's receipt fields (`settings.manage`). */
export const GET = apiRoute({}, async (_request, _context: unknown, { tenant }) =>
  json(await getReceiptSettings(tenant)),
);

/** PATCH /api/org/receipt { legalName?, taxNumber?, receiptAddress?, receiptPhone?, receiptHeader?, receiptFooter? } → 200. */
export const PATCH = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof ReceiptSettingsInput>(request);
  return json(await updateReceiptSettings(tenant, body, { requestId }));
});
