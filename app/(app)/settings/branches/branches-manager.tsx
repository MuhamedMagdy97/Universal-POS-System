"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { BranchRow, RegisterRow } from "@/modules/org";
import { plain, safeAction, type ActionResult } from "../../inventory/_lib/form";
import { createBranchAction, createRegisterAction, updateBranchAction, updateRegisterAction } from "../actions";
import { orgErrorKey } from "../_lib/errors";

type Editing =
  | { kind: "newBranch" }
  | { kind: "branch"; id: string }
  | { kind: "newTill"; branchId: string }
  | { kind: "till"; id: string }
  | null;

const INPUT = "rounded-md border border-border bg-background px-3 py-2";
const SMALL = "rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50";

/** Branches with their tills: add, rename, deactivate and reactivate (O5). */
export function BranchesManager({ locale, branches }: { locale: Locale; branches: BranchRow[] }) {
  const tr = translator(locale);
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(next: Editing, currentName = "") {
    setEditing(next);
    setName(currentName);
    setCode("");
    setError(null);
  }

  async function run(action: () => Promise<ActionResult<null>>) {
    setPending(true);
    const result = await safeAction(action);
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, orgErrorKey(result.error)));
      return;
    }
    setEditing(null);
    setError(null);
    router.refresh();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    if (editing.kind === "newBranch") void run(() => createBranchAction({ name, code }));
    else if (editing.kind === "branch") void run(() => updateBranchAction(editing.id, { name }));
    else if (editing.kind === "newTill") void run(() => createRegisterAction({ branchId: editing.branchId, name }));
    else void run(() => updateRegisterAction(editing.id, { name }));
  }

  const isNewBranch = editing?.kind === "newBranch";
  const form = (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span>
          {editing?.kind === "newTill" || editing?.kind === "till" ? tr("branches.tillName") : tr("branches.name")}
        </span>
        <input
          required
          maxLength={editing?.kind === "newTill" || editing?.kind === "till" ? 40 : 60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT}
        />
      </label>
      {isNewBranch ? (
        <label className="flex flex-col gap-1">
          <span>{tr("branches.code")}</span>
          <input
            required
            dir="ltr"
            maxLength={12}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className={INPUT}
          />
        </label>
      ) : null}
      <button type="submit" disabled={pending} className="rounded-md bg-foreground px-4 py-2 text-background">
        {tr("branches.save")}
      </button>
      <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-border px-4 py-2">
        {tr("branches.cancel")}
      </button>
    </form>
  );

  const toggle = (row: { isActive: boolean }, action: (isActive: boolean) => Promise<ActionResult<null>>) => (
    <button type="button" disabled={pending} className={SMALL} onClick={() => void run(() => action(!row.isActive))}>
      {row.isActive ? tr("branches.deactivate") : tr("branches.reactivate")}
    </button>
  );

  const till = (register: RegisterRow) => (
    <li key={register.id} className="flex flex-wrap items-center gap-2 py-1">
      {editing?.kind === "till" && editing.id === register.id ? (
        form
      ) : (
        <>
          <span className={register.isActive ? "" : "text-muted line-through"}>{register.name}</span>
          <span className="ms-auto flex gap-2">
            <button
              type="button"
              className={SMALL}
              onClick={() => start({ kind: "till", id: register.id }, register.name)}
            >
              {tr("branches.rename")}
            </button>
            {toggle(register, (isActive) => updateRegisterAction(register.id, { isActive }))}
          </span>
        </>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {editing === null ? (
        <button
          type="button"
          onClick={() => start({ kind: "newBranch" })}
          className="self-start rounded-md bg-foreground px-4 py-2 text-background"
        >
          {tr("branches.add")}
        </button>
      ) : null}
      {isNewBranch ? <div className="rounded-md border border-border p-4">{form}</div> : null}
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {branches.map((branch) => (
          <li key={branch.id} className="flex flex-col gap-2 rounded-md border border-border p-4">
            {editing?.kind === "branch" && editing.id === branch.id ? (
              form
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">{branch.name}</h2>
                <span dir="ltr" className="text-sm text-muted">
                  {branch.code}
                </span>
                {branch.isActive ? null : <span className="text-sm text-muted">· {tr("branches.inactive")}</span>}
                <span className="ms-auto flex gap-2">
                  <button
                    type="button"
                    className={SMALL}
                    onClick={() => start({ kind: "branch", id: branch.id }, branch.name)}
                  >
                    {tr("branches.rename")}
                  </button>
                  {toggle(branch, (isActive) => updateBranchAction(branch.id, { isActive }))}
                </span>
              </div>
            )}
            <section aria-label={tr("branches.tills")}>
              <h3 className="text-sm text-muted">{tr("branches.tills")}</h3>
              <ul className="flex flex-col">{branch.registers.map(till)}</ul>
              {editing?.kind === "newTill" && editing.branchId === branch.id ? (
                form
              ) : branch.isActive ? (
                <button
                  type="button"
                  className={`${SMALL} mt-1`}
                  onClick={() => start({ kind: "newTill", branchId: branch.id })}
                >
                  {tr("branches.addTill")}
                </button>
              ) : null}
            </section>
          </li>
        ))}
      </ul>
    </div>
  );
}
