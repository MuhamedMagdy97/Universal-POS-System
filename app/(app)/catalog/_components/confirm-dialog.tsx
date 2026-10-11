"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** Modal confirm built on <dialog>: focus is trapped by the browser and Esc closes it. */
export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, pending, onConfirm, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The browser focuses the first button on showModal(), so focus the confirm button here.
      // An `autoFocus` attribute would not work: it runs while the dialog is still closed.
      confirmRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // The native `close` event arrives a task after the dialog closes. Esc therefore closes through
      // React state (else an Enter on the opener in between would not reopen it), and a late `close`
      // event is ignored once the dialog has been reopened (else it would shut the new one).
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      aria-labelledby="confirm-dialog-title"
      className="m-auto max-w-md rounded-md border border-border bg-background p-6 text-foreground backdrop:bg-black/40"
    >
      <h2 id="confirm-dialog-title" className="text-lg font-semibold">
        {title}
      </h2>
      {body ? <div className="mt-2 text-muted">{body}</div> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2">
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="rounded-md bg-red-700 px-4 py-2 text-white disabled:opacity-60"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
