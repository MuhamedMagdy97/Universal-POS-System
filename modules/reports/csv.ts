/**
 * CSV writer for report and audit exports (P9, R6). Pure.
 *
 * UTF-8 with BOM (so Excel reads Arabic), CRLF line ends, RFC 4180 quoting. A text cell that
 * Excel would run as a formula (`=`, `+`, `-`, `@`, tab, CR first) gets a leading `'`. Numbers
 * and `trusted` cells are written by this module's callers from known values and are never
 * prefixed, so a negative amount stays a number.
 */

export type CsvCell = string | number | null | undefined | { trusted: string };

const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** A cell written as is: amounts from `toMajorString`, dates the exporter formatted itself. */
export function trusted(value: string): { trusted: string } {
  return { trusted: value };
}

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "object") return quote(cell.trusted);
  return quote(FORMULA_START.test(cell) ? `'${cell}` : cell);
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map((h) => csvCell(h)), ...rows.map((row) => row.map(csvCell))];
  return BOM + lines.map((cells) => cells.join(",")).join("\r\n") + "\r\n";
}

export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
