"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { BUSINESS_PRESETS, MARKET_PRESETS } from "@/modules/presets";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/modules/org/schemas";
import { orgErrorKey } from "../../(app)/settings/_lib/errors";
import { plain } from "../../(app)/inventory/_lib/form";
import { createShopAction } from "./actions";

const INPUT = "rounded-md border border-border bg-background px-3 py-2";

/** One-page shop setup (O2). Only General retail can be picked; country sets currency, VAT and timezone. */
export function SetupForm({ locale, needsAccount }: { locale: Locale; needsAccount: boolean }) {
  const tr = translator(locale);
  const router = useRouter();
  const [country, setCountry] = useState<"EG" | "SA">("EG");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    if (needsAccount && text("password") !== text("confirm")) {
      setError(tr("onboarding.passwordMismatch"));
      return;
    }
    setPending(true);
    setError(null);
    const result = await createShopAction({
      businessType: "RETAIL",
      shopName: text("shopName"),
      country,
      branchName: text("branchName"),
      ...(needsAccount
        ? { account: { ownerName: text("ownerName"), email: text("email"), password: text("password") } }
        : {}),
    }).catch(() => ({ ok: false as const, error: { code: "INTERNAL" as const, message: "", details: null } }));
    if (!result.ok) {
      setPending(false);
      setError(plain(locale, orgErrorKey(result.error)));
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{tr("onboarding.businessType")}</legend>
        {BUSINESS_PRESETS.map((preset) => {
          const included = preset.status === "included";
          return (
            <label
              key={preset.id}
              className="flex items-center gap-3 rounded-md border border-border px-4 py-3 has-[:disabled]:opacity-60"
            >
              <input
                type="radio"
                name="businessType"
                value={preset.id}
                defaultChecked={included}
                disabled={!included}
              />
              <span className="flex-1">{preset.label[locale]}</span>
              {included ? null : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-700">
                  {tr("onboarding.comingSoon")}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span>{tr("onboarding.shopName")}</span>
        <input name="shopName" required maxLength={120} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1">
        <span>{tr("onboarding.country")}</span>
        <select
          name="country"
          value={country}
          onChange={(e) => setCountry(e.target.value as "EG" | "SA")}
          className={INPUT}
        >
          <option value="EG">{tr("onboarding.country.EG")}</option>
          <option value="SA">{tr("onboarding.country.SA")}</option>
        </select>
        <span className="text-sm text-muted">
          {tr("onboarding.market", {
            currency: MARKET_PRESETS[country].currency,
            vat: MARKET_PRESETS[country].vatRateBp / 100,
          })}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span>{tr("onboarding.branchName")}</span>
        <input
          name="branchName"
          required
          maxLength={60}
          defaultValue={tr("onboarding.branchDefault")}
          className={INPUT}
        />
        <span className="text-sm text-muted">{tr("onboarding.tillNote")}</span>
      </label>

      {needsAccount ? (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 font-medium">{tr("onboarding.account")}</legend>
          <label className="flex flex-col gap-1">
            <span>{tr("onboarding.ownerName")}</span>
            <input name="ownerName" required maxLength={120} autoComplete="name" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("onboarding.email")}</span>
            <input name="email" type="email" required dir="ltr" autoComplete="email" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("onboarding.password", { min: PASSWORD_MIN })}</span>
            <input
              name="password"
              type="password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              autoComplete="new-password"
              className={INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("onboarding.confirm")}</span>
            <input
              name="confirm"
              type="password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              autoComplete="new-password"
              className={INPUT}
            />
          </label>
        </fieldset>
      ) : (
        <p className="text-muted">{tr("onboarding.signedIn")}</p>
      )}

      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-60"
      >
        {pending ? tr("onboarding.creating") : tr("onboarding.create")}
      </button>
    </form>
  );
}
