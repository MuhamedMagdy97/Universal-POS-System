"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { DiningTableRow } from "@/modules/org";
import { safeAction } from "../../inventory/_lib/form";
import { saveTablesAction } from "../actions";

type Draft = { id?: string; name: string; area: string };

/** One branch's tables: rename, set an area, add, remove and reorder; saved together. */
export function TablesManager({
  locale,
  branch,
  tables,
}: {
  locale: Locale;
  branch: { id: string; name: string };
  tables: DiningTableRow[];
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [rows, setRows] = useState<Draft[]>(
    tables.map((table) => ({ id: table.id, name: table.name, area: table.area ?? "" })),
  );
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (index: number, patch: Partial<Draft>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(Math.min(Math.max(index + by, 0), next.length), 0, row);
      return next;
    });

  function save(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await safeAction(() =>
        saveTablesAction({
          branchId: branch.id,
          tables: rows
            .filter((row) => row.name.trim() !== "")
            .map((row) => ({ ...(row.id ? { id: row.id } : {}), name: row.name, area: row.area.trim() || null })),
        }),
      );
      if (!result.ok) {
        setNotice({
          ok: false,
          text: tr(result.error.code === "VALIDATION_FAILED" ? "settings.tables.invalid" : "settings.shop.error"),
        });
        return;
      }
      setNotice({ ok: true, text: tr("settings.shop.saved") });
      router.refresh();
    });
  }

  return (
    <form onSubmit={save} className="card flex max-w-2xl flex-col gap-3" aria-label={branch.name}>
      <h2 className="text-lg font-semibold">{branch.name}</h2>
      {rows.length === 0 ? <p className="text-muted">{tr("settings.tables.none")}</p> : null}
      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li key={row.id ?? `new-${index}`} className="flex flex-wrap items-center gap-2">
            <input
              className="input w-32"
              aria-label={tr("settings.tables.name", { n: index + 1 })}
              value={row.name}
              maxLength={40}
              onChange={(event) => set(index, { name: event.target.value })}
            />
            <input
              className="input w-40"
              aria-label={tr("settings.tables.area", { n: index + 1 })}
              placeholder={tr("settings.tables.areaHint")}
              value={row.area}
              maxLength={40}
              onChange={(event) => set(index, { area: event.target.value })}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => move(index, -1)}
              aria-label={tr("settings.tables.up", { n: index + 1 })}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => move(index, 1)}
              aria-label={tr("settings.tables.down", { n: index + 1 })}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              aria-label={tr("settings.tables.remove", { n: index + 1 })}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn-sm self-start"
        onClick={() => setRows((current) => [...current, { name: String(current.length + 1), area: "" }])}
      >
        {tr("settings.tables.add")}
      </button>
      {notice ? (
        <p role={notice.ok ? "status" : "alert"} className={`notice ${notice.ok ? "notice-success" : "notice-error"}`}>
          {notice.text}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary self-start" disabled={pending}>
        {tr("settings.shop.save")}
      </button>
    </form>
  );
}
