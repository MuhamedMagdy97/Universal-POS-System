/**
 * org — Tenancy: shop setup, staff, branches and tills (T2, onboarding spec), receipt settings (T10).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { getReceiptSettings, updateReceiptSettings, ReceiptSettingsInput, type ReceiptSettings } from "./receipt";
export { createShop, FIRST_BRANCH_CODE, FIRST_REGISTER_NAME, type ShopCreated } from "./setup";
export { listStaff, addStaff, updateStaff, type StaffRow } from "./staff";
export {
  listBranches,
  createBranch,
  updateBranch,
  createRegister,
  updateRegister,
  type BranchRow,
  type RegisterRow,
} from "./branches";
export { changeOwnPassword } from "./account";
export { STAFF_ROLES, canManageRole, type StaffRole } from "./schemas";
