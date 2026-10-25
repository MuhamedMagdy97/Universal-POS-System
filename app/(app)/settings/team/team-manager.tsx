"use client";

import { useState, useTransition, type FormEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { parsePercentBp } from "@/lib/money";
import type { StaffMemberRow } from "@/modules/org";
import { saveStaffMemberAction } from "../actions";

type Draft = { id?: string; name: string; nameAr: string; percent: string; branchIds: string[]; isActive: boolean };

const draftOf = (member: StaffMemberRow): Draft => ({
  id: member.id,
  name: member.name,
  nameAr: member.nameAr ?? "",
  percent: String(member.commissionBp / 100),
  branchIds: member.branchIds,
  isActive: member.isActive,
});

/** A card per staff member and one for a new one: name, Arabic name, commission percent, branches, active. */
export function TeamManager({
  locale,
  members,
  branches,
}: {
  locale: Locale;
  members: StaffMemberRow[];
  branches: { id: string; name: string }[];
}) {
  const tr = translator(locale);
  return (
    <div className="flex flex-col gap-4">
      {members.length === 0 ? <p className="text-muted">{tr("settings.team.none")}</p> : null}
      {members.map((member) => (
        <MemberCard key={member.id} locale={locale} branches={branches} initial={draftOf(member)} />
      ))}
      <MemberCard
        locale={locale}
        branches={branches}
        initial={{
          name: "",
          nameAr: "",
          percent: "0",
          branchIds: branches.slice(0, 1).map((b) => b.id),
          isActive: true,
        }}
      />
    </div>
  );
}

function MemberCard({
  locale,
  branches,
  initial,
}: {
  locale: Locale;
  branches: { id: string; name: string }[];
  initial: Draft;
}) {
  const tr = translator(locale);
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const title = initial.id ? initial.name : tr("settings.team.new");

  function save(event: FormEvent) {
    event.preventDefault();
    const commissionBp = draft.percent.trim() === "" ? 0 : parsePercentBp(draft.percent);
    if (commissionBp === null || draft.name.trim() === "" || draft.branchIds.length === 0) {
      setNotice({ ok: false, text: tr("settings.team.invalid") });
      return;
    }
    startTransition(async () => {
      const result = await saveStaffMemberAction({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        nameAr: draft.nameAr.trim() || null,
        commissionBp,
        branchIds: draft.branchIds,
        isActive: draft.isActive,
      });
      if (!result.ok) {
        setNotice({
          ok: false,
          text: tr(result.error.code === "VALIDATION_FAILED" ? "settings.team.invalid" : "settings.shop.error"),
        });
        return;
      }
      setNotice({ ok: true, text: tr("settings.shop.saved") });
      if (!initial.id) setDraft(initial);
      else setDraft(draftOf(result.data));
    });
  }

  return (
    <form onSubmit={save} className="card flex max-w-2xl flex-col gap-3" aria-label={title}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <fieldset className="flex flex-wrap gap-3" disabled={pending}>
        <label className="field">
          <span className="text-sm">{tr("catalog.form.name")}</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="text-sm">{tr("catalog.form.nameAr")}</span>
          <input
            className="input"
            dir="rtl"
            value={draft.nameAr}
            onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="text-sm">{tr("settings.team.commission")}</span>
          <input
            className="input w-24"
            dir="ltr"
            inputMode="decimal"
            value={draft.percent}
            onChange={(e) => setDraft({ ...draft, percent: e.target.value })}
          />
        </label>
      </fieldset>
      <fieldset className="flex flex-wrap gap-3" disabled={pending}>
        <legend className="mb-1 text-sm">{tr("settings.team.branches")}</legend>
        {branches.map((branch) => (
          <label key={branch.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.branchIds.includes(branch.id)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  branchIds: e.target.checked
                    ? [...draft.branchIds, branch.id]
                    : draft.branchIds.filter((id) => id !== branch.id),
                })
              }
            />
            {branch.name}
          </label>
        ))}
      </fieldset>
      {initial.id ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          />
          {tr("settings.team.active")}
        </label>
      ) : null}
      {notice ? (
        <p role={notice.ok ? "status" : "alert"} className={`notice ${notice.ok ? "notice-success" : "notice-error"}`}>
          {notice.text}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary self-start" disabled={pending}>
        {tr(initial.id ? "settings.shop.save" : "settings.team.add")}
      </button>
    </form>
  );
}
