"use client";

import { useState } from "react";
import Link from "next/link";
import { translator, type Locale } from "@/lib/i18n";
import { AdjustDialog } from "./adjust-dialog";
import type { ItemRef } from "../_lib/form";

type Props = {
  locale: Locale;
  branchId: string;
  itemRef: ItemRef;
  itemLabel: string;
  onHand: number;
  canAdjust: boolean;
  canTransfer: boolean;
  historyHref: string;
  transferHref: string;
};

/** Row actions on the stock list: Adjust (dialog), History and Transfer (links). */
export function StockRowActions(props: Props) {
  const tr = translator(props.locale);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      {props.canAdjust ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-border px-3 py-1">
          {tr("inventory.action.adjust")}
        </button>
      ) : null}
      {props.canTransfer ? (
        <Link href={props.transferHref} className="rounded-md border border-border px-3 py-1">
          {tr("inventory.action.transfer")}
        </Link>
      ) : null}
      <Link href={props.historyHref} className="rounded-md border border-border px-3 py-1">
        {tr("inventory.action.history")}
      </Link>
      {props.canAdjust ? (
        <AdjustDialog
          locale={props.locale}
          open={open}
          onClose={() => setOpen(false)}
          branchId={props.branchId}
          itemRef={props.itemRef}
          itemLabel={props.itemLabel}
          onHand={props.onHand}
        />
      ) : null}
    </div>
  );
}
