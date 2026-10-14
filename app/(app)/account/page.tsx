import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { PasswordForm } from "./password-form";

/** My account (onboarding O10): who you are signed in as, and a password change. */
export default function AccountPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <AccountContent />
    </Suspense>
  );
}

async function AccountContent() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  const session = await getSession(requestHeaders);
  if (!session) redirect("/login?next=%2Faccount");
  const tr = translator(locale);
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("account.title")}</h1>
      <p>
        {session.user.name} ·{" "}
        <span dir="ltr" className="text-muted">
          {session.user.email}
        </span>
      </p>
      <h2 className="text-lg font-medium">{tr("account.changePassword")}</h2>
      <PasswordForm locale={locale} />
    </div>
  );
}
