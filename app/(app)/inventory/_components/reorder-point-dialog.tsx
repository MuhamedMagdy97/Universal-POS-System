"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { setReorderPointAction } from "../actions";
import { errorMessageKey, parseReorderPoint, plain, safeAction, type ItemRef } from "../_lib/form";

type Props = {
  locale: Locale;
  open: boolean;
  onClose: () => void;
  branchId: string;
  itemRef: ItemRef;
  itemLabel: string;
  reorderPoint: number | null;
};

/** Sets or clears (empty box) an item's reorder point at the branch (low-stock-spec L1–L6). */
export function ReorderPointDialog({ locale, open, onClose, branchId, itemRef, itemLabel, reorderPoint }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValue(reorderPoint === null ? "" : String(reorderPoint));
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, reorderPoint]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseReorderPoint(value);
    if (parsed === undefined) {
      setError(tr("inventory.reorder.invalid"));
      return;
    }
    setError(null);
    setPending(true);
    const result = await safeAction(() => setReorderPointAction({ branchId, ref: itemRef, reorderPoint: parsed }));
    setPending(false);
    if (result.ok) {
      onClose();
      router.refresh();
      return;
    }
    setError(plain(locale, errorMessageKey(result.error)));
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-md border border-border bg-background p-6 text-foreground backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {tr("inventory.reorder.title")}: {itemLabel}
        </h2>
        <p className="text-muted">{tr("inventory.reorder.help")}</p>
        <label className="flex flex-col gap-1">
          <span>{tr("inventory.reorder.label")}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        {error ? (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2">
            {tr("inventory.adjust.cancel")}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {tr("inventory.reorder.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
