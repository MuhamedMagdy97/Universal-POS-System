"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import type { ImsWarehouse, InventoryLinkStatus } from "@/modules/integrations/inventory-sys";
import { ConfirmDialog } from "../../catalog/_components/confirm-dialog";
import { plain, safeAction, type ActionResult } from "../../inventory/_lib/form";
import {
  checkInventoryLinkAction,
  mapInventoryBranchesAction,
  saveInventoryLinkAction,
  setInventorySourceAction,
  syncInventoryAction,
} from "../actions";
import { inventoryErrorKey } from "../_lib/inventory";

type Notice = { tone: "ok" | "error"; key: MessageKey } | null;

const input = "rounded-md border border-border bg-background px-3 py-2";
const button = "self-start rounded-md border border-border px-4 py-2 disabled:opacity-50";

/**
 * Link form, connection test, the source toggle, the branch → warehouse map and "Sync now". The API
 * key field always starts empty.
 */
export function InventorySettings({
  locale,
  status,
  warehouses,
}: {
  locale: Locale;
  status: InventoryLinkStatus;
  warehouses: ImsWarehouse[] | null;
}) {
  const tr = translator(locale);
  const { link, canManage, source } = status;
  const [baseUrl, setBaseUrl] = useState(link?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);
  const target = source === "EXTERNAL" ? "BUILT_IN" : "EXTERNAL";
  const activeBranches = status.branches.filter((branch) => branch.isActive);
  const [branchMap, setBranchMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(status.branches.map((branch) => [branch.id, branch.warehouseId ?? ""])),
  );

  async function act<T>(run: () => Promise<ActionResult<T>>, okKey: (data: T) => Notice): Promise<void> {
    setPending(true);
    setNotice(null);
    const result = await safeAction(run);
    setPending(false);
    setNotice(result.ok ? okKey(result.data) : { tone: "error", key: inventoryErrorKey(result.error) });
  }

  const checkNotice = (data: { ok: boolean; problem?: "UNREACHABLE" | "REFUSED" | "UNEXPECTED" }): Notice =>
    data.ok
      ? { tone: "ok", key: "settings.inventory.check.ok" }
      : { tone: "error", key: `settings.inventory.check.${data.problem ?? "UNEXPECTED"}` };

  async function save(event: FormEvent) {
    event.preventDefault();
    await act(() => saveInventoryLinkAction({ baseUrl, ...(apiKey ? { apiKey } : {}) }), checkNotice);
    setApiKey("");
  }

  const summary = link?.lastSyncSummary;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <section aria-labelledby="inv-source" className="flex flex-col gap-2">
        <h2 id="inv-source" className="text-lg font-medium">
          {tr("settings.inventory.source")}
        </h2>
        <p data-testid="inventory-source">{plain(locale, `settings.inventory.source.${source}`)}</p>
        {canManage ? (
          <button type="button" className={button} disabled={pending} onClick={() => setConfirming(true)}>
            {tr(target === "EXTERNAL" ? "settings.inventory.enable" : "settings.inventory.disable")}
          </button>
        ) : (
          <p className="text-muted">{tr("settings.inventory.ownerOnly")}</p>
        )}
      </section>

      <section aria-labelledby="inv-connection" className="flex flex-col gap-3">
        <h2 id="inv-connection" className="text-lg font-medium">
          {tr("settings.inventory.connection")}
        </h2>
        {!status.encryptionReady ? <p role="alert">{tr("settings.inventory.encryptionMissing")}</p> : null}
        {canManage && status.encryptionReady ? (
          <form onSubmit={save} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span>{tr("settings.inventory.baseUrl")}</span>
              <input
                name="baseUrl"
                type="url"
                required
                dir="ltr"
                value={baseUrl}
                placeholder="https://inventory.example.com"
                onChange={(e) => setBaseUrl(e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>{tr("settings.inventory.apiKey")}</span>
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                dir="ltr"
                required={!link}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={input}
              />
              <span className="text-sm text-muted">
                {link
                  ? tr("settings.inventory.apiKeyKeep", { last4: link.keyLast4 })
                  : tr("settings.inventory.apiKeyNew")}
              </span>
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
              >
                {pending ? tr("settings.inventory.working") : tr("settings.inventory.save")}
              </button>
              {link ? (
                <button
                  type="button"
                  className={button}
                  disabled={pending}
                  onClick={() => act(checkInventoryLinkAction, checkNotice)}
                >
                  {tr("settings.inventory.test")}
                </button>
              ) : null}
            </div>
          </form>
        ) : link ? (
          <p dir="ltr" className="self-start">
            {link.baseUrl} · •••• {link.keyLast4}
          </p>
        ) : null}
        <p className="text-sm text-muted">
          {!link?.lastCheckAt
            ? tr("settings.inventory.check.never")
            : link.lastCheckOk
              ? tr("settings.inventory.check.ok")
              : tr("settings.inventory.check.failed")}
        </p>
      </section>

      {link?.lastCheckOk ? (
        <section aria-labelledby="inv-branches" className="flex flex-col gap-2">
          <h2 id="inv-branches" className="text-lg font-medium">
            {tr("settings.inventory.branches")}
          </h2>
          <p className="text-sm text-muted">{tr("settings.inventory.branches.intro")}</p>
          {warehouses === null ? (
            <p role="alert">{tr("settings.inventory.branches.unavailable")}</p>
          ) : (
            <>
              {activeBranches.map((branch) => (
                <label key={branch.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-40">
                    {branch.name} ({branch.code})
                  </span>
                  <select
                    name={`warehouse-${branch.code}`}
                    className={input}
                    disabled={!canManage || pending}
                    value={branchMap[branch.id] ?? ""}
                    onChange={(e) => setBranchMap({ ...branchMap, [branch.id]: e.target.value })}
                  >
                    <option value="">{tr("settings.inventory.branches.none")}</option>
                    {warehouses
                      .filter((w) => w.status === "active" || w.id === branchMap[branch.id])
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {w.name}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              {canManage && activeBranches.length > 0 ? (
                <button
                  type="button"
                  className={button}
                  disabled={pending}
                  onClick={() =>
                    act(
                      () =>
                        mapInventoryBranchesAction(
                          activeBranches.map((branch) => ({
                            branchId: branch.id,
                            warehouseId: branchMap[branch.id] || null,
                          })),
                        ),
                      () => ({ tone: "ok", key: "settings.inventory.branches.saved" }),
                    )
                  }
                >
                  {tr("settings.inventory.branches.save")}
                </button>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {source === "EXTERNAL" ? (
        <section aria-labelledby="inv-sync" className="flex flex-col gap-2">
          <h2 id="inv-sync" className="text-lg font-medium">
            {tr("settings.inventory.sync")}
          </h2>
          <p data-testid="inventory-sync-status" className="text-sm text-muted">
            {!link?.lastSyncFinishedAt
              ? tr("settings.inventory.sync.never")
              : link.lastSyncOk
                ? tr("settings.inventory.sync.result", {
                    created: summary?.created ?? 0,
                    updated: summary?.updated ?? 0,
                    archived: summary?.archived ?? 0,
                    skipped: summary?.skipped?.length ?? 0,
                  })
                : tr("settings.inventory.sync.failed")}
          </p>
          {status.postings.pending + status.postings.failed > 0 ? (
            <p data-testid="inventory-postings" role="status" className="text-sm">
              {tr("settings.inventory.postings", status.postings)}
            </p>
          ) : null}
          <button
            type="button"
            className={button}
            disabled={pending}
            onClick={() => act(syncInventoryAction, () => null)}
          >
            {pending ? tr("settings.inventory.working") : tr("settings.inventory.sync")}
          </button>
        </section>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={notice.tone === "error" ? "text-red-700" : "text-green-800"}
        >
          {plain(locale, notice.key)}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={tr(target === "EXTERNAL" ? "settings.inventory.enableTitle" : "settings.inventory.disableTitle")}
        body={tr(target === "EXTERNAL" ? "settings.inventory.enableBody" : "settings.inventory.disableBody")}
        confirmLabel={tr("settings.inventory.confirm")}
        cancelLabel={tr("settings.inventory.cancel")}
        pending={pending}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await act(
            () => setInventorySourceAction(target),
            (data) =>
              data.syncError
                ? {
                    tone: "error",
                    key: inventoryErrorKey({ code: "CONFLICT", message: "", details: { reason: data.syncError } }),
                  }
                : null,
          );
          setConfirming(false);
        }}
      />
    </div>
  );
}
