"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/app/_ui/icons";
import { authClient } from "@/lib/auth/auth-client";
import { t } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

export function SignOutButton() {
  const router = useRouter();
  const locale = useClientLocale();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={signOut} className="btn btn-ghost btn-sm">
      <Icon name="signOut" className="size-4" />
      <span className="max-md:sr-only">{t(locale, "app.signOut")}</span>
    </button>
  );
}
