import "server-only";
/**
 * Sale posting to the inventory system (integration spec I12–I17, I19; slice 2).
 *
 * A sale reserves every merged line in the IMS **before** the POS transaction, commits with one
 * `FULFIL` posting per line instead of POS stock movements, then fulfils after commit. Refunds and
 * voids write a `RETURN` posting in their transaction and are never blocked by an outage. Every
 * call carries an idempotency key derived from the POS document's own key (I13), so a retry replays
 * the IMS's first answer. What is not sent at once stays `PENDING` for `drainPostings`.
 *
 * Keys of a sale carry an attempt number: a refused sale cancels its reservations and records the
 * attempt, so a retry with the same till key reserves afresh instead of replaying cancelled ones.
 * A crash between reserve and commit records nothing, so the retry replays the same reservations.
 */
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { ExternalStockPosting, Prisma } from "@/lib/generated/prisma/client";
import { externalVariantIdsOf } from "@/modules/catalog";
import { imsGet, imsPost, type ImsLink } from "./client";
import { loadLink, openLink } from "./link";

type Tx = Prisma.TransactionClient;
type Ref = { productId: string; variantId: string | null };
type ImsErrorDetails = { reason?: string; imsCode?: string; imsDetails?: { available?: string; status?: string } };

const PARALLEL = 4;
const CALL_MS = 5_000;
const SALE_MS = 10_000;
/** How long a sale, refund or void waits for its own postings after commit (the rest is drained later). */
const AFTER_COMMIT_MS = 2_000;
const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60];

export function inventoryUnavailable(): AppError {
  return new AppError(
    "INVENTORY_UNAVAILABLE",
    "Can't reach the inventory system. The sale was not completed; try again",
    { reason: "INVENTORY_UNAVAILABLE" },
  );
}

const linkBroken = () =>
  new AppError("CONFLICT", "The inventory link needs attention — ask the owner", { reason: "INVENTORY_LINK_BROKEN" });

const detailsOf = (err: unknown): ImsErrorDetails | null =>
  err instanceof AppError ? (err.details as ImsErrorDetails | null) : null;

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/** Runs `fn` over `items`, at most PARALLEL at a time; every call settles. */
async function settleAll<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>) {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) {
    out.push(...(await Promise.allSettled(items.slice(i, i + PARALLEL).map((item, j) => fn(item, i + j)))));
  }
  return out;
}

async function linkOf(orgId: string): Promise<ImsLink> {
  const row = await loadLink(orgId);
  if (!row) throw linkBroken();
  try {
    return openLink(row);
  } catch {
    throw linkBroken();
  }
}

async function warehouseOf(orgId: string, branchId: string): Promise<string | null> {
  const branch = await getDb().branch.findFirst({
    where: { id: branchId, orgId },
    select: { externalWarehouseId: true },
  });
  return branch?.externalWarehouseId ?? null;
}

/** What a sale holds in the IMS between reserve and commit. */
export type HeldSale = {
  orgId: string;
  link: ImsLink;
  orderHash: string;
  attempt: number;
  keyPrefix: string;
  orderRefId: string | null;
  lines: { lineNo: number; reservationId: string; version: number; qty: number }[];
};

type ReserveAnswer = { reservation: { id: string; version: number; salesOrderRefId: string | null } };

/**
 * I12 steps 1–3: reserves every merged line at the branch's warehouse, or refuses the sale with
 * nothing held (what was reserved is cancelled) and nothing written in the POS.
 */
export async function reserveSale(
  orgId: string,
  branchId: string,
  saleKey: string,
  lines: readonly { ref: Ref; qty: number }[],
): Promise<HeldSale> {
  const db = getDb();
  const warehouseId = await warehouseOf(orgId, branchId);
  if (!warehouseId) {
    throw new AppError("CONFLICT", "This branch is not linked to a warehouse yet", {
      reason: "INVENTORY_BRANCH_UNMAPPED",
    });
  }
  const variantIds = await externalVariantIdsOf(
    db,
    orgId,
    lines.map((line) => line.ref),
  );
  const unlinked = variantIds.indexOf(null);
  if (unlinked >= 0) {
    throw new AppError("VALIDATION_FAILED", "This item is not in the inventory system", {
      reason: "ITEM_NOT_SELLABLE",
      index: unlinked,
      cause: "NOT_LINKED",
      ...lines[unlinked].ref,
    });
  }
  const link = await linkOf(orgId);
  const orderHash = hashOf(saleKey);
  const attempt = await db.externalStockPosting.count({
    where: { orgId, sourceType: "SaleAttempt", sourceId: orderHash },
  });
  const keyPrefix = `pos:${saleKey}:${attempt}`;
  const deadline = AbortSignal.timeout(SALE_MS);
  const results = await settleAll(lines, (line, index) =>
    imsPost<ReserveAnswer>(
      link,
      "/api/reservations",
      { variantId: variantIds[index], warehouseId, qty: line.qty, externalOrderId: `${orderHash}:${attempt}` },
      `${keyPrefix}:r:${index + 1}`,
      AbortSignal.any([deadline, AbortSignal.timeout(CALL_MS)]),
    ),
  );

  const held: HeldSale = { orgId, link, orderHash, attempt, keyPrefix, orderRefId: null, lines: [] };
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const { id, version, salesOrderRefId } = result.value.reservation;
    held.lines.push({ lineNo: index + 1, reservationId: id, version, qty: lines[index].qty });
    held.orderRefId ??= salesOrderRefId;
  });
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [{ index, err: result.reason }] : [],
  );
  if (failures.length === 0) return held;
  await releaseSale(held);
  throw refusal(failures, lines, branchId);
}

/** I17: the answer the till shows for a refused reserve. Short stock first: the cashier can act on it. */
function refusal(
  failures: { index: number; err: unknown }[],
  lines: readonly { ref: Ref; qty: number }[],
  branchId: string,
) {
  const code = (failure: { err: unknown }) => detailsOf(failure.err)?.imsCode;
  const short = failures.filter((failure) => code(failure) === "insufficient_stock");
  if (short.length > 0) {
    return new AppError("CONFLICT", "There is not enough stock for this sale", {
      reason: "INSUFFICIENT_STOCK",
      lines: short.map(({ index, err }) => ({
        ...lines[index].ref,
        branchId,
        onHand: Math.max(Math.floor(Number(detailsOf(err)?.imsDetails?.available ?? 0)), 0),
        requested: lines[index].qty,
      })),
    });
  }
  const gone = failures.find(
    (failure) =>
      ["archived_conflict", "discontinued_conflict"].includes(code(failure) ?? "") ||
      (failure.err instanceof AppError && failure.err.code === "NOT_FOUND"),
  );
  if (gone) {
    return new AppError("VALIDATION_FAILED", "This item can no longer be sold", {
      reason: "ITEM_NOT_SELLABLE",
      index: gone.index,
      cause: "INVENTORY_STATUS",
      ...lines[gone.index].ref,
    });
  }
  const reasons = failures.map((failure) => detailsOf(failure.err)?.reason);
  if (reasons.includes("INVENTORY_LINK_BROKEN")) return linkBroken();
  const rejected = failures.find((failure) => detailsOf(failure.err)?.reason === "INVENTORY_REJECTED");
  if (rejected) {
    return new AppError("CONFLICT", "The inventory system refused this sale", {
      reason: "INVENTORY_REJECTED",
      imsCode: code(rejected),
    });
  }
  return inventoryUnavailable();
}

/**
 * Gives back what a refused or failed sale reserved: records the attempt (so a retry reserves
 * afresh) and cancels the attempt's IMS order. A cancel that cannot be sent stays PENDING; the
 * reservations also expire on their own after the IMS's `pos` TTL. Never throws.
 */
export async function releaseSale(held: HeldSale): Promise<void> {
  let row: ExternalStockPosting;
  try {
    row = await getDb().externalStockPosting.create({
      data: {
        orgId: held.orgId,
        kind: "CANCEL",
        sourceType: "SaleAttempt",
        sourceId: held.orderHash,
        lineNo: held.attempt,
        qty: held.lines.length,
        idempotencyKey: `${held.keyPrefix}:cancel`,
        externalOrderRefId: held.orderRefId,
        // ponytail: an attempt whose every reserve timed out has no known order id; its holds expire (TTL).
        status: held.orderRefId ? "PENDING" : "DONE",
      },
    });
  } catch {
    return; // a concurrent request with the same key already released this attempt
  }
  if (row.status === "PENDING") await send(row, held.link, AbortSignal.timeout(CALL_MS));
}

/** I12 step 4, inside the sale's transaction: one FULFIL posting per merged line. */
export async function recordSaleFulfils(tx: Tx, held: HeldSale, saleId: string, saleItemIds: string[]): Promise<void> {
  await tx.externalStockPosting.createMany({
    data: held.lines.map((line) => ({
      orgId: held.orgId,
      kind: "FULFIL" as const,
      sourceType: "Sale",
      sourceId: saleId,
      lineNo: line.lineNo,
      saleItemId: saleItemIds[line.lineNo - 1],
      qty: line.qty,
      idempotencyKey: `${held.keyPrefix}:f:${line.lineNo}`,
      reservationId: line.reservationId,
      reservationVersion: line.version,
      externalOrderRefId: held.orderRefId,
    })),
  });
}

/** I14, inside the refund's transaction: one return of the refunded lines, sent after commit. */
export async function recordRefundReturn(tx: Tx, orgId: string, refundId: string, refundKey: string): Promise<void> {
  await tx.externalStockPosting.create({
    data: { orgId, kind: "RETURN", sourceType: "Refund", sourceId: refundId, idempotencyKey: `pos:${refundKey}:ret` },
  });
}

/**
 * I15, inside the void's transaction: lines not yet fulfilled are cancelled instead (by the drain,
 * which sees the sale VOIDED), and one return takes back the lines that were fulfilled.
 */
export async function recordVoidReturn(tx: Tx, orgId: string, saleId: string): Promise<void> {
  await tx.externalStockPosting.create({
    data: { orgId, kind: "RETURN", sourceType: "Sale", sourceId: saleId, idempotencyKey: `pos:sale:${saleId}:void` },
  });
}

/** After a sale, refund or void committed: sends that document's postings (2 s budget). Never throws. */
export async function postAfterCommit(orgId: string, sourceIds: string[]): Promise<void> {
  try {
    await drainPostings({ orgId, sourceIds, timeoutMs: AFTER_COMMIT_MS });
  } catch {
    // The rows stay PENDING; the next drain sends them.
  }
}

/**
 * Sends PENDING postings (I19): with `sourceIds`, those documents' rows at once; otherwise every
 * row whose `nextAttemptAt` has come, oldest first. Fulfils and cancels go before returns, and a
 * return waits until its sale has no PENDING fulfil. Callers: `postAfterCommit`, "Sync now" and
 * the scheduler route.
 */
export async function drainPostings(
  opts: { orgId?: string; sourceIds?: string[]; timeoutMs?: number; limit?: number } = {},
): Promise<{ sent: number }> {
  const rows = await getDb().externalStockPosting.findMany({
    where: {
      status: "PENDING",
      ...(opts.orgId && { orgId: opts.orgId }),
      ...(opts.sourceIds ? { sourceId: { in: opts.sourceIds } } : { nextAttemptAt: { lte: new Date() } }),
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 200,
  });
  if (rows.length === 0) return { sent: 0 };
  const budget = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const links = new Map<string, Promise<ImsLink | null>>();
  const linkFor = (orgId: string) => {
    if (!links.has(orgId))
      links.set(
        orgId,
        linkOf(orgId).catch(() => null),
      );
    return links.get(orgId) as Promise<ImsLink | null>;
  };
  const run = (batch: ExternalStockPosting[]) =>
    settleAll(batch, async (row) => {
      const link = await linkFor(row.orgId);
      if (link) await send(row, link, AbortSignal.any([budget, AbortSignal.timeout(CALL_MS)]));
      else await failed(row, linkBroken());
    });
  await run(rows.filter((row) => row.kind !== "RETURN"));
  await run(rows.filter((row) => row.kind === "RETURN"));
  return { sent: rows.length };
}

/** One call; the row ends DONE, FAILED (a refusal a person must look at) or PENDING with backoff. */
async function send(row: ExternalStockPosting, link: ImsLink, signal: AbortSignal): Promise<void> {
  try {
    const outcome = await call(row, link, signal);
    if (outcome === "WAIT") return;
    await getDb().externalStockPosting.update({
      where: { id: row.id },
      data: { ...outcome, status: "DONE", lastErrorCode: null },
    });
  } catch (err) {
    await failed(row, err);
  }
}

async function failed(row: ExternalStockPosting, err: unknown): Promise<void> {
  const details = detailsOf(err);
  const permanent = details?.reason === "INVENTORY_REJECTED" || (err instanceof AppError && err.code === "NOT_FOUND");
  const attempts = row.attempts + 1;
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  await getDb().externalStockPosting.update({
    where: { id: row.id },
    data: {
      attempts,
      lastErrorCode: (details?.imsCode ?? details?.reason ?? "UNEXPECTED").slice(0, 40),
      ...(permanent ? { status: "FAILED" } : { nextAttemptAt: new Date(Date.now() + minutes * 60_000) }),
    },
  });
}

type Outcome = Prisma.ExternalStockPostingUpdateInput | "WAIT";

async function call(row: ExternalStockPosting, link: ImsLink, signal: AbortSignal): Promise<Outcome> {
  const db = getDb();
  if (row.kind === "CANCEL") {
    try {
      await imsPost(
        link,
        `/api/sales-orders/${row.externalOrderRefId}/cancel`,
        { reason: "pos_sale_failed" },
        row.idempotencyKey,
        signal,
      );
    } catch (err) {
      if (detailsOf(err)?.imsCode !== "invalid_transition") throw err; // nothing left open: done
    }
    return {};
  }

  if (row.kind === "FULFIL") {
    const sale = await db.sale.findFirst({ where: { id: row.sourceId, orgId: row.orgId }, select: { status: true } });
    if (sale?.status !== "VOIDED") {
      await imsPost(
        link,
        `/api/reservations/${row.reservationId}/fulfil`,
        { version: row.reservationVersion },
        row.idempotencyKey,
        signal,
      );
      return {};
    }
    // Voided before its fulfil went out: cancel the hold instead (I15).
    try {
      await imsPost(
        link,
        `/api/reservations/${row.reservationId}/cancel`,
        { version: row.reservationVersion, reason: "pos_void" },
        `pos:sale:${row.sourceId}:void:${row.lineNo}`,
        signal,
      );
      return { kind: "CANCEL" };
    } catch (err) {
      const details = detailsOf(err);
      // Fulfilled after all (an earlier call landed): the void's return takes it back.
      if (details?.imsCode === "invalid_transition" && details.imsDetails?.status === "fulfilled") return {};
      if (details?.imsCode === "invalid_transition" || details?.imsCode === "reservation_expired") {
        return { kind: "CANCEL" }; // nothing held any more
      }
      throw err;
    }
  }

  // RETURN: of a refund's lines, or of a voided sale's fulfilled lines. Needs the sale's fulfils settled.
  const refund =
    row.sourceType === "Refund"
      ? await db.refund.findFirstOrThrow({
          where: { id: row.sourceId, orgId: row.orgId },
          select: { saleId: true, items: { select: { saleItemId: true, qty: true } } },
        })
      : null;
  const saleId = refund?.saleId ?? row.sourceId;
  const saleRows = await db.externalStockPosting.findMany({
    where: { orgId: row.orgId, sourceType: "Sale", sourceId: saleId, kind: { not: "RETURN" } },
  });
  if (saleRows.some((saleRow) => saleRow.status === "PENDING")) return "WAIT";
  const taken = saleRows.filter((saleRow) => saleRow.kind === "FULFIL" && saleRow.status === "DONE");
  // ponytail: a refunded line whose fulfil FAILED has nothing in the IMS to return; it is skipped.
  const lines = refund
    ? refund.items.flatMap((item) => {
        const fulfil = taken.find((saleRow) => saleRow.saleItemId === item.saleItemId);
        return fulfil ? [{ reservationId: fulfil.reservationId, qty: item.qty }] : [];
      })
    : taken.map((saleRow) => ({ reservationId: saleRow.reservationId, qty: saleRow.qty }));
  if (lines.length === 0) return {};
  const sale = await db.sale.findFirstOrThrow({ where: { id: saleId, orgId: row.orgId }, select: { number: true } });
  const created = await imsPost<{ id: string }>(
    link,
    "/api/sales-returns",
    refund
      ? { reasonCode: "pos_refund", note: `POS refund of sale ${sale.number}`, lines }
      : { reasonCode: "pos_void", note: `POS void of sale ${sale.number}`, lines },
    row.idempotencyKey,
    signal,
  );
  return { externalReturnId: created.id };
}

/**
 * I16 as changed for the till: the IMS's available quantity of each item at the branch's warehouse,
 * in input order; null where it is unknown (not linked, branch unmapped, or the IMS did not answer).
 * Read-only and never throws: the reservation at Pay is the real stock check.
 */
export async function availableAtBranch(
  orgId: string,
  branchId: string,
  refs: readonly Ref[],
): Promise<(number | null)[]> {
  const none = refs.map(() => null);
  if (refs.length === 0) return [];
  try {
    const warehouseId = await warehouseOf(orgId, branchId);
    if (!warehouseId) return none;
    const [variantIds, link] = await Promise.all([externalVariantIdsOf(getDb(), orgId, refs), linkOf(orgId)]);
    const results = await settleAll(variantIds, (variantId) =>
      variantId
        ? imsGet<{ available: string }>(
            link,
            `/api/availability?variantId=${encodeURIComponent(variantId)}&warehouseId=${encodeURIComponent(warehouseId)}`,
            3_000,
          )
        : Promise.reject(new Error("not linked")),
    );
    return results.map((result) =>
      result.status === "fulfilled" ? Math.max(Math.floor(Number(result.value.available)), 0) || 0 : null,
    );
  } catch {
    return none;
  }
}
