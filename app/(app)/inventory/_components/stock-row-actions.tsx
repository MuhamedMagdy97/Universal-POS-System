"use client";

import { useState } from "react";
import Link from "next/link";
import { translator, type Locale } from "@/lib/i18n";
import type { QtyUnit } from "@/lib/quantity";
import { AdjustDialog } from "./adjust-dialog";
import { ReorderPointDialog } from "./reorder-point-dialog";
import type { ItemRef } from "../_lib/form";

type Props = {
  locale: Locale;
  branchId: string;
  itemRef: ItemRef;
  itemLabel: string;
  onHand: number;
  /** Pieces, or grams for KG (weighed-selling-spec W7). */
  unitType?: QtyUnit;
  reorderPoint: number | null;
  canAdjust: boolean;
  canTransfer: boolean;
  historyHref: string;
  archived?: boolean;
  transferHref: string;
};

/** Row actions on the stock list: Adjust and Reorder point (dialogs), History and Transfer (links). */
export function StockRowActions(props: Props) {
  const tr = translator(props.locale);
  const [open, setOpen] = useState(false);
  const [reorderOpen, setReorderOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      {props.canAdjust ? (
        <button type="button" onClick={() => setOpen(true)} className="btn btn-sm">
          {tr("inventory.action.adjust")}
        </button>
      ) : null}
      {props.canAdjust ? (
        <button type="button" onClick={() => setReorderOpen(true)} className="btn btn-sm">
          {tr("inventory.action.reorderPoint")}
        </button>
      ) : null}
      {props.canTransfer ? (
        <Link href={props.transferHref} className="btn btn-sm">
          {tr("inventory.action.transfer")}
        </Link>
      ) : null}
      <Link href={props.historyHref} className="btn btn-sm">
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
          unitType={props.unitType}
          archived={props.archived}
        />
      ) : null}
      {props.canAdjust ? (
        <ReorderPointDialog
          locale={props.locale}
          open={reorderOpen}
          onClose={() => setReorderOpen(false)}
          branchId={props.branchId}
          itemRef={props.itemRef}
          itemLabel={props.itemLabel}
          reorderPoint={props.reorderPoint}
          unitType={props.unitType}
        />
      ) : null}
    </div>
  );
}
