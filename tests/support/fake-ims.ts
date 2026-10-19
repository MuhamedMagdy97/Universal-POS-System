import { createServer, type Server } from "node:http";

/**
 * A tiny stand-in for the inventory system's sales-channel API (D:/inventory sys, commit d412a6b),
 * answering only what slice 1 reads: `GET /api/products` (paged), `GET /api/products/{id}` and
 * `GET /api/availability`, with the IMS's real answer shapes and error envelope.
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
  variants: FakeVariant[];
};

export type FakeIms = {
  apiKey: string;
  products: FakeProduct[];
  /** Every request answers 503 (or, with "network", the fetch rejects). */
  down?: false | "503" | "network";
  /** The key may read products but not stock (availability answers 403). */
  noStockPermission?: boolean;
  /** Paths requested, for assertions. */
  calls: string[];
  /** `x-api-key` values seen, for assertions. */
  keysSeen: string[];
};

export function fakeIms(apiKey: string, products: FakeProduct[] = []): FakeIms {
  return { apiKey, products, calls: [], keysSeen: [] };
}

const err = (status: number, code: string, message: string) => ({
  status,
  body: { code, message, details: null, trace_id: "fake" },
});

export function answer(ims: FakeIms, url: URL, apiKey: string | null): { status: number; body: unknown } {
  ims.calls.push(url.pathname + url.search);
  if (apiKey) ims.keysSeen.push(apiKey);
  if (ims.down === "503") return err(503, "unavailable", "down");
  if (apiKey !== ims.apiKey) return err(403, "forbidden", "Invalid API key");

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
  if (url.pathname === "/api/availability") {
    if (ims.noStockPermission) return err(403, "forbidden", "Missing permission");
    return err(404, "not_found", "Variant not found");
  }
  return err(404, "not_found", "No such route");
}

/** A `fetch` that answers from `ims` (vitest: `vi.stubGlobal("fetch", fakeFetch(ims))`). */
export function fakeFetch(ims: FakeIms): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (ims.down === "network") throw new TypeError("fetch failed");
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = new Headers(init?.headers).get("x-api-key");
    const { status, body } = answer(ims, url, key);
    return Response.json(body, { status });
  }) as typeof fetch;
}

export function startFakeIms(ims: FakeIms, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const { status, body } = answer(
      ims,
      new URL(req.url ?? "/", `http://localhost:${port}`),
      (req.headers["x-api-key"] as string | null) ?? null,
    );
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
