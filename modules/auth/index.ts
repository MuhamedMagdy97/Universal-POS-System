/**
 * auth — Authentication and sessions (login, revoke, membership lookup). Core helpers live in lib/auth; domain workflows land here in T1.
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {};
