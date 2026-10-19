/**
 * integrations/inventory-sys — the optional link to the owner's inventory system (Phase 13,
 * docs/planning/inventory-integration/). Slice 1: settings, the source toggle and the catalog sync.
 * Other modules import guards from `./source` directly (see that file).
 */
export {
  checkInventoryLink,
  getInventoryLinkStatus,
  InventoryLinkInput,
  InventorySourceInput,
  saveInventoryLink,
  setInventorySource,
  syncInventoryNow,
  type CheckResult,
  type InventoryLinkStatus,
} from "./link";
export type { SyncSummary } from "./sync";
export { assertBuiltIn, inventorySourceOf, managedByInventory } from "./source";
