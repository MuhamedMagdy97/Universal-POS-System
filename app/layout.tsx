import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal POS",
  description: "Multi-tenant point of sale for retail in Egypt and Saudi Arabia",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // `dir` is flipped client-side by the EN/AR toggle; layout uses logical CSS properties.
  return (
    <html lang="en" dir="ltr" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
