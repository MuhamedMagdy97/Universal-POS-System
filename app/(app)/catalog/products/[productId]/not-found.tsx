"use client";

import Link from "next/link";
import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/** 404 for unknown, malformed or other-tenant product ids (no hint that the record exists elsewhere). */
export default function ProductNotFound() {
  const tr = translator(useClientLocale());
  return (
    <section className="flex flex-col items-start gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("catalog.state.notFound")}</h1>
      <p className="text-muted">{tr("catalog.state.notFoundBody")}</p>
      <Link href="/catalog/products" className="underline">
        {tr("catalog.state.backToList")}
      </Link>
    </section>
  );
}
