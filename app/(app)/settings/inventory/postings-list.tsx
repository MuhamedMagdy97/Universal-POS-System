"use client";

import { useState } from "react";
import Link from "next/link";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import type { InventoryPosting } from "@/modules/integrations/inventory-sys";
import { plain, safeAction } from "../../inventory/_lib/form";
import { retryInventoryPostingAction } from "../actions";
import { inventoryErrorKey } from "../_lib/inventory";

/** A posting row with its times already formatted in the shop's timezone (by the page, on the server). */
export type PostingRow = InventoryPosting & { nextAttemptLocal: string };

const button = "btn btn-sm";

/**
 * Postings waiting or refused (integration spec I19, I22), 20 a page, with Retry (Owner, Admin).
 * The page refreshes after a retry (the action revalidates it).
 */
export function PostingsList({
  locale,
  rows,
  page,
  hasMore,
}: {
  locale: Locale;
  rows: PostingRow[];
  page: number;
  hasMore: boolean;
}) {
  const tr = translator(locale);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; key: MessageKey } | null>(null);

  async function retry(id: string) {
    setBusy(id);
    setNotice(null);
    const result = await safeAction(() => retryInventoryPostingAction(id));
    setBusy(null);
    setNotice(
      result.ok
        ? { tone: "ok", key: `settings.inventory.postingsList.retried.${result.data.status}` }
        : { tone: "error", key: inventoryErrorKey(result.error) },
    );
  }

  return (
    <section aria-labelledby="inv-postings" className="flex flex-col gap-2">
      <h2 id="inv-postings" className="text-lg font-medium">
        {tr("settings.inventory.postingsList")}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{tr("settings.inventory.postingsList.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="inventory-postings-list" className="w-full text-sm">
            <thead>
              <tr className="text-start">
                <th>{tr("settings.inventory.postingsList.kind")}</th>
                <th>{tr("settings.inventory.postingsList.document")}</th>
                <th>{tr("settings.inventory.postingsList.status")}</th>
                <th>{tr("settings.inventory.postingsList.attempts")}</th>
                <th>{tr("settings.inventory.postingsList.error")}</th>
                <th>{tr("settings.inventory.postingsList.next")}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{tr(`settings.inventory.postingsList.kind.${row.kind}`)}</td>
                  <td>
                    {tr(`settings.inventory.postingsList.document.${row.document}`, {
                      number: row.saleNumber ?? "—",
                    })}
                  </td>
                  <td>
                    {tr(`settings.inventory.postingsList.status.${row.status}`)}
                    {row.stale ? (
                      <span className="ms-2 font-medium text-danger">
                        {tr("settings.inventory.postingsList.stale")}
                      </span>
                    ) : null}
                  </td>
                  <td>{row.attempts}</td>
                  <td dir="ltr">{row.lastErrorCode ?? "—"}</td>
                  <td dir="ltr">{row.status === "PENDING" ? row.nextAttemptLocal : "—"}</td>
                  <td>
                    <button type="button" className={button} disabled={busy !== null} onClick={() => retry(row.id)}>
                      {busy === row.id ? tr("settings.inventory.working") : tr("settings.inventory.postingsList.retry")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page > 1 || hasMore ? (
        <nav className="flex gap-3 text-sm" aria-label={tr("settings.inventory.postingsList")}>
          {page > 1 ? (
            <Link href={`/settings/inventory?page=${page - 1}`} className="underline">
              {tr("settings.inventory.postingsList.previous")}
            </Link>
          ) : null}
          {hasMore ? (
            <Link href={`/settings/inventory?page=${page + 1}`} className="underline">
              {tr("settings.inventory.postingsList.more")}
            </Link>
          ) : null}
        </nav>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={notice.tone === "error" ? "text-danger" : "text-success"}
        >
          {plain(locale, notice.key)}
        </p>
      ) : null}
    </section>
  );
}
