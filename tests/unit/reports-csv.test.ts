import { describe, expect, it } from "vitest";
import { csvCell, toCsv, trusted } from "@/modules/reports/csv";

describe("csvCell", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("prefixes text that Excel would run as a formula", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+20")).toBe("'+20");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("=a,b")).toBe('"\'=a,b"');
  });

  it("never prefixes numbers or trusted cells", () => {
    expect(csvCell(-1250)).toBe("-1250");
    expect(csvCell(trusted("-12.50"))).toBe("-12.50");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("writes a BOM, CRLF lines and keeps Arabic text", () => {
    const out = toCsv(["المنتج", "Amount"], [["خبز", trusted("12.50")]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe("﻿المنتج,Amount\r\nخبز,12.50\r\n");
  });
});
