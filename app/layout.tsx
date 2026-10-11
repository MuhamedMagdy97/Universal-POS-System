import type { ReactNode } from "react";
import type { Metadata } from "next";
import { DOCUMENT_LOCALE_SCRIPT } from "@/lib/i18n";
import { DocumentLocaleSync } from "@/lib/i18n/client";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal POS",
  description: "Multi-tenant point of sale for retail in Egypt and Saudi Arabia",
};

/**
 * Prerendered with `lang="en" dir="ltr"`; the inline script switches both to
 * the `pos_locale` cookie value during HTML parsing, before first paint.
 * Reading the cookie here with `cookies()` would make every route dynamic
 * under Cache Components, so the cookie is read in the browser instead
 * (Next guide "Preventing flash before hydration"). `suppressHydrationWarning`
 * covers the attributes the script changed. Layout uses logical CSS properties.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: DOCUMENT_LOCALE_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <DocumentLocaleSync />
        {children}
      </body>
    </html>
  );
}
