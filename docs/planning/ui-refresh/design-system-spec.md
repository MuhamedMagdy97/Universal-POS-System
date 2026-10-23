# Design System and App Shell (UI Refresh A): Specification

Status: **Draft for the owner's review (2026-10-24).** Visual direction "A. Calm light sidebar" chosen by the owner.

Source: [overview](README.md). Today the app has four colour tokens (`app/globals.css`), no shared components, no icons
and a wrapping top bar of text links (`app/(app)/layout.tsx`). The same Tailwind strings repeat across 127 files (for
example the text input string 46 times, `text-red-700` 45 times).

## 1. Goal

One consistent, modern look for every screen in English and Arabic, light and dark, without changing what any screen
does. This is the base that sub-project B gives a per-business accent and layout.

## 2. Decisions

| #   | Question               | Decision (recommended)                                                                                                                                                                                                                                                                                         |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DS1 | How are styles shared? | Semantic tokens and a small set of component classes in `app/globals.css` (`@layer components`), swapped in for the repeated Tailwind strings. No React component kit, no UI library: works in Server Components, no new imports across 127 files, smallest diff.                                                          |
| DS2 | Tokens                 | `--page`, `--surface`, `--surface-raised`, `--foreground`, `--muted`, `--border`, `--border-strong`, `--accent`, `--accent-foreground`, `--accent-soft`, `--success`, `--warning`, `--danger` (+ `-soft` tints), each with a dark value. Exposed to Tailwind through `@theme inline` (`bg-surface`, `text-danger`, ...). The old `--background` maps to `--page` so nothing breaks mid-change. |
| DS3 | Accent                 | `--accent` defaults to blue. Sub-project B overrides it per business type with one attribute on `<body>`; A only reads the variable.                                                                                                                                                                              |
| DS4 | Dark mode              | Follows the device (`prefers-color-scheme`), as today. No manual toggle.                                                                                                                                                                                                                                       |
| DS5 | Font                   | IBM Plex Sans Arabic (Arabic and Latin in one family), weights 400/500/600, self-hosted by `next/font/google` at build time, so the CSP (`font-src 'self'`) does not change. The current system stack stays as the fallback. Numbers keep `tabular-nums`.                                                                    |
| DS6 | Icons                  | One file `app/_ui/icons.tsx` with about 25 inline SVG icons taken from Lucide (ISC licence, kept in the file header). `aria-hidden` by default. No dependency.                                                                                                                                                          |
| DS7 | Component classes      | `btn` + `btn-primary` / `btn-danger` / `btn-ghost`, `input` (inputs, selects, textareas), `card`, `table` (header, rows, numeric cells end-aligned), `badge` + tones, `notice` + tones (error, success, info), `field` (label + control + hint). Focus ring on every control. Touch target at least 40 px; 48 px on the till.        |
| DS8 | Shell                  | Start-side sidebar (icon + label), mirrored in Arabic by logical properties. Collapses to icons on `/pos` and below 1024 px; a drawer (native `<dialog>`) below 640 px. The current permission-gated nav link components are kept and take an icon; the active link is highlighted. Top bar: shop badge, language toggle, account, sign out. |
| DS9 | Page parts             | A shared page header (title, optional subtitle, actions slot) and a stat tile, as small Server Components in `app/_ui/`. The dashboard tiles use the stat tile.                                                                                                                                                         |
| DS10 | Screens               | All 46 pages and their components move to the tokens and classes. Layout, behaviour, text and accessible names stay the same. Printing (`.print-root`, receipts, A4) is untouched.                                                                                                                                  |
| DS11 | Till                  | Larger touch targets, the cart and total in a sticky panel at the end side, the pay button in the accent colour. No logic change and no split of `till.tsx` (that is B).                                                                                                                                             |
| DS12 | Public pages          | Sign-in, welcome and onboarding get a centred card layout with the shop-agnostic brand mark.                                                                                                                                                                                                                         |

## 3. Out of scope

Per-business colours, icons, wording, dashboard tiles and till layouts (B); weighed selling, restaurant and salon
features (C, D, E); any API, schema or migration change; a manual dark-mode switch; new screens.

## 4. Delivery

Two PRs, merged in order:

1. Tokens, font, icons, component classes, shell and page parts; dashboard and public pages restyled.
2. Every other screen restyled (catalog, inventory, purchasing, customers, returns, reports, audit, settings, till).

## 5. Tests

- Lint, `tsc`, unit, integration and the full E2E suite stay green (E2E selects by role and text).
- E2E: in Arabic the sidebar sits on the right (`dir="rtl"`, sidebar's bounding box on the end of the viewport); on
  `/pos` the sidebar is collapsed; nav links still follow permissions (a Cashier sees no Purchasing link).
- E2E `csp.spec.ts` still passes with the self-hosted font.
- Manual: screenshots of the dashboard, the till and one report in EN/AR × light/dark, checked by eye; colour contrast
  of text tokens at least 4.5:1 on their surfaces.
