import { describe, expect, it } from "vitest";
import { parseCsv } from "@/modules/catalog/csv";

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
