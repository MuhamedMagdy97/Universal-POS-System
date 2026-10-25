"use client";

import { useState } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { TicketView } from "@/modules/sales";

export type OrderType = TicketView["orderType"];

const TYPES: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY"];

/**
 * The café's order bar (restaurant-cafe-spec R2, R4-R6, R10): the order type of a new order (and its delivery
 * address), or the open ticket's table and number; Tables, Hold, Send to kitchen, Move and Cancel.
 */
export function TicketBar({
  locale,
  ticket,
  orderType,
  onOrderType,
  deliveryAddress,
  onDeliveryAddress,
  hasLines,
  pending,
  onTables,
  onHold,
  onSend,
  onMove,
  onCancel,
}: {
  locale: Locale;
  ticket: TicketView | null;
  orderType: OrderType;
  onOrderType: (type: OrderType) => void;
  deliveryAddress: string;
  onDeliveryAddress: (value: string) => void;
  hasLines: boolean;
  pending: boolean;
  onTables: () => void;
  onHold: () => void;
  onSend: () => void;
  onMove: () => void;
  onCancel: (reason: string | undefined) => void;
}) {
  const tr = translator(locale);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const sent = ticket?.lines.some((line) => line.sentQty > 0) ?? false;

  return (
    <div className="card flex flex-col gap-2" data-testid="ticket-bar">
      <div className="flex flex-wrap items-center gap-2">
        {ticket ? (
          <p className="font-semibold" data-testid="ticket-place">
            {ticket.table
              ? tr("pos.ticket.atTable", { name: ticket.table.name, number: ticket.number })
              : tr("pos.ticket.held", { type: tr(`pos.ticket.type.${ticket.orderType}`), number: ticket.number })}
          </p>
        ) : (
          <div role="radiogroup" aria-label={tr("pos.ticket.orderType")} className="flex gap-1">
            {TYPES.map((type) => (
              <label
                key={type}
                className="flex min-h-12 cursor-pointer items-center rounded-lg border border-border-strong px-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="orderType"
                  checked={orderType === type}
                  onChange={() => onOrderType(type)}
                />
                {tr(`pos.ticket.type.${type}`)}
              </label>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onTables} disabled={pending}>
          {tr("pos.tables.title")}
        </button>
        <button type="button" className="btn" onClick={onHold} disabled={pending || (!ticket && !hasLines)}>
          {tr("pos.ticket.hold")}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSend} disabled={pending || !hasLines}>
          {tr("pos.ticket.send")}
        </button>
        {ticket?.orderType === "DINE_IN" ? (
          <button type="button" className="btn" onClick={onMove} disabled={pending}>
            {tr("pos.ticket.move")}
          </button>
        ) : null}
        {ticket ? (
          <button type="button" className="btn" onClick={() => setCancelling(true)} disabled={pending}>
            {tr("pos.ticket.cancel")}
          </button>
        ) : null}
      </div>
      {!ticket && orderType === "DELIVERY" ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{tr("pos.ticket.address")}</span>
          <input
            className="input"
            dir="auto"
            maxLength={200}
            value={deliveryAddress}
            onChange={(event) => onDeliveryAddress(event.target.value)}
          />
        </label>
      ) : null}
      {cancelling ? (
        <div className="flex flex-wrap items-end gap-2" role="group" aria-label={tr("pos.ticket.cancel")}>
          {sent ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm">{tr("pos.ticket.cancelReason")}</span>
              <input className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          ) : (
            <p className="text-sm">{tr("pos.ticket.cancelSure")}</p>
          )}
          <button
            type="button"
            className="btn"
            disabled={pending || (sent && reason.trim() === "")}
            onClick={() => {
              onCancel(reason.trim() || undefined);
              setCancelling(false);
              setReason("");
            }}
          >
            {tr("pos.ticket.cancelConfirm")}
          </button>
          <button type="button" className="btn" onClick={() => setCancelling(false)}>
            {tr("pos.options.cancel")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
