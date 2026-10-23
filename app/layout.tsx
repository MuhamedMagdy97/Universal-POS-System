import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { DOCUMENT_LOCALE_SCRIPT } from "@/lib/i18n";
import { DocumentLocaleSync } from "@/lib/i18n/client";
import "./globals.css";

/** DS5: one family for Arabic and Latin, self-hosted at build time (CSP font-src 'self'). */
const plex = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Universal POS",
  description: "Multi-tenant point of sale for retail in Egypt and Saudi Arabia",
};

/**
 * Nonce CSP (proxy.ts): a prerendered shell would ship Next's scripts without the request's
 * nonce, so every route renders per request and opts out of the static-shell check here.
 */
export const instant = false;

/**
 * Rendered with `lang="en" dir="ltr"`; the inline script switches both to
 * the `pos_locale` cookie value during HTML parsing, before first paint
 * (Next guide "Preventing flash before hydration"), and carries the CSP nonce.
 * `suppressHydrationWarning` covers the attributes the script changed.
 * Layout uses logical CSS properties.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" dir="ltr" className={`${plex.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DOCUMENT_LOCALE_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-page text-foreground">
        <DocumentLocaleSync />
        {children}
      </body>
    </html>
  );
}
