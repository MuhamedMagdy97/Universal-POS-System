/**
 * registers — Register shifts: open (T6), close and cash movements (T7).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {
  openShift,
  closeShift,
  addCashMovement,
  lockShift,
  previewShiftCash,
  type CashBreakdown,
  type ShiftSummary,
  type ShiftCloseSummary,
  type CashMovementSummary,
} from "./shifts";
