import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { isSaudiVatNumber, qrSvg, zatcaAmount, zatcaTimestamp, zatcaTlvBase64 } from "@/modules/sales/zatca";

/** ZATCA Phase 1 QR (docs/planning/zatca/zatca-phase1-spec.md). */

/** Splits a TLV Base64 back into [tag, value] pairs. */
function fields(base64: string): [number, string][] {
  const bytes = Buffer.from(base64, "base64");
  const out: [number, string][] = [];
  for (let i = 0; i < bytes.length;) {
    const tag = bytes[i] ?? 0;
    const length = bytes[i + 1] ?? 0;
    out.push([tag, bytes.subarray(i + 2, i + 2 + length).toString("utf8")]);
    i += 2 + length;
  }
  return out;
}

describe("zatcaTlvBase64", () => {
  it("matches ZATCA's published sample", () => {
    expect(
      zatcaTlvBase64({
        sellerName: "Bobs Records",
        vatNumber: "310122393500003",
        at: "2022-04-25T15:30:00.000Z",
        totalMinor: 100_000,
        vatMinor: 15_000,
      }),
    ).toBe("AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==");
  });

  it("measures an Arabic seller name in UTF-8 bytes, not characters", () => {
    const name = "متجر الرياض"; // 11 characters, 10 Arabic letters at 2 bytes + 1 space
    const bytes = Buffer.from(
      zatcaTlvBase64({
        sellerName: name,
        vatNumber: "300000000000003",
        at: "2026-01-01T00:00:00Z",
        totalMinor: 1,
        vatMinor: 0,
      }),
      "base64",
    );
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(21);
    expect(fields(bytes.toString("base64"))[0]).toEqual([1, name]);
  });

  it("cuts a name over 255 bytes at a character boundary", () => {
    const name = "م".repeat(200); // 400 bytes
    const [[, seller]] = fields(
      zatcaTlvBase64({
        sellerName: name,
        vatNumber: "300000000000003",
        at: "2026-01-01T00:00:00Z",
        totalMinor: 1,
        vatMinor: 0,
      }),
    );
    expect(seller).toBe("م".repeat(127));
  });
});

describe("formats", () => {
  it("prints amounts with two places and timestamps in UTC to the second", () => {
    expect(zatcaAmount(115_000)).toBe("1150.00");
    expect(zatcaAmount(5)).toBe("0.05");
    expect(zatcaAmount(0)).toBe("0.00");
    expect(zatcaTimestamp("2026-10-20T12:15:07.123+03:00")).toBe("2026-10-20T09:15:07Z");
  });
});

describe("isSaudiVatNumber", () => {
  it("accepts 15 digits starting and ending with 3 only", () => {
    expect(isSaudiVatNumber("310122393500003")).toBe(true);
    expect(isSaudiVatNumber("300000000000003")).toBe(true);
    expect(isSaudiVatNumber("31012239350000")).toBe(false); // 14 digits
    expect(isSaudiVatNumber("3101223935000033")).toBe(false); // 16 digits
    expect(isSaudiVatNumber("210122393500003")).toBe(false);
    expect(isSaudiVatNumber("310122393500002")).toBe(false);
    expect(isSaudiVatNumber("31012239350000A")).toBe(false);
    expect(isSaudiVatNumber("310 122393500003")).toBe(false);
    expect(isSaudiVatNumber("")).toBe(false);
  });
});

describe("qrSvg", () => {
  it("draws every dark module of the QR, with a 2-module quiet zone", () => {
    const tlv = "AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==";
    const { size, path } = qrSvg(tlv);
    // Rebuild the module grid from the path and compare with a fresh encode of the same text.
    const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      const row = grid[Number(y)];
      if (row) row[Number(x)] = true;
    }
    expect(grid).toEqual(encode(tlv, { ecc: "M", border: 2 }).data);
    expect(grid[0]?.some(Boolean)).toBe(false);
    expect(grid[2]?.[2]).toBe(true); // top-left finder pattern starts after the quiet zone
  });
});
