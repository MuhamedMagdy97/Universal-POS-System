"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { AppointmentDay, AppointmentView } from "@/modules/appointments";
import { clock, daySlots, SLOT_MIN } from "@/modules/appointments/slots";
import { bookAppointmentAction, setAppointmentStatusAction } from "../actions";

type Staff = { id: string; name: string };
type Service = { id: string; name: string; nameAr: string | null; durationMin: number; priceMinor: number };
type Draft = { staffId: string; startMin: number; name: string; phone: string; serviceIds: string[]; note: string };

const ROW_PX = 28;
const ANY = "";

/**
 * The day (salon-spec S6): a column per staff member and one for "Any", 15-minute rows from opening to closing,
 * appointments as blocks. An empty slot books (S5); a block opens its details: arrived, cancel, no-show, check out
 * (S7). The list below shows the same day in order for small screens.
 */
export function DayCalendar({
  locale,
  currency,
  branchId,
  branches,
  data,
  staff,
  services,
}: {
  locale: Locale;
  currency: CurrencyCode;
  branchId: string;
  branches: { id: string; name: string }[];
  data: AppointmentDay;
  staff: Staff[];
  services: Service[];
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<AppointmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const slots = daySlots(data.opensAt, data.closesAt);
  const columns: Staff[] = [...staff, { id: ANY, name: tr("appointments.any") }];
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const nameOf = (service: { name: string; nameAr: string | null }) =>
    (locale === "ar" && service.nameAr) || service.name;
  const go = (next: { day?: string; branch?: string }) =>
    router.push(`/appointments?branch=${next.branch ?? branchId}&day=${next.day ?? data.day}`);

  function errorText(code: string, reason: string | undefined): string {
    if (reason === "SLOT_TAKEN") return tr("appointments.error.taken");
    if (reason === "CUSTOMER_REQUIRED") return tr("appointments.error.customer");
    if (reason === "APPOINTMENT_CHANGED") return tr("appointments.error.changed");
    if (code === "VALIDATION_FAILED") return tr("appointments.error.invalid");
    return tr("appointments.error.generic");
  }

  function book(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      const result = await bookAppointmentAction({
        branchId,
        day: data.day,
        startMin: draft.startMin,
        staffMemberId: draft.staffId === ANY ? null : draft.staffId,
        customerName: draft.name.trim() || undefined,
        customerPhone: draft.phone.trim() || undefined,
        serviceIds: draft.serviceIds,
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      });
      if (!result.ok) {
        setError(errorText(result.error.code, (result.error.details as { reason?: string } | null)?.reason));
        return;
      }
      setDraft(null);
      setError(null);
      router.refresh();
    });
  }

  function status(row: AppointmentView, next: "ARRIVED" | "CANCELLED" | "NO_SHOW" | "BOOKED") {
    startTransition(async () => {
      const result = await setAppointmentStatusAction(row.id, { version: row.version, status: next });
      if (!result.ok) {
        setError(errorText(result.error.code, (result.error.details as { reason?: string } | null)?.reason));
        return;
      }
      setOpen(null);
      setError(null);
      router.refresh();
    });
  }

  const visible = data.appointments.filter((row) => row.status !== "CANCELLED");

  return (
    <div className="flex flex-col gap-4" data-testid="day-calendar">
      <div className="flex flex-wrap items-end gap-3">
        <label className="field">
          <span className="text-sm">{tr("appointments.day")}</span>
          <input
            className="input"
            type="date"
            value={data.day}
            onChange={(e) => e.target.value && go({ day: e.target.value })}
          />
        </label>
        {branches.length > 1 ? (
          <label className="field">
            <span className="text-sm">{tr("appointments.branch")}</span>
            <select className="input" value={branchId} onChange={(e) => go({ branch: e.target.value })}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}

      <div className="table-wrap">
        <div
          className="grid min-w-max"
          style={{ gridTemplateColumns: `4rem repeat(${columns.length}, minmax(9rem, 1fr))` }}
          role="grid"
          aria-label={tr("appointments.title")}
        >
          <div />
          {columns.map((column) => (
            <div
              key={column.id || "any"}
              className="border-b border-border px-2 py-1 text-sm font-semibold"
              role="columnheader"
            >
              {column.name}
            </div>
          ))}
          <div className="relative" style={{ height: slots.length * ROW_PX }}>
            {slots.map((slot, index) =>
              slot % 60 === 0 ? (
                <span key={slot} className="absolute text-xs text-muted" style={{ top: index * ROW_PX }} dir="ltr">
                  {clock(slot)}
                </span>
              ) : null,
            )}
          </div>
          {columns.map((column) => (
            <div
              key={column.id || "any"}
              className="relative border-s border-border"
              style={{ height: slots.length * ROW_PX }}
            >
              {slots.map((slot, index) => (
                <button
                  key={slot}
                  type="button"
                  className="absolute inset-x-0 border-t border-border/50 hover:bg-accent-soft"
                  style={{ top: index * ROW_PX, height: ROW_PX }}
                  aria-label={tr("appointments.bookAt", { name: column.name, time: clock(slot) })}
                  onClick={() => {
                    setOpen(null);
                    setDraft({ staffId: column.id, startMin: slot, name: "", phone: "", serviceIds: [], note: "" });
                  }}
                />
              ))}
              {visible
                .filter((row) => (row.staff?.id ?? ANY) === column.id)
                .map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    data-status={row.status}
                    className="absolute inset-x-1 overflow-hidden rounded-md border border-accent bg-accent-soft p-1 text-start text-xs data-[status=DONE]:opacity-60 data-[status=NO_SHOW]:line-through"
                    style={{
                      top: ((row.startMin - data.opensAt) / SLOT_MIN) * ROW_PX,
                      height: Math.max(((row.endMin - row.startMin) / SLOT_MIN) * ROW_PX - 2, ROW_PX - 2),
                    }}
                    onClick={() => {
                      setDraft(null);
                      setOpen(row);
                    }}
                  >
                    <span className="block font-semibold">{row.customer.name}</span>
                    <span className="block">{row.services.map(nameOf).join(" · ")}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>

      {draft ? (
        <form onSubmit={book} className="card flex max-w-xl flex-col gap-3" aria-label={tr("appointments.book")}>
          <h2 className="text-lg font-semibold">
            {tr("appointments.bookFor", {
              name: columns.find((column) => column.id === draft.staffId)?.name ?? "",
              time: clock(draft.startMin),
            })}
          </h2>
          <div className="flex flex-wrap gap-3">
            <label className="field">
              <span className="text-sm">{tr("appointments.customer")}</span>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="text-sm">{tr("appointments.phone")}</span>
              <input
                className="input"
                dir="ltr"
                inputMode="tel"
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </label>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm">{tr("appointments.services")}</legend>
            {services.map((service) => (
              <label key={service.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.serviceIds.includes(service.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      serviceIds: e.target.checked
                        ? [...draft.serviceIds, service.id]
                        : draft.serviceIds.filter((id) => id !== service.id),
                    })
                  }
                />
                {nameOf(service)}
                <span className="text-sm text-muted" dir="ltr">
                  {tr("appointments.minutes", { n: service.durationMin })} · {money(service.priceMinor)}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span className="text-sm">{tr("appointments.note")}</span>
            <input
              className="input"
              maxLength={200}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={pending || draft.serviceIds.length === 0}>
              {tr("appointments.book")}
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              {tr("pos.options.cancel")}
            </button>
          </div>
        </form>
      ) : null}

      {open ? (
        <section
          className="card flex max-w-xl flex-col gap-2"
          aria-label={open.customer.name}
          data-testid="appointment-detail"
        >
          <h2 className="text-lg font-semibold">
            {open.customer.name} ·{" "}
            <bdi dir="ltr">
              {clock(open.startMin)}–{clock(open.endMin)}
            </bdi>
          </h2>
          <p className="text-sm text-muted">
            {open.customer.phone ? <bdi dir="ltr">{open.customer.phone}</bdi> : null} ·{" "}
            {open.staff?.name ?? tr("appointments.any")} · {tr(`appointments.status.${open.status}`)}
          </p>
          <p>{open.services.map(nameOf).join(" · ")}</p>
          {open.note ? <p className="text-sm">“{open.note}”</p> : null}
          {open.status === "BOOKED" || open.status === "ARRIVED" ? (
            <div className="flex flex-wrap gap-2">
              <Link href={`/pos?branch=${branchId}&appointment=${open.id}`} className="btn btn-primary">
                {tr("appointments.checkOut")}
              </Link>
              {open.status === "BOOKED" ? (
                <button type="button" className="btn" disabled={pending} onClick={() => status(open, "ARRIVED")}>
                  {tr("appointments.arrived")}
                </button>
              ) : null}
              <button type="button" className="btn" disabled={pending} onClick={() => status(open, "NO_SHOW")}>
                {tr("appointments.noShow")}
              </button>
              <button type="button" className="btn" disabled={pending} onClick={() => status(open, "CANCELLED")}>
                {tr("appointments.cancel")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label={tr("appointments.list")} className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{tr("appointments.list")}</h2>
        {data.appointments.length === 0 ? <p className="text-muted">{tr("appointments.none")}</p> : null}
        <ul className="flex flex-col gap-1">
          {data.appointments.map((row) => (
            <li key={row.id} className="flex flex-wrap gap-x-3">
              <bdi dir="ltr">{clock(row.startMin)}</bdi>
              <span className="font-medium">{row.customer.name}</span>
              <span>{row.services.map(nameOf).join(" · ")}</span>
              <span className="text-muted">{row.staff?.name ?? tr("appointments.any")}</span>
              <span className="badge">{tr(`appointments.status.${row.status}`)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
