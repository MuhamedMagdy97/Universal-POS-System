/**
 * presets — business-type and market configuration only (never forked logic).
 * See docs/product/target-customers.md and docs/product/mvp-scope.md.
 */

export type BusinessTypeId = "RETAIL" | "GROCERY" | "FRUIT_VEG" | "BAKERY_BUTCHER" | "RESTAURANT_CAFE" | "SALON";

export type BusinessPreset = {
  id: BusinessTypeId;
  label: { en: string; ar: string };
  /** Only General Retail is fully functional in the MVP. */
  status: "included" | "coming-soon";
};

export const BUSINESS_PRESETS: readonly BusinessPreset[] = [
  { id: "RETAIL", label: { en: "General retail", ar: "تجزئة عامة" }, status: "included" },
  { id: "GROCERY", label: { en: "Grocery / supermarket", ar: "بقالة / سوبرماركت" }, status: "coming-soon" },
  { id: "FRUIT_VEG", label: { en: "Fruit & vegetable market", ar: "خضار وفاكهة" }, status: "coming-soon" },
  { id: "BAKERY_BUTCHER", label: { en: "Bakery / butcher", ar: "مخبز / جزارة" }, status: "coming-soon" },
  { id: "RESTAURANT_CAFE", label: { en: "Restaurant / café", ar: "مطعم / مقهى" }, status: "coming-soon" },
  { id: "SALON", label: { en: "Barbershop / beauty salon", ar: "صالون حلاقة / تجميل" }, status: "coming-soon" },
];

export type MarketPreset = { country: "EG" | "SA"; currency: "EGP" | "SAR"; vatRateBp: number };

export const MARKET_PRESETS: Record<MarketPreset["country"], MarketPreset> = {
  EG: { country: "EG", currency: "EGP", vatRateBp: 1400 },
  SA: { country: "SA", currency: "SAR", vatRateBp: 1500 },
};
