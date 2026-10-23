"use client";

import { useState } from "react";
import type { ErrorBody } from "@/lib/errors";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import type { OfflineRegisterRow, OfflineSettings } from "@/modules/org";
import { ConfirmDialog } from "../../catalog/_components/confirm-dialog";
import { plain, safeAction, type ActionResult } from "../../inventory/_lib/form";
import { revokeOfflineDeviceAction, setOfflineSalesAction } from "../actions";

type Row = OfflineRegisterRow & { enrolledLocal: string | null };
type Notice = { tone: "ok" | "error"; key: MessageKey } | null;

function errorKey(error: ErrorBody): MessageKey {
  if ((error.details as { reason?: unknown } | null)?.reason === "INVENTORY_LINKED") {
    return "settings.offline.error.INVENTORY_LINKED";
  }
  return error.code === "FORBIDDEN" ? "settings.offline.error.forbidden" : "settings.offline.error.generic";
}

/** The shop toggle and each till's series and device, with Revoke (Owner only). Devices enrol from the till. */
export function OfflineSettingsForm({
  locale,
  settings,
}: {
  locale: Locale;
  settings: Omit<OfflineSettings, "registers"> & { registers: Row[] };
}) {
  const tr = translator(locale);
  const { canManage, linked } = settings;
  const [allow, setAllow] = useState(settings.allowOfflineSales);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);

  async function act(run: () => Promise<ActionResult<null>>, okKey: MessageKey): Promise<boolean> {
    setPending(true);
    setNotice(null);
    const result = await safeAction(run);
    setPending(false);
    setNotice(result.ok ? { tone: "ok", key: okKey } : { tone: "error", key: errorKey(result.error) });
    return result.ok;
  }

  async function toggle(next: boolean) {
    // Shown at once; put back if the server refuses.
    setAllow(next);
    if (!(await act(() => setOfflineSalesAction(next), "settings.offline.saved"))) setAllow(!next);
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="allowOfflineSales"
            checked={allow}
            disabled={!canManage || pending || (linked && !allow)}
            aria-describedby="allow-offline-hint"
            onChange={(e) => toggle(e.target.checked)}
            className="mt-1"
          />
          <span className="flex flex-col gap-1">
            <span>{tr("settings.offline.allow")}</span>
            <span id="allow-offline-hint" className="text-sm text-muted">
              {tr("settings.offline.allowHint")}
            </span>
          </span>
        </label>
        {linked ? <p className="text-sm">{tr("settings.offline.linked")}</p> : null}
        {!canManage ? <p className="text-muted">{tr("settings.offline.ownerOnly")}</p> : null}
      </section>

      <section aria-labelledby="offline-tills" className="flex flex-col gap-2">
        <h2 id="offline-tills" className="text-lg font-medium">
          {tr("settings.offline.tills")}
        </h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr className="border-b border-border text-start">
                <th>{tr("settings.offline.till")}</th>
                <th>{tr("settings.offline.series")}</th>
                <th>{tr("settings.offline.lastNumber")}</th>
                <th>{tr("settings.offline.device")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {settings.registers.map((register) => (
                <tr key={register.id}>
                  <td>
                    {register.branchName} · {register.name}
                  </td>
                  <td dir="ltr">{register.offlineCode ?? "—"}</td>
                  <td dir="ltr">
                    {register.offlineCode && register.lastOfflineSaleNo > 0
                      ? `${register.offlineCode}-${String(register.lastOfflineSaleNo).padStart(6, "0")}`
                      : "—"}
                  </td>
                  <td>
                    {register.enrolledLocal
                      ? tr("settings.offline.device.enrolled", { date: register.enrolledLocal })
                      : tr("settings.offline.device.none")}
                  </td>
                  <td>
                    {canManage && register.device ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={pending}
                        onClick={() => setRevoking(register)}
                      >
                        {tr("settings.offline.revoke")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={notice.tone === "error" ? "text-danger" : "text-success"}
        >
          {plain(locale, notice.key)}
        </p>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        title={tr("settings.offline.revoke.title")}
        body={revoking ? `${revoking.branchName} · ${revoking.name}. ${tr("settings.offline.revoke.body")}` : undefined}
        confirmLabel={tr("settings.offline.revoke")}
        cancelLabel={tr("settings.offline.cancel")}
        pending={pending}
        onConfirm={async () => {
          const row = revoking;
          if (!row) return;
          await act(() => revokeOfflineDeviceAction(row.id), "settings.offline.revoked");
          setRevoking(null);
        }}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
