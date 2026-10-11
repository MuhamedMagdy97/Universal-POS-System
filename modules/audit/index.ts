/**
 * audit — Append-only audit events; never logs secrets (T9).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {};
