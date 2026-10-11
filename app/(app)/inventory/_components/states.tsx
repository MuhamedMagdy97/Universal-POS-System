import { translator, type Locale } from "@/lib/i18n";
import type { BranchOption } from "../_lib/context";
import { BranchPicker } from "./branch-picker";

/** 403 state: no stock data is rendered. */
export function NotAllowed({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("inventory.state.forbidden")}</h1>
      <p className="text-muted">{tr("inventory.state.forbiddenBody")}</p>
    </section>
  );
}

/** 404 state: an unknown or out-of-scope branch or item. The branch picker lets the user pick a valid one. */
export function NotFound({ locale, branches }: { locale: Locale; branches: BranchOption[] }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("inventory.state.notFound")}</h1>
      {branches.length > 0 ? (
        <BranchPicker locale={locale} action="/inventory" branches={branches} currentId="" />
      ) : null}
    </section>
  );
}
