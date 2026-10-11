import type { CategoryNode } from "@/modules/catalog/categories";
import type { Locale } from "@/lib/i18n";
import { displayName } from "./form-helpers";

/** Depth-first flattening of the category tree (parents before children). */
export function flattenCategories(nodes: readonly CategoryNode[], out: CategoryNode[] = []): CategoryNode[] {
  for (const node of nodes) {
    out.push(node);
    flattenCategories(node.children, out);
  }
  return out;
}

/** Select options with the tree depth shown as a "— " prefix. */
export function categoryOptions(nodes: readonly CategoryNode[], locale: Locale) {
  return flattenCategories(nodes).map((c) => ({
    id: c.id,
    label: `${"— ".repeat(Math.max(0, c.depth - 1))}${displayName(locale, c)}`,
    isActive: c.isActive,
    depth: c.depth,
  }));
}
