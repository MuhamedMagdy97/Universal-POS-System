"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatQty, qtyInputValue, type QtyUnit } from "@/lib/quantity";
import { SHORTFALL_REASON_VALUES, type ShortfallReason } from "@/modules/inventory/schemas";
import { cancelTransferAction, receiveTransferAction } from "../actions";
import { errorMessageKey, parseReceived, plain, safeAction, type ItemRef } from "../_lib/form";

/** `qtySent` is pieces, or grams for KG: typed and shown in kg (weighed-selling-spec W7). */
type ReceiveLine = { ref: ItemRef; label: string; sku: string; qtySent: number; unitType: QtyUnit };
const keyOf = (ref: ItemRef) => `${ref.productId}|${ref.variantId ?? ""}`;

/**
 * Receive form (transit-transfers-spec T4–T6). Each box starts at the quantity sent; a short line
 * needs a reason. The receive key is made once per form, so a double submit applies once.
 */
export function ReceiveTransferForm({
  locale,
  transferId,
  lines,
}: {
  locale: Locale;
  transferId: string;
  lines: ReceiveLine[];
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [receiveKey] = useState(() => crypto.randomUUID());
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [keyOf(line.ref), qtyInputValue(line.qtySent, line.unitType)])),
  );
  const [reasons, setReasons] = useState<Record<string, ShortfallReason | "">>({});
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = lines.map((line) => {
    const key = keyOf(line.ref);
    const qty = parseReceived(raw[key] ?? "", line.qtySent, line.unitType);
    return { line, key, qty, short: qty === null ? 0 : line.qtySent - qty, reason: reasons[key] ?? "" };
  });
  const needsNote = parsed.some((row) => row.short > 0 && row.reason === "OTHER");
  const canSubmit =
    !pending &&
    parsed.every((row) => row.qty !== null && (row.short === 0 || row.reason !== "")) &&
    (!needsNote || note.trim() !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    const result = await safeAction(() =>
      receiveTransferAction(transferId, {
        receiveKey,
        note: note.trim() || undefined,
        lines: parsed.map((row) => ({
          ref: row.line.ref,
          qtyReceived: row.qty ?? 0,
          ...(row.short > 0 && row.reason ? { shortfallReason: row.reason } : {}),
        })),
      }),
    );
    setPending(false);
    if (result.ok) {
      router.replace(`/inventory/transfers/${transferId}?received=1`);
      router.refresh();
      return;
    }
    setError(plain(locale, errorMessageKey(result.error)));
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4 print:hidden">
      <h2 className="text-lg font-semibold">{tr("inventory.transfers.receive.title")}</h2>
      <p className="text-muted">{tr("inventory.transfers.receive.help")}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("inventory.column.item")}</th>
              <th className="text-end">{tr("inventory.transfers.line.sent")}</th>
              <th className="text-start">{tr("inventory.transfers.receive.qty")}</th>
              <th className="text-start">{tr("inventory.transfers.line.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {parsed.map((row) => (
              <tr key={row.key} className="border-t border-border align-top">
                <td>
                  {row.line.label}{" "}
                  <span dir="ltr" className="text-muted">
                    {row.line.sku}
                  </span>
                </td>
                <td dir="ltr" className="text-end">
                  {formatQty(row.line.qtySent, row.line.unitType, locale)}
                </td>
                <td>
                  <input
                    dir="ltr"
                    inputMode={row.line.unitType === "KG" ? "decimal" : "numeric"}
                    aria-label={`${tr("inventory.transfers.receive.qty")}: ${row.line.label}`}
                    value={raw[row.key] ?? ""}
                    onChange={(e) => setRaw((current) => ({ ...current, [row.key]: e.target.value }))}
                    className="input min-h-9 w-24 px-2 py-1"
                  />
                  {row.qty === null ? (
                    <p className="text-sm text-danger">{tr("inventory.transfers.receive.invalid")}</p>
                  ) : null}
                </td>
                <td>
                  {row.short > 0 ? (
                    <select
                      aria-label={`${tr("inventory.transfers.line.reason")}: ${row.line.label}`}
                      value={row.reason}
                      onChange={(e) =>
                        setReasons((current) => ({ ...current, [row.key]: e.target.value as ShortfallReason | "" }))
                      }
                      className="input min-h-9 px-2 py-1"
                    >
                      <option value="">{tr("inventory.transfers.receive.chooseReason")}</option>
                      {SHORTFALL_REASON_VALUES.map((reason) => (
                        <option key={reason} value={reason}>
                          {tr(`inventory.reason.${reason}` as const)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="field">
        <span>{tr("inventory.transfers.receive.note")}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="input" />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={!canSubmit} className="btn btn-primary self-start">
        {tr("inventory.transfers.receive.submit")}
      </button>
    </form>
  );
}

/** Source-side recall of a transfer still in transit (T7). */
export function CancelTransferButton({
  locale,
  transferId,
  fromBranchName,
}: {
  locale: Locale;
  transferId: string;
  fromBranchName: string;
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (!window.confirm(tr("inventory.transfers.cancelConfirm", { branch: fromBranchName }))) return;
    setPending(true);
    setError(null);
    const result = await safeAction(() => cancelTransferAction(transferId));
    setPending(false);
    if (result.ok) {
      router.replace(`/inventory/transfers/${transferId}?cancelled=1`);
      router.refresh();
      return;
    }
    setError(plain(locale, errorMessageKey(result.error)));
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      <button type="button" onClick={() => void cancel()} disabled={pending} className="btn border-danger text-danger">
        {tr("inventory.transfers.cancel")}
      </button>
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
