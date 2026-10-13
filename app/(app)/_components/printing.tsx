"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Print a piece of UI on its own (T10): the node is mounted in a `.print-root` at the end of
 * <body>, marked `data-active`, and print CSS (globals.css) hides every other body child. Only
 * the last root printed is active, so one page with several print buttons prints one slip. The
 * node stays mounted (hidden on screen) until the next print, so a reprint or a test can read it.
 */
export function usePrinter(): { print: (node: ReactNode) => void; portal: ReactNode } {
  const [job, setJob] = useState<{ node: ReactNode; id: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // After commit: the portal is in the DOM, so the browser prints it.
    if (!job) return;
    for (const root of document.querySelectorAll(".print-root[data-active]")) root.removeAttribute("data-active");
    rootRef.current?.setAttribute("data-active", "");
    window.print();
  }, [job]);

  return {
    print: (node) => setJob((current) => ({ node, id: (current?.id ?? 0) + 1 })),
    portal: job
      ? createPortal(
          <div ref={rootRef} className="print-root">
            {job.node}
          </div>,
          document.body,
        )
      : null,
  };
}

/** A button that prints server-rendered `children` (for example the A4 purchase order, T10 H10). */
export function PrintButton({ label, children }: { label: string; children: ReactNode }) {
  const { print, portal } = usePrinter();
  return (
    <>
      <button
        type="button"
        onClick={() => print(children)}
        className="self-start rounded-md border border-border px-4 py-2 print:hidden"
      >
        {label}
      </button>
      {portal}
    </>
  );
}

type LoadResult<T> = { ok: true; data: T } | { ok: false };

/**
 * A button that loads a document from the server and prints it. `load` is told whether this button
 * printed before, so a second press of an "original" button asks for a copy (T10 H4).
 */
export function LoadAndPrintButton<T>({
  label,
  errorLabel,
  load,
  render,
  className,
}: {
  label: string;
  errorLabel: string;
  load: (printedBefore: boolean) => Promise<LoadResult<T>>;
  render: (data: T) => ReactNode;
  className?: string;
}) {
  const { print, portal } = usePrinter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [printed, setPrinted] = useState(false);

  async function run() {
    setPending(true);
    setFailed(false);
    const result = await load(printed);
    setPending(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setPrinted(true);
    print(render(result.data));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={pending}
        className={className ?? "rounded-md border border-border px-4 py-2 disabled:opacity-50"}
      >
        {label}
      </button>
      {failed ? (
        <span role="alert" className="text-red-700">
          {errorLabel}
        </span>
      ) : null}
      {portal}
    </>
  );
}
