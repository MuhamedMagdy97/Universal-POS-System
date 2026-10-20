"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { SHORTFALL_REASON_VALUES, type ShortfallReason } from "@/modules/inventory/schemas";
import { cancelTransferAction, receiveTransferAction } from "../actions";
import { errorMessageKey, parseReceived, plain, safeAction, type ItemRef } from "../_lib/form";

type ReceiveLine = { ref: ItemRef; label: string; sku: string; qtySent: number };
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
    Object.fromEntries(lines.map((line) => [keyOf(line.ref), String(line.qtySent)])),
  );
  const [reasons, setReasons] = useState<Record<string, ShortfallReason | "">>({});
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = lines.map((line) => {
    const key = keyOf(line.ref);
    const qty = parseReceived(raw[key] ?? "", line.qtySent);
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
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-border p-4 print:hidden">
      <h2 className="text-lg font-semibold">{tr("inventory.transfers.receive.title")}</h2>
      <p className="text-muted">{tr("inventory.transfers.receive.help")}</p>
      <table className="w-full text-start">
        <thead>
          <tr className="text-sm text-muted">
            <th className="py-2 text-start">{tr("inventory.column.item")}</th>
            <th className="text-end">{tr("inventory.transfers.line.sent")}</th>
            <th className="text-start">{tr("inventory.transfers.receive.qty")}</th>
            <th className="text-start">{tr("inventory.transfers.line.reason")}</th>
          </tr>
        </thead>
        <tbody>
          {parsed.map((row) => (
            <tr key={row.key} className="border-t border-border align-top">
              <td className="py-2">
                {row.line.label}{" "}
                <span dir="ltr" className="text-muted">
                  {row.line.sku}
                </span>
              </td>
              <td dir="ltr" className="text-end">
                {row.line.qtySent}
              </td>
              <td>
                <input
                  dir="ltr"
                  inputMode="numeric"
                  aria-label={`${tr("inventory.transfers.receive.qty")}: ${row.line.label}`}
                  value={raw[row.key] ?? ""}
                  onChange={(e) => setRaw((current) => ({ ...current, [row.key]: e.target.value }))}
                  className="w-24 rounded-md border border-border bg-background px-2 py-1"
                />
                {row.qty === null ? (
                  <p className="text-sm text-red-700">{tr("inventory.transfers.receive.invalid")}</p>
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
                    className="rounded-md border border-border bg-background px-2 py-1"
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
      <label className="flex flex-col gap-1">
        <span>{tr("inventory.transfers.receive.note")}</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="rounded-md border border-border bg-background px-3 py-2"
        />
      </label>
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!canSubmit}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
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
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={pending}
        className="rounded-md border border-red-700 px-4 py-2 text-red-700 disabled:opacity-50"
      >
        {tr("inventory.transfers.cancel")}
      </button>
      {error ? (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}
