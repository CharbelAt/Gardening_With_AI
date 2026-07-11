// Minimal service worker: caches the app shell so the PWA is installable and
// works offline. Uses network-first for local files (not cache-first) since
// this app is actively being updated — you always want the latest app.jsx
// over a stale cached copy. The cache is only a fallback for when there's no
// network at all. AI calls and CDN scripts always go straight to the network.
const CACHE = "garden-companion-v6";
const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./idb.js",
  "./styles.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./modules/helpers.jsx",
  "./modules/shared-ui.jsx",
  "./modules/chat.jsx",
  "./modules/call.jsx",
  "./modules/inventory.jsx",
  "./modules/routines.jsx",
  "./modules/garden.jsx",
  "./modules/codex.jsx",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellFile = url.origin === self.location.origin;

  if (!isShellFile || event.request.method !== "GET") {
    return; // let CDN + API requests go straight to the network
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
