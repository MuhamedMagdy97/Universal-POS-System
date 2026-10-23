/**
 * Offline till service worker (offline-till-spec OF10, slice 3). Scope /pos only. It keeps the till's page and the
 * build's static files so a reload or restart offline still opens the till; sales and the snapshot live in the
 * page's IndexedDB, never here. Navigations are network-first (a deploy shows at once); /_next/static is
 * cache-first (file names carry their content hash). The page posts what it loaded, since its first load happens
 * before this worker controls it.
 */
const CACHE = "pos-till-v1";
/** The last till page seen, for a reload with another query string. */
const PAGE_KEY = "/pos?__last";
const ANY = { ignoreVary: true };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** A full till page: 200, not a redirect to sign-in. */
const keepable = (response) => response.ok && !response.redirected && response.type === "basic";

async function navigate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (keepable(response)) {
      // Stored after the page is handed over, so it still streams.
      const copy = response.clone();
      event.waitUntil(cache.put(request.url, copy.clone()).then(() => cache.put(PAGE_KEY, copy)));
    }
    return response;
  } catch (err) {
    // Offline: this exact till, else the last till page this browser opened.
    const cached = (await cache.match(request.url, ANY)) ?? (await cache.match(PAGE_KEY, ANY));
    if (cached) return cached;
    throw err;
  }
}

async function staticFile(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && url.pathname === "/pos") event.respondWith(navigate(event));
  else if (url.pathname.startsWith("/_next/static/")) event.respondWith(staticFile(request));
});

/**
 * `{ type: "precache", page, files }` from the till: store the page (under its URL and as the last till) and exactly
 * these static files, dropping files of older builds.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "precache") return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const wanted = new Set(data.files.map((file) => new URL(file, self.location.origin).href));
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith("/_next/static/") && !wanted.has(request.url)) {
          await cache.delete(request);
        }
      }
      await Promise.all(
        [...wanted].map(async (file) => {
          if (await cache.match(file)) return;
          const response = await fetch(file);
          if (response.ok) await cache.put(file, response);
        }),
      );
      const page = await fetch(data.page, { credentials: "same-origin" });
      if (keepable(page)) {
        await cache.put(PAGE_KEY, page.clone());
        await cache.put(data.page, page);
      }
    })(),
  );
});
