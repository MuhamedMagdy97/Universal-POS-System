# Business Profiles (UI Refresh B): As Built

Built 2026-10-24 against [business-profiles-spec.md](business-profiles-spec.md) and
[business-profiles-plan.md](business-profiles-plan.md), in two PRs: profiles (#74) and till tiles (#75).

## What exists

- **Profiles** (`modules/presets`): the spec §2 table, with `profileOf(type)` and a WCAG `contrastRatio` used by the
  unit test that keeps every accent at 4.5:1 or better in both themes.
- **Setup**: onboarding offers all six types (Retail preselected), each with its icon.
- **Settings → Shop** (`/settings/shop`): the Owner changes the type (new Owner-only permission `shop.manage`);
  Owner and Admin see the page; the change is audited as `settings.business_type.updated` and saving the same type
  writes nothing.
- **Accent and icon**: `BusinessTheme` streams a `<style>` with the profile's `--accent` and `--accent-soft` (light
  and dark) into the app layout; `BrandIcon` shows the profile icon in the sidebar. One read of the type per request
  (`orgBusinessType`, React `cache`).
- **Item word**: the catalog nav (non-retail words only; "products" keeps "Catalog"), the products page title and its
  add button say Items, Menu items or Services.
- **Dashboard**: tiles in the profile's order; new Average ticket (net sales ÷ sales, "—" without sales) and Top
  items / Top services today (net quantity from the Products report, five rows, linking to it).
- **Catalog search browse**: `GET /api/catalog/search` without `q` and with `categoryId` or `all=1` lists active items
  by name (`browseSellable`, up to 60). Sellable items carry `categoryId`.
- **Till snapshot**: carries `categories`; `SNAPSHOT_VERSION` stays 1 (additive).
- **Till**: tile-layout shops get `TilePanel` under the scan box: chips ("All" and each active category by name), 96 px
  tiles with a two-line name and the price, "No items" for an empty category. Offline, tiles come from the snapshot;
  an older snapshot shows everything under "All". The self-contained parts of `till.tsx` (discount box, exact cash,
  stock note, offline bar and slip) moved to `till-parts.tsx`; `till.tsx` went from 1,100 to about 850 lines.

## Deviations from the spec

| Spec | As built | Why |
| ---- | -------- | --- |
| BP6 split into cart, payment and receipt parts | Only the self-contained parts moved; cart and payment stay in `Till` | They share about twenty pieces of state; splitting them needs a state container, which D (tables, open tickets) can bring when it needs one |
| BP8 `SNAPSHOT_VERSION` 2 | Stays 1 | The fields are additive and the server accepts any version; older snapshots still work |
| BP7 chips only for categories with sellable items | Every active category; an empty one says "No items" | Avoids a second query per till load |
| BP11 a cashier gets 403 on the Shop setting | The settings page shows "You cannot change settings" | Same rule as the other settings pages |

## Tests

Unit: `presets.test.ts`, `dashboard-tiles.test.ts`, `pos-tiles.test.ts`. Integration: `business-type.test.ts`,
`dashboard-profile.test.ts`, `catalog-browse.test.ts`, the onboarding SALON case. E2E: `business-profiles.spec.ts`
(owner switches to café: accent, Menu items, dashboard tiles; café sells from a tile; empty category; long names;
retail unchanged; cashier denied) and a no-tiles check on the retail till in `ui-quality.spec.ts`.
