/**
 * org — Tenancy: organizations, branches, registers, memberships (T1-T2), receipt settings (T10).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { getReceiptSettings, updateReceiptSettings, ReceiptSettingsInput, type ReceiptSettings } from "./receipt";
