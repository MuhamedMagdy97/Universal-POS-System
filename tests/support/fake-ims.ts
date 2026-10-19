import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A tiny stand-in for the inventory system's sales-channel API (D:/inventory sys, commit d412a6b),
 * with the IMS's real answer shapes and error envelope: catalog reads (`GET /api/categories`,
 * `/api/products`, `/api/products/{id}`), `GET /api/warehouses`, `GET /api/availability`, and the selling routes
 * `POST /api/reservations`, `/api/reservations/{id}/fulfil|cancel`, `/api/sales-orders/{id}/cancel`
 * and `/api/sales-returns`. Writes follow the IMS's idempotency rule (`execute`): a key seen with the
 * same body replays the stored success; another body answers `409 conflict`; failures store nothing.
 * Vitest uses `fakeFetch`; Playwright starts `startFakeIms` on a port.
 */

export type FakeVariant = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string | null;
  status: string;
  sellPrice: string | null;
  costPrice: string | null;
  barcodeAliases?: { barcode: string }[];
};

export type FakeProduct = {
  id: string;
  name: string;
  type: "simple" | "variant_parent";
  status: string;
  isSerialized: boolean;
  baseUom: string;
  categoryId?: string | null;
  variants: FakeVariant[];
};

/** List in parent-before-child order, as the IMS returns it (by path). */
export type FakeCategory = { id: string; parentId: string | null; name: string; sort: number; archived: boolean };

export type FakeWarehouse = { id: string; code: string; name: string; status: string };

export type FakeReservation = {
  id: string;
  variantId: string;
  warehouseId: string;
  qty: number;
  status: "active" | "fulfilled" | "cancelled";
  version: number;
  salesOrderRefId: string | null;
};

type Answer = { status: number; body: unknown };

export type FakeIms = {
  apiKey: string;
  products: FakeProduct[];
  categories: FakeCategory[];
  warehouses: FakeWarehouse[];
  /** On hand per `${variantId}|${warehouseId}`; missing = 0. */
  stock: Map<string, number>;
  reservations: Map<string, FakeReservation>;
  /** externalOrderId → sales_order_ref id. */
  orders: Map<string, string>;
  returns: { id: string; reasonCode: string; note: string | null; lines: { reservationId: string; qty: number }[] }[];
  /** Every request answers 503 (or, with "network", the fetch rejects). */
  down?: false | "503" | "network";
  /** Answer this instead, for matching requests (`"POST /api/reservations"`): an outage on one call. */
  intercept?: (method: string, path: string, body: unknown) => Answer | "network" | undefined;
  /** The key may read products but not stock (availability answers 403). */
  noStockPermission?: boolean;
  /** Requests made (`/path?query` for reads, `POST /path` for writes), for assertions. */
  calls: string[];
  /** `x-api-key` values seen, for assertions. */
  keysSeen: string[];
  /** Idempotency records: key → request hash and stored answer. */
  idempotency: Map<string, { hash: string; answer: Answer }>;
};

export function fakeIms(apiKey: string, products: FakeProduct[] = []): FakeIms {
  return {
    apiKey,
    products,
    categories: [],
    warehouses: [],
    stock: new Map(),
    reservations: new Map(),
    orders: new Map(),
    returns: [],
    calls: [],
    keysSeen: [],
    idempotency: new Map(),
  };
}

const err = (status: number, code: string, message: string, details: unknown = null): Answer => ({
  status,
  body: { code, message, details, trace_id: "fake" },
});

const stockKey = (variantId: string, warehouseId: string) => `${variantId}|${warehouseId}`;

function reservedOf(ims: FakeIms, variantId: string, warehouseId: string): number {
  let held = 0;
  for (const r of ims.reservations.values()) {
    if (r.status === "active" && r.variantId === variantId && r.warehouseId === warehouseId) held += r.qty;
  }
  return held;
}

export function availableOf(ims: FakeIms, variantId: string, warehouseId: string): number {
  return (ims.stock.get(stockKey(variantId, warehouseId)) ?? 0) - reservedOf(ims, variantId, warehouseId);
}

function findVariant(ims: FakeIms, variantId: string) {
  for (const product of ims.products) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

function read(ims: FakeIms, url: URL): Answer {
  if (url.pathname === "/api/categories") {
    const all = url.searchParams.get("includeArchived") === "true";
    const byId = new Map(ims.categories.map((c) => [c.id, c]));
    const pathOf = (c: FakeCategory): string => {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return `${parent ? pathOf(parent) : "/"}${c.name}/`;
    };
    const items = ims.categories
      .filter((c) => all || !c.archived)
      .map((c) => ({ ...c, companyId: "fake", path: pathOf(c), depth: pathOf(c).split("/").length - 2, version: 0 }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { status: 200, body: { items } };
  }
  if (url.pathname === "/api/products") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const perPage = Number(url.searchParams.get("per_page") ?? 50);
    const live = ims.products.filter((p) => p.status !== "archived");
    const items = live.slice((page - 1) * perPage, page * perPage).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      variants: p.variants.map(({ id, sku, name, status, barcode }) => ({ id, sku, name, status, barcode })),
    }));
    return { status: 200, body: { total: live.length, page, perPage, items } };
  }
  const one = /^\/api\/products\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const product = ims.products.find((p) => p.id === decodeURIComponent(one[1]));
    return product ? { status: 200, body: product } : err(404, "not_found", "Product not found");
  }
  if (url.pathname === "/api/warehouses") return { status: 200, body: { items: ims.warehouses } };
  if (url.pathname === "/api/availability") {
    if (ims.noStockPermission) return err(403, "forbidden", "Missing permission");
    const variantId = url.searchParams.get("variantId") ?? "";
    const found = findVariant(ims, variantId);
    if (!found) return err(404, "not_found", "Variant not found");
    const warehouseId = url.searchParams.get("warehouseId") ?? "";
    const onHand = ims.stock.get(stockKey(variantId, warehouseId)) ?? 0;
    const reserved = reservedOf(ims, variantId, warehouseId);
    return {
      status: 200,
      body: {
        variantId,
        sku: found.variant.sku,
        warehouseId,
        onHand: String(onHand),
        reserved: String(reserved),
        available: String(onHand - reserved),
        blocked: "0",
        damaged: "0",
        expired: "0",
        positions: [],
      },
    };
  }
  return err(404, "not_found", "No such route");
}

type Body = Record<string, unknown>;

function write(ims: FakeIms, path: string, body: Body): Answer {
  if (path === "/api/reservations") {
    const variantId = String(body.variantId);
    const warehouseId = String(body.warehouseId);
    const qty = Number(body.qty);
    const found = findVariant(ims, variantId);
    const warehouse = ims.warehouses.find((w) => w.id === warehouseId);
    if (!found || !warehouse) return err(404, "not_found", "Variant or warehouse not found");
    if (warehouse.status !== "active") return err(409, "archived_conflict", "Warehouse is not active");
    if (found.variant.status !== "active" || found.product.status !== "active") {
      return err(409, "archived_conflict", "Variant is not active");
    }
    const available = availableOf(ims, variantId, warehouseId);
    if (available < qty) {
      return err(409, "insufficient_stock", "Not enough available stock", {
        available: String(available),
        requested: String(qty),
      });
    }
    let salesOrderRefId: string | null = null;
    if (typeof body.externalOrderId === "string") {
      salesOrderRefId = ims.orders.get(body.externalOrderId) ?? randomUUID();
      ims.orders.set(body.externalOrderId, salesOrderRefId);
    }
    const reservation: FakeReservation = {
      id: randomUUID(),
      variantId,
      warehouseId,
      qty,
      status: "active",
      version: 0,
      salesOrderRefId,
    };
    ims.reservations.set(reservation.id, reservation);
    return { status: 200, body: { reservation: { ...reservation, qty: qty.toFixed(4) }, requested: String(qty) } };
  }

  const action = /^\/api\/reservations\/([^/]+)\/(fulfil|cancel)$/.exec(path);
  if (action) {
    const reservation = ims.reservations.get(action[1]);
    if (!reservation) return err(404, "not_found", "Reservation not found");
    if (reservation.status !== "active") {
      return err(422, "invalid_transition", `Reservation is ${reservation.status}`, {
        id: reservation.id,
        status: reservation.status,
      });
    }
    if (body.version !== reservation.version) {
      return err(409, "version_conflict", "Reservation was changed by someone else", { version: reservation.version });
    }
    if (action[2] === "fulfil") {
      const key = stockKey(reservation.variantId, reservation.warehouseId);
      ims.stock.set(key, (ims.stock.get(key) ?? 0) - reservation.qty);
      reservation.status = "fulfilled";
    } else {
      reservation.status = "cancelled";
    }
    reservation.version += 1;
    return { status: 200, body: { reservation } };
  }

  const cancelOrder = /^\/api\/sales-orders\/([^/]+)\/cancel$/.exec(path);
  if (cancelOrder) {
    const open = [...ims.reservations.values()].filter(
      (r) => r.salesOrderRefId === cancelOrder[1] && r.status === "active",
    );
    if (![...ims.orders.values()].includes(cancelOrder[1])) return err(404, "not_found", "Order not found");
    if (open.length === 0) return err(422, "invalid_transition", "Order has no open reservations");
    for (const r of open) {
      r.status = "cancelled";
      r.version += 1;
    }
    return { status: 200, body: { order: { id: cancelOrder[1] }, reservations: open } };
  }

  if (path === "/api/sales-returns") {
    const lines = (body.lines as { reservationId: string; qty: number }[]) ?? [];
    for (const line of lines) {
      if (ims.reservations.get(line.reservationId)?.status !== "fulfilled") {
        return err(422, "validation_error", "Unknown order line", { field: "reservationId" });
      }
    }
    const created = {
      id: randomUUID(),
      reasonCode: String(body.reasonCode),
      note: (body.note as string | null) ?? null,
      lines,
    };
    ims.returns.push(created);
    return { status: 200, body: { ...created, number: `SR-${ims.returns.length}`, status: "requested" } };
  }
  return err(404, "not_found", "No such route");
}

export function answer(
  ims: FakeIms,
  method: string,
  url: URL,
  apiKey: string | null,
  idempotencyKey: string | null = null,
  rawBody = "",
): Answer | "network" {
  ims.calls.push(method === "GET" ? url.pathname + url.search : `${method} ${url.pathname}`);
  if (apiKey) ims.keysSeen.push(apiKey);
  if (ims.down === "network") return "network";
  if (ims.down === "503") return err(503, "unavailable", "down");
  if (apiKey !== ims.apiKey) return err(403, "forbidden", "Invalid API key");
  if (method === "GET") return read(ims, url);

  let body: Body;
  try {
    body = JSON.parse(rawBody || "null") as Body;
  } catch {
    return err(422, "validation_error", "Invalid JSON");
  }
  const intercepted = ims.intercept?.(method, url.pathname, body);
  if (intercepted) return intercepted;
  if (!idempotencyKey) return err(422, "validation_error", "Idempotency-Key header is required (max 200 chars)");
  if (idempotencyKey.length > 200) return err(422, "validation_error", "Idempotency-Key header is required");
  const hash = `${url.pathname}\n${rawBody}`;
  const seen = ims.idempotency.get(idempotencyKey);
  if (seen) {
    return seen.hash === hash
      ? seen.answer
      : err(409, "conflict", "Idempotency-Key was already used for a different request");
  }
  const result = write(ims, url.pathname, body);
  if (result.status === 200) ims.idempotency.set(idempotencyKey, { hash, answer: result });
  return result;
}

/** A `fetch` that answers from `ims` (vitest: `vi.stubGlobal("fetch", fakeFetch(ims))`). */
export function fakeFetch(ims: FakeIms): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const result = answer(
      ims,
      init?.method ?? "GET",
      url,
      headers.get("x-api-key"),
      headers.get("idempotency-key"),
      typeof init?.body === "string" ? init.body : "",
    );
    if (result === "network") throw new TypeError("fetch failed");
    return Response.json(result.body, { status: result.status });
  }) as typeof fetch;
}

export function startFakeIms(ims: FakeIms, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const result = answer(
        ims,
        req.method ?? "GET",
        new URL(req.url ?? "/", `http://localhost:${port}`),
        (req.headers["x-api-key"] as string | undefined) ?? null,
        (req.headers["idempotency-key"] as string | undefined) ?? null,
        raw,
      );
      if (result === "network") {
        req.socket.destroy();
        return;
      }
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
