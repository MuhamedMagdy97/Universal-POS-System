"use client";

import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { TillSnapshot } from "@/modules/sales";
import { loadTiles, snapshotTiles } from "../_lib/tiles";
import { StockNote } from "./till-parts";
import { displayName, lineKey, type TillItem } from "../_lib/till";

type Chip = { id: string; name: string; nameAr: string | null };
type CategoryTree = Chip & { children: CategoryTree[] };

const flatten = (nodes: CategoryTree[]): Chip[] =>
  nodes.flatMap(({ children, ...chip }) => [chip, ...flatten(children)]);
const byName = (a: Chip, b: Chip) => a.name.localeCompare(b.name);

/**
 * Tap tiles for the till (business-profiles-spec BP7, BP8): category chips ("All" first, then each active category
 * by name) and a grid of item tiles; a tap adds one unit. Online the tiles come from the catalog search's browse
 * mode; while selling offline (`snapshot` set) from the till snapshot. When the network drops mid-shift, a usable
 * snapshot (`fallback`) answers and the till is marked unreachable, as its search does. Tiles show on-hand stock
 * like the search results (`stock`, loaded by the till through `onShown`).
 */
export function TilePanel({
  locale,
  money,
  onAdd,
  snapshot,
  fallback,
  onUnreachable,
  stock,
  onShown,
}: {
  locale: Locale;
  money: (minor: number) => string;
  /** `refocus` is false for a touch tap, so the scanner box does not pop up the on-screen keyboard. */
  onAdd: (item: TillItem, refocus: boolean) => void;
  snapshot: TillSnapshot | null;
  fallback: TillSnapshot | null;
  onUnreachable: () => void;
  stock: Record<string, number | null>;
  onShown: (items: readonly TillItem[]) => void;
}) {
  const tr = translator(locale);
  const [fetchedChips, setFetchedChips] = useState<Chip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Online tiles per chip ("" = All): an answer lands under the chip it was asked for, never another one.
  const [fetched, setFetched] = useState<Record<string, TillItem[] | "failed">>({});
  const key = selected ?? "";

  // No cancel flag: an answer is tagged with what it was asked for and only shown while that is still selected
  // (a cancel flag lost answers under dev double-mounting and hidden route trees).
  useEffect(() => {
    if (snapshot) return;
    fetch("/api/categories", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<CategoryTree[]>) : []))
      .then((tree) => setFetchedChips(flatten(tree).sort(byName)))
      .catch(() => setFetchedChips([]));
  }, [snapshot]);

  // The till's latest fallback and callbacks, read when an answer arrives without re-running the fetch.
  const arrived = useEffectEvent((forKey: string) =>
    loadTiles(forKey, fallback, onUnreachable).then((items) => {
      setFetched((current) => ({ ...current, [forKey]: items }));
      if (items !== "failed") onShown(items);
    }),
  );

  useEffect(() => {
    if (snapshot) return;
    void arrived(key);
  }, [snapshot, key]);

  // Offline: straight from the snapshot.
  const chips = snapshot ? [...(snapshot.categories ?? [])].sort(byName) : fetchedChips;
  const result = snapshot ? snapshotTiles(snapshot, selected) : (fetched[key] ?? null);
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
              onClick={(event: MouseEvent) => onAdd(item, (event.nativeEvent as PointerEvent).pointerType !== "touch")}
              aria-label={tr("pos.search.add", { name: displayName(item, locale) })}
              className="btn h-24 flex-col items-start justify-between p-3 text-start"
            >
              <span className="line-clamp-2 w-full font-medium">{displayName(item, locale)}</span>
              <span className="flex w-full flex-wrap items-baseline justify-between gap-x-2">
                <span dir="ltr" className="text-sm text-muted tabular-nums">
                  {money(item.unitPriceMinor)}
                </span>
                <StockNote locale={locale} onHand={stock[lineKey(item)]} qty={0} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
