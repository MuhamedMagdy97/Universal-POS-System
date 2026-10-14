"use client";

import Link from "next/link";
import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/** "My account" header link (onboarding O10): every signed-in user may change their password. */
export function AccountLink() {
  return (
    <Link href="/account" className="rounded-md px-3 py-1 text-sm underline-offset-4 hover:underline">
      {translator(useClientLocale())("account.nav")}
    </Link>
  );
}
