# Design System and App Shell (UI Refresh A): As Built

Built 2026-10-24 against [design-system-spec.md](design-system-spec.md) and
[design-system-plan.md](design-system-plan.md), in two PRs: design system and shell (#72), screens restyled (#73).

## What exists

- **Tokens** (`app/globals.css`): `page`, `surface`, `surface-sunken`, `foreground`, `muted`, `border`,
  `border-strong`, `accent` (+ `-foreground`, `-soft`), `success`, `warning`, `danger` (+ `-soft`), light and dark.
  `--background` aliases `--page`. Print keeps black on white.
- **Classes**: `btn`, `btn-primary`, `btn-danger`, `btn-ghost`, `btn-sm`, `input`, `card`, `table`, `table-wrap`,
  `badge` + `badge-{accent,success,warning,danger}`, `notice` + `notice-{error,success,info}`, `field`, `field-hint`.
  Buttons inside table rows are compact.
- **Font**: IBM Plex Sans Arabic 400/500/600 via `next/font/google` (`--font-plex`).
- **Parts** (`app/_ui/`): `Icon` (26 Lucide icons, directional ones mirror in Arabic), `PageHeader`, `StatTile`.
- **Shell** (`app/(app)/_components/app-shell.tsx`, `nav-item.tsx`): sidebar with a Dashboard link, the
  permission-gated links and the current section marked; icons only from 640 px to 1024 px and on `/pos`; a menu
  button below 640 px.
- **Screens**: every back-office page uses the classes; every screen table scrolls inside `table-wrap`; status pills
  use badge tones; the till has its search, results and cart in a card and the payment form in a sticky card, with
  48 px targets.

## Deviations from the spec

| Spec | As built | Why |
| ---- | -------- | --- |
| DS8 phone drawer is a native `<dialog>` | The same `<aside>` shown fixed over the page, closed by Escape, the close button, the backdrop or a navigation | The links exist once in the DOM; no duplicate landmarks |
| DS8 `Sidebar` component | `AppShell` (sidebar, top bar and main in one client component) | The menu button in the top bar needs the sidebar's open state |
| DS9 `PageHeader` on pages with a title and actions | Used on the dashboard; other pages keep their existing title rows restyled by the classes | Same look, much smaller diff; sub-project B reworks pages per business type |
| — | `rounded-md` became `rounded-lg` across screens | One radius family with the new classes |

## Tests

`tests/e2e/shell.spec.ts`: sidebar side in English and Arabic, collapse on the till, current link, phone menu, phone
width reports without sideways scroll, long shop name, cashier links. The till stock-note check now looks for
`text-danger`.
