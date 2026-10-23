"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { StaffRow } from "@/modules/org";
import { canManageRole, PASSWORD_MAX, PASSWORD_MIN, STAFF_ROLES, type StaffRole } from "@/modules/org/schemas";
import { plain, safeAction, type ActionResult } from "../../inventory/_lib/form";
import { addStaffAction, updateStaffAction } from "../actions";
import { orgErrorKey } from "../_lib/errors";

type Branch = { id: string; name: string; isActive: boolean };
type Draft = { name: string; email: string; password: string; role: StaffRole; all: boolean; branchIds: string[] };
type Mode = { kind: "add" } | { kind: "edit"; row: StaffRow } | { kind: "password"; row: StaffRow } | null;

/** Staff list with add, change role and branches, deactivate/reactivate and a new temporary password (O3, O4). */
export function StaffManager({
  locale,
  actorRole,
  staff,
  branches,
}: {
  locale: Locale;
  actorRole: StaffRole;
  staff: StaffRow[];
  branches: Branch[];
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [draft, setDraft] = useState<Draft>({
    name: "",
    email: "",
    password: "",
    role: "CASHIER",
    all: true,
    branchIds: [],
  });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const roles = STAFF_ROLES.filter((role) => canManageRole(actorRole, role));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const activeBranches = branches.filter((b) => b.isActive);

  function open(next: Mode) {
    setMode(next);
    setMessage(null);
    const row = next && next.kind !== "add" ? next.row : null;
    setDraft({
      name: "",
      email: "",
      password: "",
      role: row?.role ?? "CASHIER",
      all: row ? row.allBranches : true,
      branchIds: row?.branchIds ?? [],
    });
  }

  async function run(action: () => Promise<ActionResult<null>>, done: string) {
    setPending(true);
    const result = await safeAction(action);
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: plain(locale, orgErrorKey(result.error)) });
      return;
    }
    setMode(null);
    setMessage({ tone: "ok", text: done });
    router.refresh();
  }

  const scope = () =>
    draft.all ? { allBranches: true as const } : { allBranches: false as const, branchIds: draft.branchIds };

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mode) return;
    if (mode.kind !== "password" && !draft.all && draft.branchIds.length === 0) {
      setMessage({ tone: "error", text: tr("staff.pickBranch") });
      return;
    }
    if (mode.kind === "add") {
      void run(
        () =>
          addStaffAction({
            name: draft.name,
            email: draft.email,
            password: draft.password,
            role: draft.role,
            branches: scope(),
          }),
        tr("staff.added", { email: draft.email.trim() }),
      );
    } else if (mode.kind === "edit") {
      void run(
        () => updateStaffAction(mode.row.membershipId, { role: draft.role, branches: scope() }),
        tr("staff.saved"),
      );
    } else {
      void run(() => updateStaffAction(mode.row.membershipId, { password: draft.password }), tr("staff.passwordSet"));
    }
  }

  const password = (
    <label className="field">
      <span>{tr("staff.tempPassword", { min: PASSWORD_MIN })}</span>
      <input
        type="text"
        required
        dir="ltr"
        minLength={PASSWORD_MIN}
        maxLength={PASSWORD_MAX}
        autoComplete="off"
        value={draft.password}
        onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
        className="input"
      />
    </label>
  );

  const roleAndBranches = (
    <>
      <label className="field">
        <span>{tr("staff.role")}</span>
        <select
          value={draft.role}
          onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value as StaffRole }))}
          className="input"
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {tr(`staff.role.${role}`)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend>{tr("staff.branches")}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={draft.all} onChange={() => setDraft((d) => ({ ...d, all: true }))} />
          {tr("staff.allBranches")}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!draft.all} onChange={() => setDraft((d) => ({ ...d, all: false }))} />
          {tr("staff.someBranches")}
        </label>
        {draft.all
          ? null
          : activeBranches.map((branch) => (
              <label key={branch.id} className="flex items-center gap-2 ps-6">
                <input
                  type="checkbox"
                  checked={draft.branchIds.includes(branch.id)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      branchIds: e.target.checked
                        ? [...d.branchIds, branch.id]
                        : d.branchIds.filter((id) => id !== branch.id),
                    }))
                  }
                />
                {branch.name}
              </label>
            ))}
      </fieldset>
    </>
  );

  const form = mode ? (
    <form onSubmit={submit} className="card flex max-w-lg flex-col gap-3 p-4">
      {mode.kind === "add" ? (
        <>
          <label className="field">
            <span>{tr("staff.name")}</span>
            <input
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="input"
            />
          </label>
          <label className="field">
            <span>{tr("staff.email")}</span>
            <input
              type="email"
              required
              dir="ltr"
              autoComplete="off"
              value={draft.email}
              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
              className="input"
            />
          </label>
          {password}
          {roleAndBranches}
        </>
      ) : (
        <p className="font-medium">{mode.row.name}</p>
      )}
      {mode.kind === "edit" ? roleAndBranches : null}
      {mode.kind === "password" ? password : null}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {mode.kind === "add" ? tr("staff.add") : tr("staff.save")}
        </button>
        <button type="button" onClick={() => setMode(null)} className="btn">
          {tr("staff.cancel")}
        </button>
      </div>
    </form>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {mode === null ? (
        <button type="button" onClick={() => open({ kind: "add" })} className="btn btn-primary self-start">
          {tr("staff.add")}
        </button>
      ) : null}
      {mode?.kind === "add" ? form : null}
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "text-danger" : "text-success"}
        >
          {message.text}
        </p>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("staff.name")}</th>
              <th className="text-start">{tr("staff.email")}</th>
              <th className="text-start">{tr("staff.role")}</th>
              <th className="text-start">{tr("staff.branches")}</th>
              <th className="text-start">{tr("staff.status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((row) => {
              const editable = !row.isSelf && canManageRole(actorRole, row.role);
              const editing = mode && mode.kind !== "add" && mode.row.membershipId === row.membershipId;
              return (
                <tr key={row.membershipId} className="border-t border-border align-top">
                  <td>
                    {row.name}
                    {row.isSelf ? <span className="text-muted"> ({tr("staff.you")})</span> : null}
                  </td>
                  <td dir="ltr" className="text-start">
                    {row.email}
                  </td>
                  <td>{tr(`staff.role.${row.role}`)}</td>
                  <td>
                    {row.allBranches
                      ? tr("staff.allBranches")
                      : row.branchIds.map((id) => branchName.get(id) ?? "").join(locale === "ar" ? "، " : ", ")}
                  </td>
                  <td>{row.isActive ? tr("staff.active") : tr("staff.inactive")}</td>
                  <td>
                    {editing ? (
                      form
                    ) : editable ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        <button type="button" className="btn btn-sm" onClick={() => open({ kind: "edit", row })}>
                          {tr("staff.edit")}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => open({ kind: "password", row })}>
                          {tr("staff.resetPassword")}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          className="btn btn-sm"
                          onClick={() =>
                            void run(
                              () => updateStaffAction(row.membershipId, { isActive: !row.isActive }),
                              row.isActive ? tr("staff.deactivated") : tr("staff.reactivated"),
                            )
                          }
                        >
                          {row.isActive ? tr("staff.deactivate") : tr("staff.reactivate")}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
