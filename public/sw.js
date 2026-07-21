// Minimal, safe service worker: NETWORK-FIRST for everything, so a new
// deploy is always picked up on the next load; the cache is only a fallback
// when the device is offline. The data API (/api/) is never cached.
const CACHE = "first-rehab-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((m) => m || caches.match("/"))
      )
  );
});
