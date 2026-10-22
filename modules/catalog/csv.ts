import { AppError } from "@/lib/errors";

/**
 * Minimal RFC 4180 CSV reader shared by the product and stock imports. Pure, client-safe.
 *
 * Handles a leading UTF-8 BOM, quoted fields (with `""` escapes, commas and line
 * breaks inside), and LF / CRLF / CR line ends. A trailing line break does not
 * add an empty record. Returns null when a quoted field is never closed.
 */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // anything read since the last record ended

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    started = false;
  };

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      started = true;
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      started = true;
      if (ch === '"' && field === "") quoted = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else field += ch;
    }
  }
  if (quoted) return null;
  if (started) endRow();
  return rows;
}

export const MAX_IMPORT_ROWS = 1000;
/** Rough cap on the CSV text (Server Action bodies are limited to 1 MB). */
export const MAX_IMPORT_CHARS = 900_000;

/** File-level refusal of an import: 422 with `details.reason` (and `column` / `max` where relevant). */
export function csvFileError(reason: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("VALIDATION_FAILED", "The file cannot be imported", { reason, ...details });
}

/** `line` is the record's 1-based number in the file (header = 1), as a spreadsheet shows it. */
export type CsvRow<C extends string> = { line: number; cell: (column: C) => string; extraFields: boolean };

/**
 * Shared front half of the CSV imports (products, stock): size cap, parse, blank lines skipped,
 * header row of known column names (case-insensitive, any order, no repeats), required columns,
 * row cap. Throws `csvFileError` (CSV_TOO_LARGE, CSV_MALFORMED, CSV_EMPTY, CSV_UNKNOWN_COLUMN,
 * CSV_MISSING_COLUMN, CSV_TOO_MANY_ROWS). Cells come back trimmed.
 */
export function readCsvTable<C extends string>(
  csv: string,
  columns: readonly C[],
  required: readonly C[],
): { has: (column: C) => boolean; rows: CsvRow<C>[] } {
  if (csv.length > MAX_IMPORT_CHARS) throw csvFileError("CSV_TOO_LARGE");
  const records = parseCsv(csv);
  if (!records) throw csvFileError("CSV_MALFORMED");
  const kept: { line: number; record: string[] }[] = [];
  records.forEach((record, i) => {
    if (record.some((cell) => cell.trim() !== "")) kept.push({ line: i + 1, record });
  });
  const [header, ...body] = kept;
  if (!header) throw csvFileError("CSV_EMPTY");

  const index = new Map<C, number>();
  header.record.forEach((raw, i) => {
    const column = columns.find((c) => c.toLowerCase() === raw.trim().toLowerCase());
    if (!column || index.has(column)) throw csvFileError("CSV_UNKNOWN_COLUMN", { column: raw.trim() });
    index.set(column, i);
  });
  for (const column of required) {
    if (!index.has(column)) throw csvFileError("CSV_MISSING_COLUMN", { column });
  }
  if (body.length === 0) throw csvFileError("CSV_EMPTY");
  if (body.length > MAX_IMPORT_ROWS) throw csvFileError("CSV_TOO_MANY_ROWS", { max: MAX_IMPORT_ROWS });

  return {
    has: (column) => index.has(column),
    rows: body.map(({ line, record }) => ({
      line,
      cell: (column) => {
        const i = index.get(column);
        return i === undefined ? "" : (record[i] ?? "").trim();
      },
      extraFields: record.length > header.record.length,
    })),
  };
}
