import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

export default function WelcomePage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <WelcomeContent />
    </Suspense>
  );
}

async function WelcomeContent() {
  const tr = translator(await getLocale());
  return (
    <>
      <h1 className="text-2xl font-semibold">{tr("welcome.title")}</h1>
      <p className="text-muted">{tr("welcome.intro")}</p>
      <div className="flex gap-3">
        <Link href="/login" className="rounded-md bg-foreground px-4 py-2 text-background">
          {tr("welcome.signIn")}
        </Link>
        <Link href="/onboarding" className="rounded-md border border-border px-4 py-2">
          {tr("welcome.setup")}
        </Link>
      </div>
    </>
  );
}
