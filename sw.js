// Minimal service worker: caches the app shell so the PWA is installable and
// works offline. Uses network-first for local files (not cache-first) since
// this app is actively being updated — you always want the latest app.jsx
// over a stale cached copy. The cache is only a fallback for when there's no
// network at all. AI calls and CDN scripts always go straight to the network.
const CACHE = "garden-companion-v24"; // v24: time input on to-dos (v23: timed reminders + test-notification fix)
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
  "./modules/guide.jsx",
  "./modules/weather.jsx",
  "./modules/notify.jsx",
  "./modules/chat.jsx",
  "./modules/voice.jsx",
  "./modules/inventory.jsx",
  "./modules/routines.jsx",
  "./modules/todos.jsx",
  "./modules/tasks.jsx",
  "./modules/garden.jsx",
  "./modules/codex.jsx",
  "./modules/search.jsx",
  "./modules/today.jsx",
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

// ---------- Web Push ----------
//
// This is what makes reminders arrive when the app is CLOSED. The server holds
// a delivery schedule uploaded by notify.jsx (rendered title/body only — it has
// no access to the garden data, which never leaves IndexedDB on this device),
// and pushes an already-rendered message at the right moment. So there is
// nothing to compute here: read the payload, show it.
const PUSH_DEFAULTS = {
  title: "Garden Companion",
  body: "Something in your garden needs attention.",
  tag: "garden-due", // same tag the in-tab path uses, so a push and a local
                     // notification about the same morning collapse into one
                     // instead of stacking two identical rows.
  url: "./",
};

// A push payload arrives as opaque bytes: it can be absent entirely (some
// services send a bare "wake up" with no data), or be text that isn't JSON.
// Neither may throw — with userVisibleOnly:true the browser punishes a push
// that shows nothing by displaying its own "this site was updated in the
// background" notice, which is worse than a generic message of our own.
function readPushPayload(event) {
  const out = { ...PUSH_DEFAULTS };
  if (!event.data) return out;
  let parsed = null;
  try {
    parsed = event.data.json();
  } catch (_) {
    try {
      const text = event.data.text();
      if (text) out.body = text;
    } catch (_) {
      /* unreadable payload — fall back to the defaults */
    }
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  if (typeof parsed.title === "string" && parsed.title) out.title = parsed.title;
  if (typeof parsed.body === "string" && parsed.body) out.body = parsed.body;
  if (typeof parsed.tag === "string" && parsed.tag) out.tag = parsed.tag;
  if (typeof parsed.url === "string" && parsed.url) out.url = parsed.url;
  return out;
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: payload.tag,
      renotify: true, // same tag replaces the old row, but still buzzes: a new
                      // day's reminder is genuine new news, not a duplicate.
      data: { url: payload.url },
    })
  );
});

// Tapping a due-reminder notification should open the app, not do nothing.
// Focus an already-open window if there is one (rather than stacking a second
// copy), otherwise open a fresh one. A push may name a specific view via
// data.url; anything absent or malformed falls back to the app root.
function notificationTargetUrl(notification) {
  const raw = (notification && notification.data && notification.data.url) || "./";
  try {
    return new URL(raw, self.location.href).href;
  } catch (_) {
    return new URL("./", self.location.href).href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = notificationTargetUrl(event.notification);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (!("focus" in client)) continue;
        // Steer the window that's already open rather than opening a second
        // copy. navigate() isn't universally implemented (and rejects
        // cross-origin), so focusing is the part that must always happen.
        if (client.url !== target && typeof client.navigate === "function") {
          return client
            .navigate(target)
            .then((c) => (c && c.focus ? c.focus() : c))
            .catch(() => client.focus());
        }
        return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
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
