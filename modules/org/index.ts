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
export {
  getOfflineSettings,
  updateOfflineSettings,
  enrolOfflineDevice,
  revokeOfflineDevice,
  reportOfflineQueue,
  OfflineSettingsInput,
  type OfflineSettings,
  type OfflineRegisterRow,
  type EnrolledDevice,
} from "./offline";
export { BusinessTypeInput, getBusinessType, orgBusinessType, updateBusinessType } from "./business";
export { getScaleSettings, ScaleSettingsInput, updateScaleSettings } from "./scale";
export { listTables, saveTables, SaveTablesInput, type DiningTableRow } from "./tables";
export { getServiceCharge, ServiceChargeInput, updateServiceCharge } from "./service-charge";
