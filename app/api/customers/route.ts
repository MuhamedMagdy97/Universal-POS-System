import { createCustomer, CustomerQuery, listCustomers, type CustomerInput } from "@/modules/customers";
import { apiRoute, bodyFor, json, queryOf, validInput } from "../_lib/route";

/**
 * GET /api/customers?q&includeArchived&limit → CustomerRow[] (customers.read).
 * POST /api/customers → 201 CustomerRow (customers.create). Permissions are checked in the service.
 */
export const GET = apiRoute({}, async (request, _context: unknown, { tenant }) => {
  const query = validInput(CustomerQuery, queryOf(request));
  return json(await listCustomers(tenant, query));
});

export const POST = apiRoute({}, async (request, _context: unknown, { tenant, requestId }) => {
  const body = await bodyFor<typeof CustomerInput>(request);
  return json(await createCustomer(tenant, body, { requestId }), 201);
});
