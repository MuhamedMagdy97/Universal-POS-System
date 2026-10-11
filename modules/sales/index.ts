/**
 * sales — Checkout, sale snapshots, idempotent sale creation, voids (T6, T8).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {};
