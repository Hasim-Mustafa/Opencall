/**
 * OpenCall service worker.
 *
 * Deliberately minimal. A calling app must never run on stale code — if a
 * cached old version talks to a newer server, connections fail in ways
 * that are painful to debug. So everything is network-first, and the cache
 * exists only so the app still opens when you're offline (where it will
 * tell you it can't reach the server, rather than showing a browser error
 * page).
 *
 * Bump CACHE_VERSION whenever you change index.html.
 */

const CACHE_VERSION = "gmst-v9";

const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GETs. WebSocket upgrades and the Google Fonts
  // requests are left entirely alone.
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Keep a fresh copy of successful responses for offline opening.
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Room links like /KLM-2F9 are navigations — fall back to the shell.
        if (req.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return new Response("Offline", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
  );
});
