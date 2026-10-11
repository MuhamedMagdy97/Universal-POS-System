import { translator, type Locale } from "@/lib/i18n";
import type { BranchOption } from "../_lib/context";

/**
 * Branch picker (UX §1). A plain GET form, so it works without JavaScript and keeps the
 * page's own path. Hidden when the user can see only one branch.
 */
export function BranchPicker({
  locale,
  action,
  branches,
  currentId,
}: {
  locale: Locale;
  action: string;
  branches: BranchOption[];
  currentId: string;
}) {
  if (branches.length <= 1) return null;
  const tr = translator(locale);
  return (
    <form action={action} method="get" className="flex items-center gap-2">
      <label className="flex items-center gap-2">
        <span>{tr("inventory.branch")}</span>
        <select
          name="branch"
          defaultValue={currentId}
          className="rounded-md border border-border bg-background px-3 py-2"
        >
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name} ({branch.code})
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="rounded-md border border-border px-3 py-2">
        {tr("inventory.search.submit")}
      </button>
    </form>
  );
}
