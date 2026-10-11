/**
 * inventory — Append-only movement ledger and stock balances (T4). Other modules call inventory.record*(), never write its tables.
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {};
