/**
 * customers — Customer records and their sale history (docs/planning/customers/customers-spec.md).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {
  listCustomers,
  createCustomer,
  updateCustomer,
  getCustomer,
  customerForSale,
  HISTORY_LIMIT,
  type CustomerRow,
  type CustomerDetail,
  type CustomerSnapshot,
  type CustomerTotals,
} from "./customers";
export { normalizePhone, phoneSearchDigits, type PhoneCountry } from "./phone";
export { CustomerInput, CustomerPatch, CustomerQuery } from "./schemas";
