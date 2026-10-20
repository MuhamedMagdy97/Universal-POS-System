import { encode } from "uqr";

/**
 * ZATCA Phase 1 (generation phase) QR for Saudi simplified tax invoices and their credit notes
 * (docs/planning/zatca/zatca-phase1-spec.md). Pure: no DB, so it is unit-tested directly.
 */

/** A Saudi VAT registration number: 15 digits, first and last digit 3 (Z2). */
export function isSaudiVatNumber(value: string): boolean {
  return /^3\d{13}3$/.test(value);
}

export type ZatcaFields = {
  sellerName: string;
  vatNumber: string;
  /** ISO instant; printed in UTC to the second (Z6). */
  at: string;
  totalMinor: number;
  vatMinor: number;
};

/** "2026-10-20T09:15:00Z" (Z6). */
export function zatcaTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Minor units → "1150.00": two places, no grouping, no currency (Z7). */
export function zatcaAmount(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One TLV: tag byte, length byte, UTF-8 value. A value over 255 bytes is cut at a character boundary (Z5). */
function tlv(tag: number, value: string): Buffer {
  let bytes = Buffer.from(value, "utf8");
  if (bytes.length > 255) {
    let end = 255;
    // Step back off UTF-8 continuation bytes (10xxxxxx) so no character is split.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    bytes = bytes.subarray(0, end);
  }
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

/** Tags 1–5 as TLV, Base64-encoded: the QR's text. */
export function zatcaTlvBase64(fields: ZatcaFields): string {
  return Buffer.concat([
    tlv(1, fields.sellerName),
    tlv(2, fields.vatNumber),
    tlv(3, zatcaTimestamp(fields.at)),
    tlv(4, zatcaAmount(fields.totalMinor)),
    tlv(5, zatcaAmount(fields.vatMinor)),
  ]).toString("base64");
}

/** The QR as one SVG path in module units, quiet zone included in `size` (Z9). */
export type QrSvg = { size: number; path: string };

export function qrSvg(text: string): QrSvg {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, path };
}
