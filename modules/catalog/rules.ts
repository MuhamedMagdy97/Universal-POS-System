/**
 * Pure catalog rules (no DB access), shared by the services and unit-tested in
 * tests/unit/catalog-search.test.ts. See catalog-api-and-rules.md §2, §5.
 */
import type { ProductSort } from "./schemas";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Escapes `\`, `%` and `_` so user input is matched literally by `LIKE`/`ILIKE`
 * (PostgreSQL's default escape character is `\`). Prisma's `contains` does not
 * escape wildcards itself.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Could `q` be a scanned barcode? Barcodes are printable ASCII without spaces
 * (DB CHECK `Barcode_code_format`), so anything else skips the exact-barcode probe.
 */
export function isBarcodeCandidate(q: string): boolean {
  return /^[\x21-\x7E]{1,64}$/.test(q);
}

/** Cursor sort key for a row under the given sort. */
export function sortKeyOf(row: { name: string; updatedAt: Date }, sort: ProductSort): string {
  return sort === "name" ? row.name : row.updatedAt.toISOString();
}

/**
 * A cursor that sorts before every real row: used when page 1 holds only the
 * exact-barcode hit and the contains-match stream has not started yet.
 * Names are never blank (DB CHECK), so `name > ""` matches everything; for
 * `updatedAt DESC` a far-future key does the same.
 */
export function startCursorKey(sort: ProductSort): { sortKey: string; id: string } {
  return sort === "name"
    ? { sortKey: "", id: "00000000-0000-0000-0000-000000000000" }
    : { sortKey: "9999-12-31T23:59:59.999Z", id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
}

// ---------------------------------------------------------------------------
// Category tree (max depth 3, no cycles)
// ---------------------------------------------------------------------------

export const MAX_CATEGORY_DEPTH = 3;

/** id → parentId for every category of one org (archived included). */
export type CategoryParentMap = ReadonlyMap<string, string | null>;

/** Depth of a node: a root is 1. Stops on a (corrupt) cycle instead of looping forever. */
export function categoryDepth(parents: CategoryParentMap, id: string): number {
  let depth = 0;
  let current: string | null | undefined = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = parents.get(current);
  }
  return depth;
}

/** Height of the subtree rooted at `id`: a leaf is 1. */
export function subtreeHeight(parents: CategoryParentMap, id: string): number {
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    if (parent) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const height = (node: string, seen: Set<string>): number => {
    if (seen.has(node)) return 0;
    seen.add(node);
    let max = 0;
    for (const child of children.get(node) ?? []) max = Math.max(max, height(child, seen));
    return max + 1;
  };
  return height(id, new Set());
}

/** True when making `newParentId` the parent of `id` would close a loop (self or descendant). */
export function wouldCreateCycle(parents: CategoryParentMap, id: string, newParentId: string | null): boolean {
  let current: string | null | undefined = newParentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === id) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

/**
 * Depth check for placing `id` (with its whole subtree) under `newParentId`.
 * For a brand-new category pass `id = null` (height 1).
 */
export function exceedsMaxDepth(parents: CategoryParentMap, id: string | null, newParentId: string | null): boolean {
  const parentDepth = newParentId ? categoryDepth(parents, newParentId) : 0;
  const height = id ? subtreeHeight(parents, id) : 1;
  return parentDepth + height > MAX_CATEGORY_DEPTH;
}

// ---------------------------------------------------------------------------
// Prices and change sets
// ---------------------------------------------------------------------------

export type CatalogWarning = "PRICE_BELOW_COST";

/** Warnings for an effective price/cost pair (variant values already resolved against the product). */
export function priceWarnings(priceMinor: number, costMinor: number): CatalogWarning[] {
  return priceMinor < costMinor ? ["PRICE_BELOW_COST"] : [];
}

/** `{ field: [old, new] }` for every key of `next` whose value differs from `current`. */
export function diffFields<T extends Record<string, unknown>>(
  current: T,
  next: Partial<T>,
): Partial<Record<keyof T, [unknown, unknown]>> {
  const changes: Partial<Record<keyof T, [unknown, unknown]>> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    const value = next[key];
    if (value !== undefined && value !== current[key]) changes[key] = [current[key], value];
  }
  return changes;
}

/** Next `updatedAt` for an optimistic-concurrency write: always strictly later than the previous one. */
export function nextUpdatedAt(previous: Date, now = new Date()): Date {
  return now.getTime() > previous.getTime() ? now : new Date(previous.getTime() + 1);
}
