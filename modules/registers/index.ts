/**
 * registers — Register shifts (T6 opens them; T7 adds close and cash).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { openShift, type ShiftSummary } from "./shifts";
