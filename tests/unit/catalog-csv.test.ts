import { describe, expect, it } from "vitest";
import type { AppError } from "@/lib/errors";
import { MAX_IMPORT_CHARS, MAX_IMPORT_ROWS, parseCsv, readCsvTable } from "@/modules/catalog/csv";

describe("parseCsv", () => {
  it("splits plain records on commas and LF", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("accepts CRLF and lone CR line ends, and a last record without a line end", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM and keeps Arabic text", () => {
    expect(parseCsv("﻿name,nameAr\r\nCola,كولا\r\n")).toEqual([
      ["name", "nameAr"],
      ["Cola", "كولا"],
    ]);
  });

  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    expect(parseCsv('name,note\r\n"Tea, green","He said ""hi""\r\nbye"\r\n')).toEqual([
      ["name", "note"],
      ["Tea, green", 'He said "hi"\r\nbye'],
    ]);
  });

  it("keeps empty fields, including a trailing one and a final quoted empty field", () => {
    expect(parseCsv('a,,c,\n,\n""')).toEqual([["a", "", "c", ""], ["", ""], [""]]);
  });

  it("returns blank lines as one empty field (callers skip them)", () => {
    expect(parseCsv("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("﻿")).toEqual([]);
  });

  it("returns null when a quoted field is never closed", () => {
    expect(parseCsv('a,b\n"open,1\n')).toBeNull();
  });
});

describe("readCsvTable (shared by the product and stock imports)", () => {
  const reasonOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return ((err as AppError).details as { reason?: string }).reason;
    }
    return null;
  };

  it("maps columns case-insensitively, skips blank lines and numbers rows as in the file", () => {
    const table = readCsvTable(" SKU ,Qty\n\nab-1, 5 ,x\n", ["sku", "qty", "note"], ["qty"]);
    expect(table.has("sku")).toBe(true);
    expect(table.has("note")).toBe(false);
    const [row] = table.rows;
    expect(row?.line).toBe(3);
    expect([row?.cell("sku"), row?.cell("qty"), row?.cell("note")]).toEqual(["ab-1", "5", ""]);
    expect(row?.extraFields).toBe(true);
  });

  it("refuses bad files with a reason", () => {
    expect(reasonOf(() => readCsvTable("", ["a"], []))).toBe("CSV_EMPTY");
    expect(reasonOf(() => readCsvTable("a\n", ["a"], []))).toBe("CSV_EMPTY");
    expect(reasonOf(() => readCsvTable('a\n"x', ["a"], []))).toBe("CSV_MALFORMED");
    expect(reasonOf(() => readCsvTable("a,b\n1,2", ["a"], []))).toBe("CSV_UNKNOWN_COLUMN");
    expect(reasonOf(() => readCsvTable("a,A\n1,2", ["a"], []))).toBe("CSV_UNKNOWN_COLUMN");
    expect(reasonOf(() => readCsvTable("a\n1", ["a", "b"], ["b"]))).toBe("CSV_MISSING_COLUMN");
    expect(reasonOf(() => readCsvTable(`a\n${"1\n".repeat(MAX_IMPORT_ROWS + 1)}`, ["a"], []))).toBe(
      "CSV_TOO_MANY_ROWS",
    );
    expect(reasonOf(() => readCsvTable("a".repeat(MAX_IMPORT_CHARS + 1), ["a"], []))).toBe("CSV_TOO_LARGE");
  });
});
