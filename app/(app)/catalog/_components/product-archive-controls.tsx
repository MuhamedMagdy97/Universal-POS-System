"use client";

import { useState, useTransition } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { ProductDetail } from "@/modules/catalog/schemas";
import { archiveProductAction, restoreProductAction } from "../actions";
import { mapErrorBody } from "../_lib/form-errors";
import { displayName } from "../_lib/form-helpers";
import { ConfirmDialog } from "./confirm-dialog";

type Props = { locale: Locale; product: ProductDetail; onChanged: (product: ProductDetail) => void };

/** Archive (with confirm) / Restore. No delete exists in the UI (C-27). Sends `expectedUpdatedAt`. */
export function ProductArchiveControls({ locale, product, onChanged }: Props) {
  const tr = translator(locale);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(kind: "archive" | "restore") {
    startTransition(async () => {
      const input = { expectedUpdatedAt: product.updatedAt };
      const result =
        kind === "archive"
          ? await archiveProductAction(product.id, input)
          : await restoreProductAction(product.id, input);
      setConfirming(false);
      if (!result.ok) {
        setMessage(mapErrorBody(result.error, tr).summary);
        return;
      }
      setMessage(kind === "archive" ? tr("catalog.archive.done") : tr("catalog.restore.done"));
      onChanged(result.data);
    });
  }

  return (
    <div className="ms-auto flex items-center gap-3">
      <span role="status" className="text-sm">
        {message}
      </span>
      {product.isActive ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className="rounded-md border border-red-400 px-4 py-2 text-red-700 disabled:opacity-60"
        >
          {tr("catalog.archive.action")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => run("restore")}
          disabled={pending}
          className="rounded-md border border-border px-4 py-2 disabled:opacity-60"
        >
          {tr("catalog.restore.action")}
        </button>
      )}
      <ConfirmDialog
        open={confirming}
        title={tr("catalog.archive.confirmTitle", { name: displayName(locale, product) })}
        body={tr("catalog.archive.confirmBody")}
        confirmLabel={tr("catalog.archive.confirm")}
        cancelLabel={tr("catalog.form.cancel")}
        pending={pending}
        onConfirm={() => run("archive")}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
