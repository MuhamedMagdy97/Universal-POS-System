import { translator, type Locale } from "@/lib/i18n";

export function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="card flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{tr("customers.state.forbidden")}</h1>
      <p className="text-muted">{tr("customers.state.forbiddenBody")}</p>
    </section>
  );
}
