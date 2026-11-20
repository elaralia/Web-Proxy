// Service worker: intercepts requests from proxied pages and routes them
// through Scramjet or Ultraviolet. All rewriting happens here, in the
// browser, not on the Raspberry Pi.
importScripts("/scram/scramjet.all.js");
importScripts("/uv/uv.bundle.js", "/uv.config.js");
importScripts(__uv$config.sw);

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const uv = new UVServiceWorker();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function handleRequest(event) {
  if (uv.route(event)) return uv.fetch(event);
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
