import { translator, type Locale } from "@/lib/i18n";

export function SettingsDenied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("settings.state.forbidden")}</h1>
      <p className="text-muted">{tr("settings.state.forbiddenBody")}</p>
    </section>
  );
}
