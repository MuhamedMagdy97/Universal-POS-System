"use client";

import { useEffect, useState } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { TillSnapshot } from "@/modules/sales";
import { snapshotTiles, TILE_LIMIT } from "../_lib/tiles";
import { displayName, lineKey, type TillItem } from "../_lib/till";

type Chip = { id: string; name: string; nameAr: string | null };
type CategoryTree = Chip & { children: CategoryTree[] };

const flatten = (nodes: CategoryTree[]): Chip[] =>
  nodes.flatMap(({ children, ...chip }) => [chip, ...flatten(children)]);
const byName = (a: Chip, b: Chip) => a.name.localeCompare(b.name);

/**
 * Tap tiles for the till (business-profiles-spec BP7, BP8): category chips ("All" first, then each active category
 * by name) and a grid of item tiles; a tap adds one unit. Online the tiles come from the catalog search's browse
 * mode; while selling offline (`snapshot` set) from the till snapshot.
 */
export function TilePanel({
  locale,
  money,
  onAdd,
  snapshot,
}: {
  locale: Locale;
  money: (minor: number) => string;
  onAdd: (item: TillItem) => void;
  snapshot: TillSnapshot | null;
}) {
  const tr = translator(locale);
  const [fetchedChips, setFetchedChips] = useState<Chip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Online tiles, keyed by the chip they were fetched for, so a stale answer never shows under another chip.
  const [fetched, setFetched] = useState<{ key: string; items: TillItem[] | "failed" } | null>(null);
  const key = selected ?? "";

  useEffect(() => {
    if (snapshot) return;
    let live = true;
    fetch("/api/categories", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<CategoryTree[]>) : []))
      .then((tree) => live && setFetchedChips(flatten(tree).sort(byName)))
      .catch(() => live && setFetchedChips([]));
    return () => {
      live = false;
    };
  }, [snapshot]);

  useEffect(() => {
    if (snapshot) return;
    let live = true;
    const params = new URLSearchParams(
      key ? { categoryId: key, limit: String(TILE_LIMIT) } : { all: "1", limit: String(TILE_LIMIT) },
    );
    fetch(`/api/catalog/search?${params}`, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`tiles failed: ${response.status}`);
        return response.json() as Promise<TillItem[]>;
      })
      .then((items) => live && setFetched({ key, items }))
      .catch(() => live && setFetched({ key, items: "failed" }));
    return () => {
      live = false;
    };
  }, [snapshot, key]);

  // Offline: straight from the snapshot.
  const chips = snapshot ? [...(snapshot.categories ?? [])].sort(byName) : fetchedChips;
  const result = snapshot ? snapshotTiles(snapshot, selected) : fetched?.key === key ? fetched.items : null;
  const failed = result === "failed";
  const items = failed ? null : result;

  const chip = (id: string | null, label: string) => (
    <button
      key={id ?? "all"}
      type="button"
      aria-pressed={selected === id}
      onClick={() => setSelected(id)}
      className={`btn btn-sm rounded-full ${selected === id ? "btn-primary" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <section data-testid="till-tiles" aria-label={tr("pos.tiles.label")} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {chip(null, tr("pos.tiles.all"))}
        {chips.map((c) => chip(c.id, displayName(c, locale)))}
      </div>
      {failed ? (
        <p role="alert" className="notice notice-error">
          {tr("pos.error.generic")}
        </p>
      ) : items === null ? (
        <p className="text-muted" aria-busy="true">
          …
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted">{tr("pos.tiles.empty")}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
          {items.map((item) => (
            <button
              key={lineKey(item)}
              type="button"
              onClick={() => onAdd(item)}
              aria-label={tr("pos.search.add", { name: displayName(item, locale) })}
              className="btn h-24 flex-col items-start justify-between p-3 text-start"
            >
              <span className="line-clamp-2 w-full font-medium">{displayName(item, locale)}</span>
              <span dir="ltr" className="text-sm text-muted tabular-nums">
                {money(item.unitPriceMinor)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
