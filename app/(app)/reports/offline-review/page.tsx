import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { translator, type Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { formatLocalDateTime, formatRateBp } from "@/modules/reports";
import { listOfflineReview, type OfflineReviewPage, type OfflineReviewRow } from "@/modules/sales";
import { markReviewedAction } from "./actions";

/**
 * Offline sales to review (offline-till-spec OF13, slice 4): flagged offline sales, newest received first, 50 per
 * page. `sales.review` (Owner, Admin, Manager); the service re-checks and logs a refusal.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function OfflineReviewPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReviewContent searchParams={searchParams} />
    </Suspense>
  );
}

function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="card flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{tr("review.state.forbidden")}</h1>
      <p className="text-muted">{tr("review.state.forbiddenBody")}</p>
    </section>
  );
}

type Details = Record<string, unknown>;
const list = (value: unknown): Details[] => (Array.isArray(value) ? (value as Details[]) : []);
const n = (value: unknown): number => (typeof value === "number" ? value : 0);

/** What the manager sees for one flag (OF13 "Manager sees"). */
function flagLines(row: OfflineReviewRow, flag: string, details: Details, locale: Locale, zone: string): string[] {
  const tr = translator(locale);
  const money = (minor: number) => formatMoney(minor, row.currency as CurrencyCode, locale);
  const time = (iso: unknown) => (typeof iso === "string" ? formatLocalDateTime(new Date(iso), zone) : "—");
  const item = (sku: unknown) => {
    const found = row.items.find((line) => line.sku === sku);
    const name = found ? (locale === "ar" && found.nameAr ? found.nameAr : found.name) : "";
    return name ? `${name} (${String(sku)})` : String(sku);
  };
  switch (flag) {
    case "PRICE_CHANGED":
      return list(details.lines).map((line) =>
        tr("review.detail.price", {
          item: item(line.sku),
          sold: money(n(line.soldMinor)),
          current: money(n(line.currentMinor)),
          diff: money(n(line.soldMinor) - n(line.currentMinor)),
        }),
      );
    case "OPTIONS_CHANGED":
      return (Array.isArray(details.skus) ? details.skus : []).map((sku) =>
        tr("review.detail.options", { item: item(sku) }),
      );
    case "ITEM_ARCHIVED":
      return (Array.isArray(details.skus) ? details.skus : []).map((sku) =>
        tr("review.detail.archived", { item: item(sku) }),
      );
    case "STOCK_NEGATIVE":
      return list(details.lines).map((line) =>
        tr("review.detail.stock", {
          item: item(line.sku),
          qty: formatQty(n(line.qty), line.unitType === "KG" ? "KG" : "EACH", locale),
        }),
      );
    case "DISCOUNT_OVER_LIMIT":
      return [
        tr("review.detail.discount", {
          cashier: row.cashierName ?? "—",
          discount: money(n(details.discountMinor)),
          limit: formatRateBp(n(details.limitBp)),
        }),
      ];
    case "LATE_FOR_CLOSED_SHIFT":
      return [
        tr("review.detail.late", {
          register: row.registerName,
          opened: formatLocalDateTime(row.shift.openedAt, zone),
          closed: row.shift.closedAt ? formatLocalDateTime(row.shift.closedAt, zone) : "—",
          cash: money(row.status === "COMPLETED" ? row.cashMinor : 0),
        }),
      ];
    case "STALE_SNAPSHOT":
      return [tr("review.detail.stale", { snapshot: time(details.snapshotAt), sold: time(details.soldAt) })];
    case "CLOCK_SKEW":
      return [
        tr("review.detail.clock", {
          sold: time(details.soldAt),
          received: time(details.receivedAt),
          opened: time(details.shiftOpenedAt),
        }),
      ];
    case "TOTALS_DIFFER": {
      const device = (details.device ?? {}) as Details;
      const server = (details.server ?? {}) as Details;
      return [tr("review.detail.totals", { device: money(n(device.totalMinor)), server: money(n(server.totalMinor)) })];
    }
    default:
      return [];
  }
}

const FLAG_LABELS = {
  PRICE_CHANGED: "review.flag.PRICE_CHANGED",
  ITEM_ARCHIVED: "review.flag.ITEM_ARCHIVED",
  OPTIONS_CHANGED: "review.flag.OPTIONS_CHANGED",
  STOCK_NEGATIVE: "review.flag.STOCK_NEGATIVE",
  DISCOUNT_OVER_LIMIT: "review.flag.DISCOUNT_OVER_LIMIT",
  LATE_FOR_CLOSED_SHIFT: "review.flag.LATE_FOR_CLOSED_SHIFT",
  STALE_SNAPSHOT: "review.flag.STALE_SNAPSHOT",
  CLOCK_SKEW: "review.flag.CLOCK_SKEW",
  TOTALS_DIFFER: "review.flag.TOTALS_DIFFER",
} as const;

async function ReviewContent({ searchParams }: { searchParams: SearchParams }) {
  const [params, locale, requestHeaders] = await Promise.all([searchParams, getLocale(), headers()]);
  const tr = translator(locale);

  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Freports%2Foffline-review");
    if (err instanceof AppError && err.code === "FORBIDDEN") return <Denied locale={locale} />;
    throw err;
  }
  if (!hasPermission(ctx.role, "sales.review")) return <Denied locale={locale} />;

  const cursor = typeof params.cursor === "string" && params.cursor !== "" ? params.cursor : undefined;
  let page: OfflineReviewPage;
  try {
    page = await listOfflineReview(ctx, { cursor });
  } catch (err) {
    if (err instanceof AppError && err.code === "VALIDATION_FAILED") redirect("/reports/offline-review");
    throw err;
  }
  const zone = page.timezone;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("review.title")}</h1>
      <p className="text-muted">{tr("review.intro")}</p>
      {page.rows.length === 0 ? <p className="text-muted">{tr("review.empty")}</p> : null}

      {page.rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{tr("review.col.sale")}</th>
                <th scope="col">{tr("review.col.register")}</th>
                <th scope="col">{tr("review.col.cashier")}</th>
                <th scope="col">{tr("review.col.soldAt")}</th>
                <th scope="col">{tr("review.col.receivedAt")}</th>
                <th scope="col" className="text-end">
                  {tr("review.col.total")}
                </th>
                <th scope="col">{tr("review.col.flags")}</th>
                <th scope="col" className="px-2 py-2">
                  <span className="sr-only">{tr("review.mark")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.saleId} className="border-b border-border align-top" data-testid="review-row">
                  <td dir="ltr" className="whitespace-nowrap">
                    {row.number}
                    {row.status === "VOIDED" ? (
                      <span className="block text-xs text-muted">{tr("review.voided")}</span>
                    ) : null}
                  </td>
                  <td>
                    {row.branchName} · {row.registerName}
                  </td>
                  <td>{row.cashierName ?? "—"}</td>
                  <td dir="ltr" className="whitespace-nowrap">
                    {formatLocalDateTime(row.soldAt, zone)}
                  </td>
                  <td dir="ltr" className="whitespace-nowrap">
                    {formatLocalDateTime(row.receivedAt, zone)}
                  </td>
                  <td dir="ltr" className="px-2 py-2 text-end whitespace-nowrap">
                    {formatMoney(row.totalMinor, row.currency as CurrencyCode, locale)}
                  </td>
                  <td>
                    <ul className="flex flex-col gap-1">
                      {row.flags.map(({ flag, details }) => (
                        <li key={flag}>
                          <span className="font-medium">
                            {flag in FLAG_LABELS ? tr(FLAG_LABELS[flag as keyof typeof FLAG_LABELS]) : flag}
                          </span>
                          {flagLines(row, flag, details, locale, zone).map((line) => (
                            <span key={line} className="block text-xs">
                              {line}
                            </span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <form action={markReviewedAction}>
                      <input type="hidden" name="saleId" value={row.saleId} />
                      <button type="submit" className="btn btn-sm whitespace-nowrap">
                        {tr("review.mark")}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex gap-3">
        {cursor ? (
          <Link href="/reports/offline-review" className="btn">
            {tr("audit.page.newest")}
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link href={`/reports/offline-review?${new URLSearchParams({ cursor: page.nextCursor })}`} className="btn">
            {tr("audit.page.older")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
