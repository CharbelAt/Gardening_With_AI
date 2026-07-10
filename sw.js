// Minimal service worker: caches the app shell so the PWA is installable and
// opens instantly. AI calls and CDN scripts always go to the network (a cached
// AI reply would be useless), only local static files get cache-first.
const CACHE = "garden-companion-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./idb.js",
  "./styles.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
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
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
    )
  );
});
