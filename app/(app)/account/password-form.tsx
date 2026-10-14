"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/modules/org/schemas";
import { plain } from "../inventory/_lib/form";
import { orgErrorKey } from "../settings/_lib/errors";
import { changePasswordAction } from "./actions";

const INPUT = "rounded-md border border-border bg-background px-3 py-2";

export function PasswordForm({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setStatus({ tone: "error", text: tr("onboarding.passwordMismatch") });
      return;
    }
    setPending(true);
    const result = await changePasswordAction({
      currentPassword: String(form.get("currentPassword") ?? ""),
      newPassword,
    }).catch(() => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "", details: null } }));
    setPending(false);
    if (!result.ok) {
      setStatus({ tone: "error", text: plain(locale, orgErrorKey(result.error)) });
      return;
    }
    formElement.reset();
    setStatus({ tone: "ok", text: tr("account.passwordChanged") });
  }

  const field = (name: string, label: string, autoComplete: string, min = PASSWORD_MIN) => (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <input
        name={name}
        type="password"
        required
        minLength={min}
        maxLength={PASSWORD_MAX}
        autoComplete={autoComplete}
        className={INPUT}
      />
    </label>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {field("currentPassword", tr("account.currentPassword"), "current-password", 1)}
      {field("newPassword", tr("account.newPassword", { min: PASSWORD_MIN }), "new-password")}
      {field("confirm", tr("onboarding.confirm"), "new-password")}
      {status ? (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={status.tone === "error" ? "text-red-700" : "text-green-800"}
        >
          {status.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {tr("account.save")}
      </button>
    </form>
  );
}
