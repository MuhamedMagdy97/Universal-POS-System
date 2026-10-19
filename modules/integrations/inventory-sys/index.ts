/**
 * integrations/inventory-sys — the optional link to the owner's inventory system (Phase 13,
 * docs/planning/inventory-integration/). Slice 1: settings, the source toggle and the catalog sync; slice 2: sale
 * posting; slice 4: the scheduled run and the postings list.
 * Other modules import guards from `./source` directly (see that file).
 */
export {
  checkInventoryLink,
  getInventoryLinkStatus,
  listInventoryPostings,
  listInventoryWarehouses,
  mapInventoryBranches,
  retryInventoryPosting,
  runInventorySchedule,
  BranchMapInput,
  InventoryLinkInput,
  InventorySourceInput,
  saveInventoryLink,
  setInventorySource,
  syncInventoryNow,
  type CheckResult,
  type ImsWarehouse,
  type InventoryPosting,
  type InventoryLinkStatus,
} from "./link";
export { drainPostings } from "./postings";
export type { SyncSummary } from "./sync";
export { assertBuiltIn, inventorySourceOf, managedByInventory } from "./source";
