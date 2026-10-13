"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Print a piece of UI on its own (T10): the node is mounted in a `.print-root` at the end of
 * <body>, and print CSS (globals.css) hides every other body child while it is there. The node
 * stays mounted (hidden on screen) until the next print, so a reprint or a test can read it.
 */
export function usePrinter(): { print: (node: ReactNode) => void; portal: ReactNode } {
  const [job, setJob] = useState<{ node: ReactNode; id: number } | null>(null);

  useEffect(() => {
    // After commit: the portal is in the DOM, so the browser prints it.
    if (job) window.print();
  }, [job]);

  return {
    print: (node) => setJob((current) => ({ node, id: (current?.id ?? 0) + 1 })),
    portal: job ? createPortal(<div className="print-root">{job.node}</div>, document.body) : null,
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
