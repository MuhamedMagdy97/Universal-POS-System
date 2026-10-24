import { describe, expect, it } from "vitest";
import { BUSINESS_PRESETS, contrastRatio, profileOf } from "@/modules/presets";
import { SetupInput } from "@/modules/org/schemas";

/** Business profiles (business-profiles-spec §2, BP1, BP2). */
describe("business profiles", () => {
  it("cover all six types with every field", () => {
    expect(BUSINESS_PRESETS.map((p) => p.id)).toEqual([
      "RETAIL",
      "GROCERY",
      "FRUIT_VEG",
      "BAKERY_BUTCHER",
      "RESTAURANT_CAFE",
      "SALON",
    ]);
    for (const p of BUSINESS_PRESETS) {
      expect(p.label.en && p.label.ar && p.icon && p.itemWord, p.id).toBeTruthy();
      expect(p.dashboardTiles.length, p.id).toBeGreaterThan(0);
      for (const hex of Object.values(p.accent)) expect(hex, p.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keep accent text readable on the accent fill in light and dark", () => {
    for (const p of BUSINESS_PRESETS) {
      expect(contrastRatio("#ffffff", p.accent.light), p.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#0b1220", p.accent.dark), p.id).toBeGreaterThanOrEqual(4.5);
      // Accent text on the soft tint (badges, notices).
      expect(contrastRatio(p.accent.light, p.accent.softLight), `${p.id} soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.accent.dark, p.accent.softDark), `${p.id} soft dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("pick the till layout and item word per type", () => {
    expect(profileOf("RETAIL").tillLayout).toBe("scan");
    expect(profileOf("GROCERY").tillLayout).toBe("scan");
    expect(profileOf("SALON").tillLayout).toBe("tiles");
    expect(profileOf("RESTAURANT_CAFE").itemWord).toBe("menuItems");
    expect(profileOf("SALON").itemWord).toBe("services");
  });

  it("measure contrast like WCAG", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("let setup pick any business type", () => {
    const base = { shopName: "Shop", country: "EG", branchName: "Main" };
    expect(SetupInput.parse({ ...base, businessType: "SALON" }).businessType).toBe("SALON");
    expect(() => SetupInput.parse({ ...base, businessType: "PHARMACY" })).toThrow();
  });
});
