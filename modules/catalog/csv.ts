/**
 * Minimal RFC 4180 CSV reader for the product import. Pure, client-safe.
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
