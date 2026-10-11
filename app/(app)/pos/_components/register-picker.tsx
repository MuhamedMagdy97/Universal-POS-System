import { translator, type Locale } from "@/lib/i18n";
import type { BranchOption, RegisterOption } from "../_lib/context";

/**
 * Branch and register picker. A plain GET form, so it works without JavaScript. Hidden when
 * there is nothing to choose.
 */
export function RegisterPicker({
  locale,
  branches,
  branchId,
  registers,
  registerId,
}: {
  locale: Locale;
  branches: BranchOption[];
  branchId: string;
  registers: RegisterOption[];
  registerId: string | null;
}) {
  if (branches.length <= 1 && registers.length <= 1) return null;
  const tr = translator(locale);
  return (
    <form action="/pos" method="get" className="flex flex-wrap items-center gap-2">
      {branches.length > 1 ? (
        <label className="flex items-center gap-2">
          <span>{tr("pos.branch")}</span>
          <select
            name="branch"
            defaultValue={branchId}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input type="hidden" name="branch" value={branchId} />
      )}
      {registers.length > 1 ? (
        <label className="flex items-center gap-2">
          <span>{tr("pos.register")}</span>
          <select
            name="register"
            defaultValue={registerId ?? ""}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            {registers.map((register) => (
              <option key={register.id} value={register.id}>
                {register.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="submit" className="rounded-md border border-border px-3 py-2">
        {tr("pos.switch")}
      </button>
    </form>
  );
}
