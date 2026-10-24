# Business Profiles (UI Refresh B): Specification

Status: **Draft for the owner's review (2026-10-24).** Design approved in conversation with every choice as
recommended.

Source: [overview](README.md), [design system as built](design-system-as-built.md). Today `Organization.businessType`
is stored at setup and read nowhere else; onboarding offers only Retail (`modules/presets`: the other five are
"coming soon") and the type cannot be changed. The till has one entry mode, type-to-search
(`/api/catalog/search?q=`), in a 1,100-line `app/(app)/pos/_components/till.tsx`.

## 1. Goal

Each business type gets a view made for it: its own accent colour and icon, a till layout that suits how it sells,
the word it uses for what it sells, and the dashboard numbers it cares about. All six types can be chosen. Selling
rules are the same for every type until sub-projects C, D and E add weights, tables and services.

## 2. Profiles

One table in `modules/presets` (configuration only, never forked logic):

| Type              | Icon    | Accent light / dark   | Till layout | Item word (EN / AR)      | Dashboard tiles, in order                                       |
| ----------------- | ------- | --------------------- | ----------- | ------------------------ | --------------------------------------------------------------- |
| `RETAIL`          | store   | `#1d5fd1` / `#5b9cf5` | Scan        | Products / المنتجات      | net sales, sales, refunds, open shifts, low stock               |
| `GROCERY`         | basket  | `#16794a` / `#46c98a` | Scan        | Products / المنتجات      | net sales, sales, low stock, refunds, open shifts               |
| `FRUIT_VEG`       | apple   | `#4d7c0f` / `#a3d65c` | Tiles       | Items / الأصناف          | net sales, sales, low stock, top items, open shifts             |
| `BAKERY_BUTCHER`  | wheat   | `#a16207` / `#facc15` | Tiles       | Items / الأصناف          | net sales, sales, top items, low stock, open shifts             |
| `RESTAURANT_CAFE` | coffee  | `#c2410c` / `#fb8a5b` | Tiles       | Menu items / قائمة الطعام | net sales, sales, average ticket, top items, open shifts        |
| `SALON`           | scissors| `#7e22ce` / `#c084fc` | Tiles       | Services / الخدمات       | net sales, sales, average ticket, top services, open shifts     |

Each profile also sets `--accent-soft` (light and dark). Accent text on the accent fill (`--accent-foreground`: white
in light mode, `#0b1220` in dark mode) is at least 4.5:1 for every profile.

## 3. Decisions

| #    | Question                     | Decision (recommended)                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BP1  | Where do profiles live?      | `modules/presets`: `BUSINESS_PRESETS` gains `icon`, `accent`, `tillLayout`, `itemWord` and `dashboardTiles`; `status` is removed. A `profileOf(type)` helper. No migration: `Organization.businessType` already exists.                                                                                                 |
| BP2  | Choosing a type at setup     | Onboarding offers all six types; Retail stays preselected. `modules/org/schemas.ts` accepts any `BusinessType`.                                                                                                                                                                                                        |
| BP3  | Changing the type later      | New Settings tab **Shop** (`/settings/shop`), Owner only, like the offline setting. Saving writes `businessType` and the audit event `settings.business_type.updated` `{ before, after }`; saving the same type succeeds without an audit row. Nothing else changes: products, stock, sales and reports stay as they are. |
| BP4  | Accent colour                | The app layout streams a `<style>` element (inside `<Suspense>`) that sets `--accent`, `--accent-soft` for light and dark from the shop's profile. Before it arrives the default blue shows. Signed-out pages stay blue. The CSP already allows inline styles.                                                         |
| BP5  | Icon                         | The profile's icon replaces the store mark in the sidebar brand and on the dashboard header. New Lucide icons in `app/_ui/icons.tsx`: basket, apple, wheat, coffee, scissors.                                                                                                                                          |
| BP6  | Till structure               | `till.tsx` is split into a cart part, a payment part, a receipt part and the offline bar (shared), and two entry panels: `ScanPanel` (today's search box and results, unchanged) and `TilePanel`. The till page passes the profile's `tillLayout`. Selling, totals, offline and printing behave exactly as now.        |
| BP7  | Tile panel                   | The scan box stays on top (barcodes still work). Below it: category chips, "All" first, then each active category with sellable items, by name; then a grid of tiles (name in the current language, price), at least 96 × 64 px, tap to add one unit. A tile for an item that is out of stock shows the on-hand note like the search results. |
| BP8  | Tile data                    | `GET /api/catalog/search` accepts `categoryId` and an empty `q` when `categoryId` or `all=1` is given; `limit` up to 60. `SellableSummary` gains `categoryId`. "All" lists the first 60 sellable items by name. Offline, tiles come from the till snapshot (which then carries `categoryId`, `SNAPSHOT_VERSION` 2); a version-1 snapshot shows the scan box only. |
| BP9  | Item word                    | The catalog nav label, the products page title and its "Add …" button use the profile's word. Every other screen stays generic.                                                                                                                                                                                       |
| BP10 | Dashboard                    | The profile picks which tiles show and their order (table above). New tiles: **Average ticket** = net sales ÷ sales today (shown as "—" with no sales), and **Top items today** / **Top services today**: the five best sellers by quantity from the Products report for today, each linking to it. Tiles still follow permissions. |
| BP11 | Tests                        | Unit: every profile is complete and passes the contrast rule; `profileOf` for each type; the search schema with `categoryId`/`all`. Integration: business type update (Owner only, audit, no-op). E2E: a café shop sees coral, "Menu items", tiles on the till and sells from a tile; retail is unchanged (all existing E2E green); an Owner changes the type and the till switches layout; a cashier gets 403 on the Shop setting. |

## 4. Out of scope

Selling by weight (C); tables, modifiers, kitchen tickets (D); appointments, staff per line, commission (E); product
images or tile colours; a manual accent picker; per-branch types.

## 5. Delivery

Two PRs, merged in order:

1. Profiles, onboarding, Shop setting, accent, icons, item word, dashboard tiles.
2. Till split and the tile panel, search API and snapshot changes.
