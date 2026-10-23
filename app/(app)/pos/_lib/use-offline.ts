"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReceiptDoc, TillSnapshot } from "@/modules/sales";
import type { Discount } from "@/modules/sales/totals";
import { safeAction } from "../../inventory/_lib/form";
import { createSaleAction, enrolTillDeviceAction, tillSnapshotAction } from "../actions";
import {
  buildOfflineSale,
  offlineBlock,
  reach,
  replayOrder,
  replayStep,
  unreachable,
  type OfflineBlock,
  type OfflineDevice,
  type QueueEntry,
  type SaleBody,
} from "./offline";
import * as store from "./offline-db";
import type { CartLine, PaymentPlan } from "./till";

/** OF7 refresh while online; OF11 replay round. */
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const REPLAY_EVERY_MS = 30_000;

export type OfflineSale = { ok: true; receipt: ReceiptDoc } | { ok: false; block: OfflineBlock };

/**
 * The till's offline state (offline-till-spec slice 2): the enrolled device, the cached snapshot, the queue, and
 * whether the server is reachable. Replays the queue oldest first on reconnect and every 30 s. Does nothing for a
 * shop without offline sales unless this browser still holds a device or queued sales.
 */
export function useOfflineTill({
  branchId,
  registerId,
  userId,
  allowed,
}: {
  branchId: string;
  registerId: string;
  userId: string;
  allowed: boolean;
}) {
  const [device, setDevice] = useState<OfflineDevice | null>(null);
  const [snapshot, setSnapshot] = useState<TillSnapshot | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [contactAt, setContactAt] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  // A replay was refused for want of a session: the cashier must sign in again (OF17).
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const syncing = useRef(false);
  const offlineRef = useRef(false);
  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  const reloadQueue = useCallback(async () => setQueue(await store.loadQueue(registerId)), [registerId]);

  const contact = useCallback(async () => {
    const at = new Date().toISOString();
    setContactAt(at);
    setOffline(false);
    setNeedsSignIn(false);
    await store.saveContact(registerId, at).catch(() => undefined);
  }, [registerId]);

  const refresh = useCallback(async () => {
    const result = await reach(() => tillSnapshotAction(branchId, registerId));
    if (unreachable(result)) {
      setOffline(true);
      return;
    }
    if (result === "UNREACHABLE" || !result.ok) return;
    await contact();
    setSnapshot(result.data);
    await store.saveSnapshot(result.data).catch(() => undefined);
  }, [branchId, registerId, contact]);

  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const pending = replayOrder((await store.loadQueue(registerId)).filter((entry) => entry.status === "PENDING"));
      for (const entry of pending) {
        const result = await reach(() => createSaleAction(entry.body, entry.key));
        const step = replayStep(result);
        if (step === "STOP") {
          if (unreachable(result)) setOffline(true);
          else if (result !== "UNREACHABLE" && !result.ok && result.error.code === "UNAUTHENTICATED") {
            setNeedsSignIn(true);
          }
          break;
        }
        await contact();
        if (step === "DONE") await store.deleteEntry(entry.key);
        else if (result !== "UNREACHABLE" && !result.ok) {
          await store.updateEntry({ ...entry, status: "REJECTED", error: result.error });
        }
      }
    } finally {
      syncing.current = false;
      await reloadQueue().catch(() => undefined);
    }
  }, [registerId, contact, reloadQueue]);

  // Load what this browser holds for the register, then refresh and replay. IndexedDB may be unavailable
  // (a private window): the till then simply sells online only.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [savedDevice, savedSnapshot, savedContact, savedQueue] = await Promise.all([
          store.loadDevice(registerId),
          store.loadSnapshot(registerId),
          store.loadContact(registerId),
          store.loadQueue(registerId),
        ]);
        if (!live) return;
        setDevice(savedDevice);
        setSnapshot(savedSnapshot);
        setContactAt(savedContact);
        setQueue(savedQueue);
      } catch {
        // No storage: offline selling stays off on this browser.
      }
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [registerId]);

  const active = loaded && (allowed || device !== null || queue.length > 0);
  useEffect(() => {
    if (!active) return;
    const wantSnapshot = device !== null;
    const onOnline = () => {
      if (wantSnapshot) void refresh();
      void sync();
    };
    // Now, then each round; an offline device with nothing queued probes with the snapshot instead.
    const first = setTimeout(onOnline, 0);
    const replay = setInterval(() => {
      void sync();
      if (wantSnapshot && offlineRef.current) void refresh();
    }, REPLAY_EVERY_MS);
    const snap = wantSnapshot ? setInterval(() => void refresh(), SNAPSHOT_EVERY_MS) : undefined;
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(first);
      clearInterval(replay);
      clearInterval(snap);
      window.removeEventListener("online", onOnline);
    };
  }, [active, device, refresh, sync]);

  const block = offlineBlock({
    snapshot,
    device,
    userId,
    lastContactAt: contactAt,
    queued: queue.length,
    now: new Date(),
  });

  /** Rings the cart up offline: stored (with its number) before the slip is shown (OF10). */
  async function sellOffline(input: {
    key: string;
    body: SaleBody;
    cart: readonly CartLine[];
    saleDiscount: Discount | null;
    plan: PaymentPlan;
  }): Promise<OfflineSale> {
    const now = new Date();
    const why =
      input.body.customerId !== undefined
        ? "CUSTOMER"
        : offlineBlock({ snapshot, device, userId, lastContactAt: contactAt, queued: queue.length, now });
    if (why || !snapshot) return { ok: false, block: why ?? "NOT_ENABLED" };
    const receipt = await store.queueSale(registerId, (stored, seq) => {
      const built = buildOfflineSale({ ...input, snapshot, device: stored, seq, soldAt: now });
      return {
        entry: {
          key: input.key,
          registerId,
          number: built.number,
          soldAt: now.toISOString(),
          totalMinor: built.totalMinor,
          body: built.body,
          status: "PENDING",
          error: null,
        },
        result: built.receipt,
      };
    });
    setOffline(true);
    await reloadQueue();
    return { ok: true, receipt };
  }

  /** OF16: enrols this browser for the register (Owner) and asks the browser to keep its storage. */
  async function enrol(): Promise<boolean> {
    const result = await safeAction(() => enrolTillDeviceAction(registerId));
    if (!result.ok) return false;
    await store.saveDevice(result.data);
    setDevice(result.data);
    await navigator.storage?.persist?.().catch(() => false);
    return true;
  }

  return {
    device,
    snapshot,
    queue,
    offline,
    needsSignIn,
    block,
    markUnreachable: () => setOffline(true),
    contact,
    sellOffline,
    enrol,
  };
}
