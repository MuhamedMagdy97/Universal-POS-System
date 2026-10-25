"use client";

import { translator, type Locale } from "@/lib/i18n";
import { formatQty } from "@/lib/quantity";
import type { KitchenSlip } from "@/modules/sales/tickets";

/**
 * The 80 mm kitchen slip (restaurant-cafe-spec R10): what was just sent, or just taken back ("CANCELLED"), with the
 * table or order type, the ticket number, the time and the waiter. No prices.
 */
/** The time is the till device's local time: the till stands in the shop. */
export function KitchenSlipView({ slip, locale }: { slip: KitchenSlip; locale: Locale }) {
  const tr = translator(locale);
  const at = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    numberingSystem: "latn",
  }).format(new Date(slip.at));
  return (
    <div className="print-receipt" dir={locale === "ar" ? "rtl" : "ltr"} data-testid="kitchen-slip">
      {slip.cancelled ? <p className="receipt-center receipt-strong">{tr("kitchen.cancelled")}</p> : null}
      <p className="receipt-center receipt-strong">
        {slip.tableName ? tr("receipt.table", { name: slip.tableName }) : tr(`receipt.order.${slip.orderType}`)}
      </p>
      <p>
        {tr("kitchen.ticket", { number: slip.ticketNumber })} · <bdi>{at}</bdi> · {slip.waiter}
      </p>
      <table className="receipt-rule">
        <tbody>
          {slip.lines.map((line, index) => (
            <tr key={index}>
              <td>
                <strong>
                  <bdi>{line.unitType === "KG" ? formatQty(line.qty, "KG", locale) : `${line.qty} ×`}</bdi>{" "}
                  {(locale === "ar" && line.nameAr) || line.name}
                </strong>
                {line.options.map((option, optionIndex) => (
                  <span key={optionIndex} className="block receipt-indent">
                    + {(locale === "ar" && option.nameAr) || option.name}
                  </span>
                ))}
                {line.note ? <span className="block receipt-indent">“{line.note}”</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
