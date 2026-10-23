"use client";

import Link from "next/link";
import { Icon } from "@/app/_ui/icons";
import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/** "My account" header link (onboarding O10): every signed-in user may change their password. */
export function AccountLink() {
  return (
    <Link href="/account" className="btn btn-ghost btn-sm">
      <Icon name="account" className="size-4" />
      <span className="max-md:sr-only">{translator(useClientLocale())("account.nav")}</span>
    </Link>
  );
}
