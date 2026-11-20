// Service worker: intercepts requests from proxied pages and routes them
// through Scramjet or Ultraviolet. All rewriting happens here, in the
// browser, not on the Raspberry Pi.
importScripts("{{config.js}}", "{{scramjet.all.js}}", "{{uv.bundle.js}}", "{{uv.config.js}}", "{{uv.sw.js}}");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const uv = new UVServiceWorker();

// ---------------------------------------------------------------------------
// Response cache
//
// Proxied traffic goes through the Wisp transport, so it never touches the
// browser's normal HTTP cache. Without this, every image, script, stylesheet
// and font is downloaded through the Pi -- and re-rewritten -- on every visit.
// Here we keep the *already rewritten* responses, honouring each site's own
// Cache-Control / Expires headers (like a normal browser cache would).
// ---------------------------------------------------------------------------
const CACHE_NAME = "wp-cache-{{BUILD_ID}}";
const CACHEABLE = new Set(["script", "style", "image", "font"]);
const MAX_ENTRIES = 3000;
const MAX_TTL = 7 * 24 * 3600 * 1000; // never trust a cached entry for more than a week
const MAX_BODY = 8 * 1024 * 1024; // don't cache single responses larger than 8 MB
let cachePromise = null;
let puts = 0;

const openCache = () => (cachePromise ||= caches.open(CACHE_NAME));

function freshnessMs(headers) {
  const cc = (headers.get("cache-control") || "").toLowerCase();
  if (/no-store|no-cache|private="?set-cookie/.test(cc)) return 0;
  const m = cc.match(/(?:^|[,\s])max-age=(\d+)/);
  if (m) return Math.min(+m[1] * 1000, MAX_TTL);
  if (/immutable/.test(cc)) return MAX_TTL;
  const expires = Date.parse(headers.get("expires") || "");
  if (!isNaN(expires)) {
    const date = Date.parse(headers.get("date") || "") || Date.now();
    return Math.max(0, Math.min(expires - date, MAX_TTL));
  }
  return 0;
}

function cacheable(response) {
  if (response.status !== 200 || response.type === "opaque") return 0;
  const vary = (response.headers.get("vary") || "").toLowerCase();
  if (vary && !/^\s*(accept-encoding|origin)(\s*,\s*(accept-encoding|origin))*\s*$/.test(vary)) return 0;
  const len = +(response.headers.get("content-length") || 0);
  if (len > MAX_BODY) return 0;
  return freshnessMs(response.headers);
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_ENTRIES;
  if (excess > 0) {
    // Cache Storage keeps insertion order, so the oldest entries come first.
    await Promise.all(keys.slice(0, excess + Math.floor(MAX_ENTRIES / 10)).map((k) => cache.delete(k)));
  }
}

async function withCache(event, handler) {
  const req = event.request;
  if (req.method !== "GET" || !CACHEABLE.has(req.destination) || req.headers.has("range")) return handler();

  // The rewritten output depends on the request URL (which encodes the real URL
  // and flags like ?type=module) and on the destination.
  const key = req.url + (req.url.includes("?") ? "&" : "?") + "__wpd=" + req.destination;
  let cache;
  try {
    cache = await openCache();
    const hit = await cache.match(key);
    if (hit && +hit.headers.get("x-wp-expires") > Date.now()) return hit;
  } catch {
    /* cache unavailable (e.g. private mode quota) -> just go to the network */
  }

  const response = await handler();
  const ttl = cache ? cacheable(response) : 0;
  if (ttl > 0) {
    const headers = new Headers(response.headers);
    headers.set("x-wp-expires", String(Date.now() + ttl));
    headers.delete("vary");
    const copy = response.clone();
    event.waitUntil(
      copy
        .arrayBuffer()
        .then((body) => {
          if (body.byteLength > MAX_BODY) return;
          return cache.put(key, new Response(body, { status: copy.status, statusText: copy.statusText, headers }));
        })
        .then(() => (++puts % 100 === 0 ? trimCache(cache) : undefined))
        .catch(() => {})
    );
  }
  return response;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous builds (rewriter or codec may have changed).
      for (const name of await caches.keys()) {
        if (name.startsWith("wp-cache-") && name !== CACHE_NAME) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

async function handleRequest(event) {
  if (uv.route(event)) return withCache(event, () => uv.fetch(event));
  await scramjet.loadConfig(); // no-op once loaded
  if (scramjet.route(event)) return withCache(event, () => scramjet.fetch(event));
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
