# Design System and App Shell (UI Refresh A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One consistent look (tokens, font, icons, component classes, sidebar shell) on every screen, EN/AR,
light/dark, with no behaviour change.

**Architecture:** Semantic CSS variables and `@layer components` classes in `app/globals.css`; a few small shared parts
in `app/_ui/`; a sidebar shell in `app/(app)/layout.tsx` built from the existing permission-gated nav link components.
Screens swap repeated Tailwind strings for the classes.

**Tech Stack:** Next.js 16.4 (App Router, Cache Components, nonce CSP), Tailwind 4, `next/font/google`, Playwright.

**Spec:** [design-system-spec.md](design-system-spec.md)

## Global Constraints

- No new runtime dependency (DS1, DS6). No API, schema or migration change.
- CSP in `proxy.ts` unchanged: `font-src 'self'`, `style-src 'self' 'unsafe-inline'`.
- Logical properties only (`ms-`, `pe-`, `start-`, `border-s`), never `left`/`right`/`ml`/`pr`.
- Accessible names and visible text of every link, button and heading unchanged (E2E selects by them). The nav keeps
  `aria-label="Main"`; the shop name stays inside the `banner` landmark.
- Printing (`.print-root`, `@page receipt`, `@page a4`, `printing.tsx`) untouched.
- Touch targets ≥ 40 px (`btn`, `input`); ≥ 48 px on `/pos`.
- Text tokens ≥ 4.5:1 contrast on `--page` and `--surface` in both themes.

## Review Focus

- Long Arabic shop/branch names or nav labels overflow the sidebar or top bar → truncate with `truncate` and a `title`.
  Test: Task 3 E2E sets a 60-character shop name and asserts no horizontal scroll (`scrollWidth <= clientWidth`).
- Phone width (375 px): wide report and stock tables push the page sideways → every `table` sits in `.table-wrap`
  (`overflow-x: auto`). Test: Task 6 E2E opens `/reports` at 375 px and asserts no page-level horizontal scroll.
- Numbers and money in RTL keep their `dir="ltr"` spans; the swap must not drop them. Test: the existing
  `catalog-rtl.spec.ts` and reports Arabic E2E stay green (Task 7).
- Dark mode: `text-danger` / `text-success` on soft tints unreadable → token values below are pre-checked; Task 7
  screenshots in dark mode are reviewed by eye.
- The collapsed sidebar on `/pos` hides labels visually only (`sr-only`), so links keep their names. Test: Task 3 E2E.

## Token values (DS2)

| Token                | Light     | Dark      |
| -------------------- | --------- | --------- |
| `--page`             | `#f6f7f9` | `#0d0f12` |
| `--surface`          | `#ffffff` | `#15181d` |
| `--surface-sunken`   | `#f1f3f5` | `#1c2026` |
| `--foreground`       | `#111827` | `#e8eaed` |
| `--muted`            | `#5b6472` | `#9aa3ae` |
| `--border`           | `#e3e6ea` | `#262b32` |
| `--border-strong`    | `#cfd4da` | `#353b44` |
| `--accent`           | `#1d5fd1` | `#5b9cf5` |
| `--accent-foreground`| `#ffffff` | `#0b1220` |
| `--accent-soft`      | `#e8f0fd` | `#14233a` |
| `--success` / `-soft`| `#15803d` / `#e7f6ec` | `#4ade80` / `#10291a` |
| `--warning` / `-soft`| `#b45309` / `#fdf3e4` | `#fbbf24` / `#2e230b` |
| `--danger` / `-soft` | `#b91c1c` / `#fdecec` | `#f87171` / `#2e1414` |

`--background` stays as an alias of `--page` (DS2).

---

### Task 1: Tokens, font and component classes

**Files:**
- Modify: `app/globals.css`, `app/layout.tsx`

**Interfaces:**
- Produces: Tailwind colours `page surface surface-sunken foreground muted border border-strong accent
  accent-foreground accent-soft success success-soft warning warning-soft danger danger-soft`; classes `btn btn-primary
  btn-danger btn-ghost btn-sm input card table table-wrap badge badge-{neutral,accent,success,warning,danger} notice
  notice-{error,success,info} field field-hint sr-only`; `--font-sans` from Plex.

- [ ] **Step 1:** Tokens per the table above under `:root` and `@media (prefers-color-scheme: dark)`; `@theme inline`
  maps each to `--color-*`; `--font-sans: var(--font-plex), system stack`.
- [ ] **Step 2:** Component classes in `@layer components` with `@apply`: `btn` = inline-flex, gap-2, min-h-10, px-4,
  rounded-lg, border border-strong, bg-surface, font-medium, focus-visible ring-2 ring-accent; `btn-primary` = accent
  fill; `btn-danger` = danger fill; `btn-ghost` = no border/background, hover `surface-sunken`; `input` = min-h-10,
  w-full, rounded-lg, border, bg-surface, px-3; `card` = rounded-xl, border, bg-surface, p-5; `table` = w-full,
  text-sm, `th` muted/start/medium with bottom border, `td` py-2.5 with bottom border, last row no border;
  `table-wrap` = overflow-x-auto rounded-xl border bg-surface; `badge` = inline-flex rounded-full px-2 text-xs; tones
  use the `-soft` background with the solid text; `notice` = rounded-lg px-4 py-3 text-sm with tone colours;
  `field` = flex-col gap-1.5 with `label` text-sm font-medium; `field-hint` = text-xs muted.
- [ ] **Step 3:** `app/layout.tsx`: `IBM_Plex_Sans_Arabic({ subsets: ["arabic", "latin"], weight: ["400","500","600"],
  variable: "--font-plex", display: "swap" })`, class on `<html>`; `<body>` gets `bg-page text-foreground`.
- [ ] **Step 4:** Run `npm run build` → succeeds; `npx playwright test tests/e2e/csp.spec.ts` → PASS (font served
  from `/_next/static/media`).
- [ ] **Step 5:** Commit "UI refresh A: tokens, Plex font, component classes".

### Task 2: Icons and page parts

**Files:**
- Create: `app/_ui/icons.tsx`, `app/_ui/page-header.tsx`, `app/_ui/stat-tile.tsx`

**Interfaces:**
- Produces: `type IconName = "dashboard" | "till" | "returns" | "customers" | "catalog" | "inventory" | "purchasing" |
  "reports" | "settings" | "account" | "signOut" | "language" | "menu" | "close" | "store" | "plus" | "search" |
  "download" | "print" | "alert" | "check" | "chevron" | "trash" | "edit" | "cash"`;
  `Icon({ name, className? }: { name: IconName; className?: string }): JSX.Element` (24 viewBox, stroke
  `currentColor`, width 2, `aria-hidden`, default `size-5`);
  `PageHeader({ title, subtitle?, actions? }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode })` renders
  `<header>` with an `<h1>` (text-2xl font-semibold) and actions at the end, wrapping on small screens;
  `StatTile({ label, value, href?, tone? }: { label: string; value: string; href?: string; tone?: "neutral" | "warning" })`
  renders a `card` (a `Link` when `href`), label muted, value `text-2xl font-semibold tabular-nums` in `dir="ltr"`.
  `page-header.tsx` uses `<header>` without a `banner` role (`role="presentation"` not needed: it is inside `<main>`).
- [ ] **Step 1:** Write the three files; icon paths copied from Lucide with the ISC notice in the header comment.
- [ ] **Step 2:** `npm run typecheck && npm run lint` → clean.
- [ ] **Step 3:** Commit "UI refresh A: icons, page header, stat tile".

### Task 3: Sidebar shell

**Files:**
- Create: `app/(app)/_components/nav-item.tsx` (client), `app/(app)/_components/sidebar.tsx` (client)
- Modify: `app/(app)/layout.tsx`, the eight `*-nav-link.tsx`, `locale-toggle.tsx`, `account-link.tsx`,
  `sign-out-button.tsx`, `tenant-badge.tsx`, `loading-org.tsx`
- Test: `tests/e2e/shell.spec.ts`

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 2); classes (Task 1).
- Produces: `NavItem({ href, label, icon, match? }: { href: string; label: string; icon: IconName; match?: string })`
  — `Link` with `aria-current="page"` when `usePathname()` starts with `match ?? href`; label in a span that becomes
  `sr-only` when the sidebar is collapsed (`group-data-[collapsed=true]:sr-only`).
  `Sidebar({ children }: { children: ReactNode })` — `<aside data-collapsed>` collapsed when the path starts with
  `/pos` or below 1024 px (CSS `lg:` breakpoint); below 640 px hidden off-canvas, opened by a menu `btn-ghost`
  (`aria-expanded`, `aria-controls`) in the top bar and closed by Escape, the close button, or a route change.
- Each nav link file keeps its permission check and renders `<NavItem>`; the Settings link uses `match="/settings"`,
  Catalog `/catalog`, etc. Dashboard gets a `NavItem` too (`/dashboard`, icon `dashboard`, label `dashboard.title`).
- Layout: `flex min-h-dvh` → `Sidebar` (brand mark "Universal POS" + `<nav aria-label="Main">` with the items) and a
  column with the top bar `<header>` (menu button, `TenantBadge` truncated, then `LocaleToggle`, `AccountLink`,
  `SignOutButton` as `btn-ghost btn-sm` with icons) and `<main className="flex-1 px-4 py-6 lg:px-8">`.
  Deviation from DS8 to record in the as-built note: the phone drawer is the same `<aside>` slid in, not a `<dialog>`,
  so the links exist once in the DOM.

- [ ] **Step 1: Write the failing E2E** `tests/e2e/shell.spec.ts` (owner storage state as in existing specs):
  - "sidebar is on the start side in English and the end side in Arabic": in EN the `navigation "Main"` box's x < 100;
    switch locale (`"عربي"` button), the box's right edge > viewport width − 100.
  - "till collapses the sidebar but keeps link names": goto `/pos`, aside `data-collapsed="true"`,
    `getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" })` visible.
  - "active link is marked": goto `/reports`, the Reports link has `aria-current="page"`.
  - "phone width opens the menu": viewport 375×800, nav hidden; click `button` named "Menu", nav visible; Escape hides
    it.
  - "long shop name does not scroll the page": rename the shop to 60 characters via the existing settings route,
    reload `/dashboard`, `document.documentElement.scrollWidth <= clientWidth`.
  - Cashier: `navigation "Main"` has no "Purchasing" link (cashier storage state).
- [ ] **Step 2:** Run `npx playwright test tests/e2e/shell.spec.ts` → FAIL (no `data-collapsed`, no Menu button).
- [ ] **Step 3:** Implement the files above; add i18n keys `app.menu` ("Menu" / "القائمة") and
  `app.closeMenu` ("Close menu" / "إغلاق القائمة") to `lib/i18n/messages/en.ts` and `ar.ts`.
- [ ] **Step 4:** Run the shell spec plus `hardening.spec.ts`, `audit.spec.ts`, `inventory-access.spec.ts`,
  `onboarding.spec.ts` → PASS.
- [ ] **Step 5:** Commit "UI refresh A: sidebar shell".

### Task 4: Dashboard and public pages (end of PR 1)

**Files:**
- Modify: `app/(app)/dashboard/page.tsx`, `app/(public)/layout.tsx`, `app/(public)/login/*`,
  `app/(public)/welcome/page.tsx`, `app/(public)/onboarding/*`

- [ ] **Step 1:** Dashboard: `PageHeader` (title, greeting as subtitle), tiles as `StatTile` in a
  `grid-cols-2 lg:grid-cols-4` grid, low-stock tile `tone="warning"` when the count > 0; link names unchanged
  (`/Low stock at/` still matches).
- [ ] **Step 2:** Public layout: centred column `max-w-md`, brand mark with the `store` icon, forms inside a `card`,
  inputs `input`, submit `btn btn-primary w-full`, errors `notice notice-error`.
- [ ] **Step 3:** `npx playwright test tests/e2e/onboarding.spec.ts tests/e2e/inventory-low-stock.spec.ts` plus the
  auth setup → PASS.
- [ ] **Step 4:** Full gate: `npm run lint && npm run typecheck && npm run format:check && npm test && npx playwright
  test` → all green. Commit, push, open PR 1 "UI refresh A (1/2): design system and shell".

### Task 5: Mechanical swap across screens

**Files:**
- Modify: every `.tsx` under `app/(app)/**` except the shell files from Task 3 and print components
  (`printing.tsx`, `receipt-print.tsx`, `zreport-print.tsx`, any `*-print*.tsx`).

- [ ] **Step 1:** List repeated class strings: `grep -rho 'className="[^"]*"' app --include=*.tsx | sort | uniq -c |
  sort -rn | head -60`.
- [ ] **Step 2:** Swap exact strings with a one-off script in the scratchpad (not committed), at least:
  - `rounded-md border border-border bg-background px-3 py-2` → `input`
  - `rounded-md border border-border px-4 py-2` → `btn`
  - `text-red-700` → `text-danger`; `text-green-700` → `text-success`; `text-amber-700` → `text-warning`
  - `text-2xl font-semibold` on `<h1>` stays (PageHeader is used where a page already has title + actions row)
  - primary submit buttons (`bg-foreground text-background` variants) → `btn btn-primary`
  - `<table className="...">` → `table`, wrapped in `<div className="table-wrap">` where not already wrapped
  - `role="alert"` paragraphs with red text → `notice notice-error`
- [ ] **Step 3:** `git diff --stat` and read the diff for each module; `npm run lint && npm run typecheck` → clean.
- [ ] **Step 4:** Commit "UI refresh A: swap repeated styles for design-system classes".

### Task 6: Screen-by-screen pass and the till

**Files:**
- Modify: pages and `_components` in catalog, inventory, purchasing, customers, returns, reports, audit, settings,
  account, pos.
- Test: `tests/e2e/shell.spec.ts` (add one case)

- [ ] **Step 1:** Add the failing case "reports fit a phone": viewport 375×800, goto `/reports?report=sales-summary&range=today`,
  page `scrollWidth <= clientWidth`. Run → FAIL if any table is unwrapped.
- [ ] **Step 2:** Per module: `PageHeader` where a page has a title with actions, filters in a `card`, lists in
  `table-wrap`, statuses as `badge` tones (draft neutral, ordered/partly accent, received/completed success,
  cancelled/voided danger, waiting warning). Remaining hard-coded greys (`gray-*`, `zinc-*`, `bg-white`) → tokens.
- [ ] **Step 3:** Till (DS11): two columns at `lg` — search/results start side, cart + totals + pay end side in a
  `sticky top-4 card`; all till buttons and inputs `min-h-12`; Pay is `btn btn-primary`; no logic change.
- [ ] **Step 4:** `npx playwright test tests/e2e/shell.spec.ts tests/e2e/pos*.spec.ts` → PASS.
- [ ] **Step 5:** Commit per module group (catalog+inventory, purchasing+customers+returns, reports+audit+settings+account,
  till).

### Task 7: Verification and PR 2

- [ ] **Step 1:** Full gate as in Task 4 Step 4 → all green.
- [ ] **Step 2:** Screenshots in the browser pane: `/dashboard`, `/pos`, `/reports` in EN/AR × light/dark; check
  contrast, truncation, RTL mirroring.
- [ ] **Step 3:** Write `docs/planning/ui-refresh/design-system-as-built.md` (deviations: drawer is the same aside;
  anything else found) and update `docs/planning/phase-status.md`.
- [ ] **Step 4:** Commit, push, open PR 2 "UI refresh A (2/2): screens restyled", based on PR 1's branch; merge PR 1
  then PR 2 once CI is green and the diff is reviewed.
