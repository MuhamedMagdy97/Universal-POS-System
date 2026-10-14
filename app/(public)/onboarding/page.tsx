import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { SetupForm } from "./setup-form";

/**
 * Set up a new shop (onboarding O1, O2, O7, O8). Signed out: the full form with the owner's
 * account. Signed in without a shop: the shop fields only. Already in a shop: the dashboard.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <OnboardingContent />
    </Suspense>
  );
}

async function OnboardingContent() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  const session = await getSession(requestHeaders);
  if (session) {
    const member = await getDb().membership.findFirst({ where: { userId: session.user.id }, select: { id: true } });
    if (member) redirect("/dashboard");
  }
  const tr = translator(locale);
  return (
    <>
      <h1 className="text-2xl font-semibold">{tr("onboarding.title")}</h1>
      <p className="text-muted">{tr("onboarding.intro")}</p>
      <SetupForm locale={locale} needsAccount={!session} />
    </>
  );
}
