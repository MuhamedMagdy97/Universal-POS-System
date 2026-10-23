import { translator, type Locale } from "@/lib/i18n";
import type { PoStatus } from "@/modules/purchasing/schemas";
import { statusKey, statusTone } from "../_lib/purchasing";

export function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="card flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{tr("purchasing.state.forbidden")}</h1>
      <p className="text-muted">{tr("purchasing.state.forbiddenBody")}</p>
    </section>
  );
}

export function StatusBadge({ locale, status }: { locale: Locale; status: PoStatus }) {
  return <span className={`badge ${statusTone(status)}`}>{translator(locale)(statusKey(status))}</span>;
}
