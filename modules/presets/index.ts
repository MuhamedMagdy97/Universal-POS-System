/**
 * presets — business-type and market configuration only (never forked logic).
 * See docs/product/target-customers.md, docs/product/mvp-scope.md and
 * docs/planning/ui-refresh/business-profiles-spec.md (§2: the profile table).
 */

export type BusinessTypeId = "RETAIL" | "GROCERY" | "FRUIT_VEG" | "BAKERY_BUTCHER" | "RESTAURANT_CAFE" | "SALON";

export const BUSINESS_TYPE_IDS = [
  "RETAIL",
  "GROCERY",
  "FRUIT_VEG",
  "BAKERY_BUTCHER",
  "RESTAURANT_CAFE",
  "SALON",
] as const satisfies readonly BusinessTypeId[];

/** Icon names a profile may use; app/_ui/icons.tsx draws each of them. */
export type ProfileIcon = "store" | "basket" | "apple" | "wheat" | "coffee" | "scissors";

/** "scan": search/scan first (retail, grocery). "tiles": tap tiles by category under the scan box (BP6, BP7). */
export type TillLayout = "scan" | "tiles";

/** What the shop calls the things it sells (BP9). */
export type ItemWord = "products" | "items" | "menuItems" | "services";

export type DashboardTile = "netSales" | "sales" | "refunds" | "openShifts" | "lowStock" | "averageTicket" | "topItems";

export type BusinessPreset = {
  id: BusinessTypeId;
  label: { en: string; ar: string };
  icon: ProfileIcon;
  /** `--accent` / `--accent-soft` for light and dark (BP4). */
  accent: { light: string; dark: string; softLight: string; softDark: string };
  tillLayout: TillLayout;
  itemWord: ItemWord;
  /** Which dashboard tiles show, in order (BP10). */
  dashboardTiles: readonly DashboardTile[];
};

export const BUSINESS_PRESETS: readonly BusinessPreset[] = [
  {
    id: "RETAIL",
    label: { en: "General retail", ar: "تجزئة عامة" },
    icon: "store",
    accent: { light: "#1d5fd1", dark: "#5b9cf5", softLight: "#e8f0fd", softDark: "#14233a" },
    tillLayout: "scan",
    itemWord: "products",
    dashboardTiles: ["netSales", "sales", "refunds", "openShifts", "lowStock"],
  },
  {
    id: "GROCERY",
    label: { en: "Grocery / supermarket", ar: "بقالة / سوبرماركت" },
    icon: "basket",
    accent: { light: "#16794a", dark: "#46c98a", softLight: "#e6f4ec", softDark: "#0f2a1d" },
    tillLayout: "scan",
    itemWord: "products",
    dashboardTiles: ["netSales", "sales", "lowStock", "refunds", "openShifts"],
  },
  {
    id: "FRUIT_VEG",
    label: { en: "Fruit & vegetable market", ar: "خضار وفاكهة" },
    icon: "apple",
    accent: { light: "#4d7c0f", dark: "#a3d65c", softLight: "#f2f8e6", softDark: "#1c2a0c" },
    tillLayout: "tiles",
    itemWord: "items",
    dashboardTiles: ["netSales", "sales", "lowStock", "topItems", "openShifts"],
  },
  {
    id: "BAKERY_BUTCHER",
    label: { en: "Bakery / butcher", ar: "مخبز / جزارة" },
    icon: "wheat",
    accent: { light: "#a16207", dark: "#facc15", softLight: "#fdf8ea", softDark: "#2e2508" },
    tillLayout: "tiles",
    itemWord: "items",
    dashboardTiles: ["netSales", "sales", "topItems", "lowStock", "openShifts"],
  },
  {
    id: "RESTAURANT_CAFE",
    label: { en: "Restaurant / café", ar: "مطعم / مقهى" },
    icon: "coffee",
    accent: { light: "#c2410c", dark: "#fb8a5b", softLight: "#fdeee6", softDark: "#331a0e" },
    tillLayout: "tiles",
    itemWord: "menuItems",
    dashboardTiles: ["netSales", "sales", "averageTicket", "topItems", "openShifts"],
  },
  {
    id: "SALON",
    label: { en: "Barbershop / beauty salon", ar: "صالون حلاقة / تجميل" },
    icon: "scissors",
    accent: { light: "#7e22ce", dark: "#c084fc", softLight: "#f4e9fc", softDark: "#26143a" },
    tillLayout: "tiles",
    itemWord: "services",
    dashboardTiles: ["netSales", "sales", "averageTicket", "topItems", "openShifts"],
  },
];

export function profileOf(type: BusinessTypeId): BusinessPreset {
  const profile = BUSINESS_PRESETS.find((p) => p.id === type);
  if (!profile) throw new Error(`No business profile for ${type}`);
  return profile;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type MarketPreset = { country: "EG" | "SA"; currency: "EGP" | "SAR"; vatRateBp: number };

export const MARKET_PRESETS: Record<MarketPreset["country"], MarketPreset> = {
  EG: { country: "EG", currency: "EGP", vatRateBp: 1400 },
  SA: { country: "SA", currency: "SAR", vatRateBp: 1500 },
};
