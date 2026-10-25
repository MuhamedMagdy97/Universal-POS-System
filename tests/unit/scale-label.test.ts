import { describe, expect, it } from "vitest";
import { DEFAULT_SCALE_SETTINGS, ean13CheckDigit, parseScaleLabel, type ScaleSettings } from "@/lib/scale-label";

const on: ScaleSettings = { ...DEFAULT_SCALE_SETTINGS, enabled: true };
const withCheck = (first12: string) => `${first12}${ean13CheckDigit(first12)}`;

describe("parseScaleLabel", () => {
  it("reads a weight label: prefix + item code to look up, the rest as grams", () => {
    expect(parseScaleLabel(withCheck("201234500750"), on)).toEqual({
      kind: "label",
      lookupCode: "2012345",
      valueKind: "WEIGHT",
      value: 750,
    });
  });

  it("reads a price label in minor units, and Arabic-Indic digits", () => {
    const code = withCheck("231234501250").replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
    expect(parseScaleLabel(code, { ...on, valueKind: "PRICE" })).toMatchObject({ valueKind: "PRICE", value: 1250 });
  });

  it("follows the item-code length", () => {
    expect(parseScaleLabel(withCheck("201234560750"), { ...on, itemDigits: 6 })).toMatchObject({
      lookupCode: "20123456",
      value: 750,
    });
  });

  it("refuses a bad check digit instead of looking it up", () => {
    const good = withCheck("201234500750");
    const bad = `${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`;
    expect(parseScaleLabel(bad, on)).toEqual({ kind: "bad-check-digit" });
  });

  it("is not a label: off, another prefix, wrong length", () => {
    expect(parseScaleLabel(withCheck("201234500750"), DEFAULT_SCALE_SETTINGS)).toBeNull();
    expect(parseScaleLabel(withCheck("622123400750"), on)).toBeNull();
    expect(parseScaleLabel("20123450075", on)).toBeNull();
    expect(parseScaleLabel(withCheck("201234500750"), { ...on, prefixes: ["21"] })).toBeNull();
  });

  it("matches a known EAN-13", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
  });
});
