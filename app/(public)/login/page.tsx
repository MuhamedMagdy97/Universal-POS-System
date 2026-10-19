import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <LoginContent />
    </Suspense>
  );
}

async function LoginContent() {
  const locale = await getLocale();
  return (
    <>
      <h1 className="text-2xl font-semibold">{translator(locale)("login.title")}</h1>
      <LoginForm locale={locale} />
    </>
  );
}
