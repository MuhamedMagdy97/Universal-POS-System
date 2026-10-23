"use client";

import { useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { archiveCategoryAction, createCategoryAction, restoreCategoryAction, updateCategoryAction } from "../actions";
import { mapErrorBody, NO_ERRORS, type FormErrors } from "../_lib/form-errors";
import { displayName } from "../_lib/form-helpers";
import { StatusBadge } from "./shell";

export type CategoryRow = {
  id: string;
  parentId: string | null;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  depth: number;
  updatedAt: string;
};

type Props = { locale: Locale; rows: CategoryRow[]; maxDepth: number; canCreate: boolean; canUpdate: boolean };

const inputClass = "input";

/**
 * Category tree (up to 3 levels): inline add (Enter saves), rename (F2 or the
 * Rename button, Enter saves, Esc cancels), archive and restore. Archiving is
 * blocked only by active sub-categories (R5); products keep their category.
 */
export function CategoriesManager({ locale, rows, maxDepth, canCreate, canUpdate }: Props) {
  const tr = translator(locale);
  const [pending, startTransition] = useTransition();
  const [createErrors, setCreateErrors] = useState<FormErrors>(NO_ERRORS);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", nameAr: "", parentId: "" });

  const parentOptions = rows.filter((r) => r.isActive && r.depth < maxDepth);

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.name.trim() === "") {
      setCreateErrors({ fields: { name: tr("catalog.form.error.required") }, summary: null, stale: false });
      return;
    }
    startTransition(async () => {
      const result = await createCategoryAction({
        name: draft.name,
        ...(draft.nameAr.trim() ? { nameAr: draft.nameAr } : {}),
        parentId: draft.parentId || null,
      });
      if (!result.ok) {
        setCreateErrors(mapErrorBody(result.error, tr));
        return;
      }
      setCreateErrors(NO_ERRORS);
      setDraft({ name: "", nameAr: "", parentId: draft.parentId });
    });
  }

  function runRow(id: string, action: () => Promise<{ ok: boolean; error?: Parameters<typeof mapErrorBody>[0] }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok && result.error) {
        const mapped = mapErrorBody(result.error, tr);
        setRowError({ id, message: Object.values(mapped.fields)[0] ?? mapped.summary ?? "" });
        return;
      }
      setRowError(null);
      setEditing(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {canCreate ? (
        <form onSubmit={onCreate} className="card flex flex-wrap items-end gap-3 p-4">
          <label className="field">
            <span className="text-sm">{tr("catalog.form.name")}</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              aria-invalid={createErrors.fields.name ? true : undefined}
              className={inputClass}
            />
          </label>
          <label className="field">
            <span className="text-sm">{tr("catalog.form.nameAr")}</span>
            <input
              value={draft.nameAr}
              onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })}
              maxLength={120}
              dir="rtl"
              lang="ar"
              className={inputClass}
            />
          </label>
          <label className="field">
            <span className="text-sm">{tr("catalog.categories.parent")}</span>
            <select
              value={draft.parentId}
              onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
              className={inputClass}
            >
              <option value="">{tr("catalog.categories.noParent")}</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {`${"— ".repeat(p.depth - 1)}${displayName(locale, p)}`}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending} className="btn btn-primary">
            {tr("catalog.categories.add")}
          </button>
          <p className="w-full text-xs text-muted">{tr("catalog.categories.depthHint")}</p>
          {createErrors.summary || createErrors.fields.name ? (
            <p role="alert" className="w-full text-sm text-danger">
              {createErrors.fields.name ?? createErrors.summary}
            </p>
          ) : null}
        </form>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-muted">{tr("catalog.categories.empty")}</p>
      ) : (
        <ul className="card flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <CategoryItem
              key={row.id}
              locale={locale}
              row={row}
              canUpdate={canUpdate}
              pending={pending}
              editing={editing === row.id}
              error={rowError?.id === row.id ? rowError.message : null}
              onEdit={() => setEditing(row.id)}
              onCancel={() => setEditing(null)}
              onRename={(name, nameAr) =>
                runRow(row.id, () =>
                  updateCategoryAction(row.id, {
                    name,
                    nameAr: nameAr.trim() ? nameAr : null,
                    expectedUpdatedAt: row.updatedAt,
                  }),
                )
              }
              onToggle={() =>
                runRow(row.id, () =>
                  row.isActive
                    ? archiveCategoryAction(row.id, { expectedUpdatedAt: row.updatedAt })
                    : restoreCategoryAction(row.id, { expectedUpdatedAt: row.updatedAt }),
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

type ItemProps = {
  locale: Locale;
  row: CategoryRow;
  canUpdate: boolean;
  pending: boolean;
  editing: boolean;
  error: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onRename: (name: string, nameAr: string) => void;
  onToggle: () => void;
};

function CategoryItem({
  locale,
  row,
  canUpdate,
  pending,
  editing,
  error,
  onEdit,
  onCancel,
  onRename,
  onToggle,
}: ItemProps) {
  const tr = translator(locale);
  const [name, setName] = useState(row.name);
  const [nameAr, setNameAr] = useState(row.nameAr ?? "");
  const label = displayName(locale, row);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onRename(name, nameAr);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setName(row.name);
      setNameAr(row.nameAr ?? "");
      onCancel();
    }
  }

  return (
    <li
      className="flex flex-wrap items-center gap-3 px-3 py-2"
      style={{ paddingInlineStart: `${0.75 + (row.depth - 1) * 1.5}rem` }}
      tabIndex={canUpdate && !editing ? 0 : undefined}
      onKeyDown={(e) => {
        if (e.key === "F2" && canUpdate && !editing) {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      {editing ? (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={120}
            autoFocus
            aria-label={tr("catalog.categories.renameLabel", { name: label })}
            className={inputClass}
          />
          <input
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={120}
            dir="rtl"
            lang="ar"
            aria-label={tr("catalog.form.nameAr")}
            className={inputClass}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => onRename(name, nameAr)}
            className="btn btn-primary btn-sm"
          >
            {tr("catalog.form.save")}
          </button>
          <button type="button" onClick={onCancel} className="btn btn-sm">
            {tr("catalog.form.cancel")}
          </button>
        </>
      ) : (
        <>
          <span className={row.isActive ? "font-medium" : "text-muted line-through"}>{label}</span>
          <StatusBadge locale={locale} active={row.isActive} />
          {canUpdate ? (
            <span className="ms-auto flex gap-2">
              {row.isActive ? (
                <button type="button" onClick={onEdit} className="btn btn-sm">
                  {tr("catalog.categories.rename")}
                </button>
              ) : null}
              <button type="button" disabled={pending} onClick={onToggle} className="btn btn-sm">
                {row.isActive ? tr("catalog.archive.action") : tr("catalog.restore.action")}
              </button>
            </span>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
