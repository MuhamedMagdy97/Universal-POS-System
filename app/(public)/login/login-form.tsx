"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { translator, type Locale } from "@/lib/i18n";

/** Only same-site relative paths are allowed as post-login targets. */
function safeNext(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/dashboard";
}

export function LoginForm({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (signInError) {
      setError(signInError.status === 429 ? tr("login.error.rateLimited") : tr("login.error.invalid"));
      return;
    }
    router.push(safeNext(searchParams.get("next")));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-4">
      <label className="field">
        <span>{tr("login.email")}</span>
        <input name="email" type="email" required autoComplete="email" className="input" />
      </label>
      <label className="field">
        <span>{tr("login.password")}</span>
        <input name="password" type="password" required autoComplete="current-password" className="input" />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? tr("login.pending") : tr("login.submit")}
      </button>
    </form>
  );
}
