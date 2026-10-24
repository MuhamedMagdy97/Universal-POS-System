/** Dashboard "Average ticket" (business-profiles-spec BP10): net sales ÷ sales, half up; null without sales. */
export function averageTicketMinor(netSalesMinor: number, salesCount: number): number | null {
  if (salesCount === 0) return null;
  const sign = netSalesMinor < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(netSalesMinor) / salesCount);
}
