"use client";

import { useEffect, useState } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { DiningTableRow } from "@/modules/org";
import type { TicketSummary, TicketView } from "@/modules/sales";
import { minutesOpen } from "../_lib/tickets";
import { floorAction, getTicketAction, openTicketAction } from "../ticket-actions";

/**
 * The floor (restaurant-cafe-spec R3, R4): a tile per table, free or with its open ticket's total and minutes open,
 * grouped by area, then held takeaway and delivery tickets. A free table opens a dine-in ticket; a busy one, or a
 * held ticket, loads it. In `move` mode a free table is where the current ticket goes.
 */
export function TablesView({
  locale,
  branchId,
  money,
  mode,
  onOpen,
  onMove,
  onError,
}: {
  locale: Locale;
  branchId: string;
  money: (minor: number) => string;
  mode: "open" | "move";
  onOpen: (ticket: TicketView) => void;
  onMove: (tableId: string) => void;
  onError: (message: string) => void;
}) {
  const tr = translator(locale);
  const [floor, setFloor] = useState<{ tables: DiningTableRow[]; tickets: TicketSummary[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    void floorAction(branchId).then((result) => {
      if (!live) return;
      if (result.ok) setFloor(result.data);
      else onError(tr("pos.error.generic"));
    });
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Load once per mount: the till remounts the floor when it is shown again.
  }, [branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(run: () => ReturnType<typeof getTicketAction>) {
    setBusy(true);
    const result = await run();
    setBusy(false);
    if (result.ok) onOpen(result.data);
    else onError(tr("pos.error.generic"));
  }

  if (!floor)
    return (
      <p aria-busy="true" className="text-muted">
        …
      </p>
    );
  const ticketOf = new Map(floor.tickets.filter((t) => t.tableId).map((t) => [t.tableId, t]));
  const areas = [...new Set(floor.tables.map((table) => table.area ?? ""))];
  const held = floor.tickets.filter((ticket) => !ticket.tableId);

  return (
    <section aria-label={tr("pos.tables.title")} className="flex flex-col gap-3" data-testid="tables-view">
      {floor.tables.length === 0 ? <p className="text-muted">{tr("pos.tables.none")}</p> : null}
      {areas.map((area) => (
        <div key={area} className="flex flex-col gap-2">
          {area ? <h3 className="text-sm font-medium text-muted">{area}</h3> : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
            {floor.tables
              .filter((table) => (table.area ?? "") === area)
              .map((table) => {
                const ticket = ticketOf.get(table.id);
                const disabled = busy || (mode === "move" && Boolean(ticket));
                return (
                  <button
                    key={table.id}
                    type="button"
                    disabled={disabled}
                    data-busy={Boolean(ticket)}
                    aria-label={
                      ticket
                        ? tr("pos.tables.busy", { name: table.name, total: money(ticket.totalMinor) })
                        : tr("pos.tables.free", { name: table.name })
                    }
                    onClick={() =>
                      mode === "move"
                        ? onMove(table.id)
                        : void pick(() =>
                            ticket
                              ? getTicketAction(ticket.id)
                              : openTicketAction({ branchId, orderType: "DINE_IN", tableId: table.id }),
                          )
                    }
                    className="flex min-h-20 flex-col items-center justify-center rounded-lg border border-border-strong p-2 data-[busy=true]:border-accent data-[busy=true]:bg-accent-soft disabled:opacity-50"
                  >
                    <span className="text-lg font-semibold">{table.name}</span>
                    {ticket ? (
                      <span className="text-sm" dir="ltr">
                        {money(ticket.totalMinor)} ·{" "}
                        {tr("pos.tables.minutes", { n: minutesOpen(ticket.openedAt, now) })}
                      </span>
                    ) : (
                      <span className="text-sm text-muted">{tr("pos.tables.freeShort")}</span>
                    )}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      {mode === "open" && held.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted">{tr("pos.tables.held")}</h3>
          <ul className="flex flex-wrap gap-2">
            {held.map((ticket) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void pick(() => getTicketAction(ticket.id))}
                >
                  {tr(`pos.ticket.type.${ticket.orderType}`)} #{ticket.number} ·{" "}
                  <bdi dir="ltr">{money(ticket.totalMinor)}</bdi>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
