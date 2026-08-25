// Due-date notifications: nudges the user when a routine or to-do comes due
// without them having to open the app and check. This file owns the whole
// feature — pure logic (checkDueAndNotify/startNotifyTimer) AND its own
// Settings UI section (NotifySettingsSection), rendered from SettingsModal in
// shared-ui.jsx with one guarded line, so that file stays short.
//
// TWO TIERS, and the Settings copy must always say which one is live:
//
//   1. REAL WEB PUSH (enablePush) — arrives with the app CLOSED. Requires a
//      VPS with VAPID keys configured; the browser's push service wakes the
//      service worker, which shows the notification (see sw.js).
//   2. IN-TAB TIMER (startNotifyTimer) — the fallback for when tier 1 isn't
//      available. A Notification shown from an open tab; closing the
//      tab/browser, or the OS suspending a backgrounded tab, silences it.
//      Never claim more for it than "while the app is open".
//
// WHY THIS SIDE COMPUTES THE SCHEDULE: the server has no access to the garden
// data — routines and to-dos live in IndexedDB on the device and never leave
// it. So syncPushReminders() works out what falls due over the next 30 days,
// renders the message text HERE, and uploads only { id, at, title, body }.
// The server is a dumb alarm clock. Keep it that way: never put plant names,
// notes, or anything else from the garden into a payload beyond the rendered
// title/body the user is about to read on their own lock screen.
//
// iOS CAVEAT: Safari only grants PushManager to a PWA that has been installed
// to the Home Screen (Share → Add to Home Screen). In a normal iOS Safari tab
// "PushManager" in window is false and tier 1 is impossible — the UI says so
// rather than offering a toggle that can't work.
//
// Classic script, shares the page's global scope like every other module —
// see the note at the top of idb.js for why (no import/export, no build step).

const NOTIFY_ENABLED_KEY = "gc_notifyEnabled";
const NOTIFY_HOUR_KEY = "gc_notifyHour";
// Internal only (not part of the contract other files rely on): remembers
// the last date+signature a notification actually fired for, so the same due
// list doesn't re-notify every 30 minutes all day.
const NOTIFY_LAST_KEY = "gc_notifyLastFired";
// "The user asked for real push and we have a live subscription." Kept in
// localStorage (not just memory) because the in-tab fallback timer has to know
// synchronously, on the very first tick after load, whether to stand down —
// see isPushActive(). Reconciled against the browser's actual subscription on
// every load, so a flag left true after the subscription died self-corrects.
const PUSH_ENABLED_KEY = "gc_pushEnabled";

function getNotifySettings() {
  const hourRaw = parseInt(localStorage.getItem(NOTIFY_HOUR_KEY), 10);
  return {
    enabled: localStorage.getItem(NOTIFY_ENABLED_KEY) === "true",
    hour: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : 8,
  };
}

function setNotifySettings(next) {
  localStorage.setItem(NOTIFY_ENABLED_KEY, next && next.enabled ? "true" : "false");
  const h = next && Number.isFinite(next.hour) ? Math.min(23, Math.max(0, Math.round(next.hour))) : 8;
  localStorage.setItem(NOTIFY_HOUR_KEY, String(h));
}

function notificationsSupported() {
  return "Notification" in window;
}

async function requestNotifyPermission() {
  if (!notificationsSupported()) return "denied"; // nothing to ask — treat as denied so callers don't show a toggle that can never work
  // Browsers won't re-prompt once the user has already answered (some just
  // resolve immediately with the existing value, but relying on that isn't
  // worth it) — checking first makes the "already decided" case explicit and
  // avoids a pointless prompt call every time the toggle is touched.
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch (_) {
    // Pre-modern browsers took a callback instead of returning a promise.
    return await new Promise((resolve) => Notification.requestPermission(resolve));
  }
}

// Reads what's actually due right now and, if warranted, shows ONE summary
// Notification. Returns { fired, reason } — reason is one of "sent",
// "nothing-due", "deduped", "disabled", "no-permission", "unsupported",
// "error". The return value isn't part of the required contract (callers are
// free to ignore it, as startNotifyTimer does), but it lets the Settings
// "send a test" button report back something more useful than silence.
//
// force (the "Send a test notification" button): bypasses the enabled
// toggle and the same-day dedupe, since the whole point of that button is to
// prove notifications work right now, on demand. It does NOT invent a fake
// notification when nothing is actually due (that would misrepresent what a
// real one looks like), and it can never bypass the browser's own permission
// decision — nothing can.
async function checkDueAndNotify(force) {
  if (!notificationsSupported()) return { fired: false, reason: "unsupported" };
  if (Notification.permission !== "granted") return { fired: false, reason: "no-permission" };

  const { enabled } = getNotifySettings();
  if (!enabled && !force) return { fired: false, reason: "disabled" };

  let items;
  try {
    // getAllRoutines/getAllTodos (idb.js) and isRoutineDue (idb.js) /
    // isTodoUrgent (todos.jsx) already exist in this app today (unlike the
    // backup/weather contract functions), so they're called directly rather
    // than typeof-guarded — every module in this app already relies on that
    // same load-order guarantee.
    const [routines, todos] = await Promise.all([getAllRoutines(), getAllTodos()]);
    items = [
      ...routines.filter(isRoutineDue).map((r) => r.task || "Routine"),
      ...todos.filter(isTodoUrgent).map((t) => t.text || "To-do"),
    ];
  } catch (e) {
    console.error("checkDueAndNotify: couldn't read garden data:", e && e.message);
    return { fired: false, reason: "error" };
  }

  if (items.length === 0) return { fired: false, reason: "nothing-due" };

  const today = todayISO(); // helpers.jsx — device-local calendar day, not UTC
  // Signature, not just the count: a different SET of the same size (one
  // item finished, a different one becomes due) is still genuine new news
  // and must not be swallowed by a same-day/same-count dedupe.
  const signature = items.slice().sort().join("|");
  const dedupeKey = `${today}#${items.length}#${signature}`;
  if (!force && localStorage.getItem(NOTIFY_LAST_KEY) === dedupeKey) {
    return { fired: false, reason: "deduped" };
  }

  const { title, body } = formatDueSummary(items);

  const shownOk = await showDueNotification(title, {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: "garden-due",
    renotify: true,
  });
  if (!shownOk) return { fired: false, reason: "error" };
  localStorage.setItem(NOTIFY_LAST_KEY, dedupeKey);
  return { fired: true, reason: "sent" };
}

// One summary line for a list of due item names. Extracted so the push
// schedule (built days in advance, rendered here because the server can't see
// the garden) and the in-tab check word things identically — a reminder
// shouldn't read differently depending on which tier delivered it.
function formatDueSummary(names) {
  const items = (names || []).filter(Boolean);
  const title = items.length === 1 ? "1 thing needs attention" : `${items.length} things need attention`;
  const shown = items.slice(0, 3);
  const body = shown.join(", ") + (items.length > shown.length ? `, +${items.length - shown.length} more` : "");
  return { title, body };
}

// THE ANDROID BUG THIS EXISTS TO FIX:
// `new Notification(...)` is not merely unreliable on Android Chrome — it
// THROWS "Illegal constructor". Android only permits notifications raised
// through a ServiceWorkerRegistration. This app is a phone-first installed
// PWA, so the constructor path was failing on the exact platform the feature
// was built for, and the failure was swallowed into a generic "error".
// Order matters: service worker FIRST (works on Android and desktop), the
// constructor only as a fallback for a browser with notifications but no
// registered SW (e.g. the page opened from file://).
async function showDueNotification(title, options) {
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return true;
      }
    }
  } catch (e) {
    console.error("showDueNotification: service-worker path failed:", e && e.message);
    // fall through and try the constructor
  }
  try {
    new Notification(title, options);
    return true;
  } catch (e) {
    console.error("showDueNotification: Notification constructor failed:", e && e.message);
    return false;
  }
}

// ---------- Web Push (tier 1: reminders with the app CLOSED) ----------

const PUSH_HORIZON_DAYS = 30; // how far ahead a schedule upload looks
const PUSH_MAX_REMINDERS = 60; // the server caps at 100 — stay comfortably under
const PUSH_MAX_OCCURRENCES_PER_ROUTINE = 4; // a daily routine must not eat the whole schedule
const DAY_MS = 24 * 60 * 60 * 1000;

function pushSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

function isPushEnabled() {
  return localStorage.getItem(PUSH_ENABLED_KEY) === "true";
}

function setPushEnabled(on) {
  localStorage.setItem(PUSH_ENABLED_KEY, on ? "true" : "false");
}

// THE ONE THING THAT STOPS DOUBLE-NOTIFYING. When real push is live the server
// is already delivering the daily summary, so the in-tab timer must stand
// down — otherwise a user with the app open at 8am gets the same "3 things
// need attention" twice. Deliberately synchronous (localStorage + permission,
// no awaits) because startNotifyTimer's tick has to decide immediately.
// Belt and braces: pushes carry tag "garden-due", the same tag
// checkDueAndNotify uses, so even a race collapses into a single row.
function isPushActive() {
  if (!isPushEnabled()) return false;
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  return true;
}

// applicationServerKey wants raw bytes, but VAPID keys travel as base64url.
// Two differences from plain base64 and both matter: -/_ stand in for +/, and
// the trailing = padding is stripped (a real P-256 key is 87 chars, which is
// NOT a multiple of 4, so atob rejects it untouched).
function urlBase64ToUint8Array(base64String) {
  const raw = String(base64String || "").trim();
  const padding = "=".repeat((4 - (raw.length % 4)) % 4);
  const base64 = (raw + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// GET /api/push/key is the one unauthenticated endpoint in the contract, so it
// uses plain fetch rather than apiFetch (which POSTs and attaches the client
// secret). A null key is not an error: it means the VPS has no VAPID keys
// configured, and the honest answer is "push isn't available here", not a
// stack trace.
async function fetchPushPublicKey() {
  const { apiBase } = getSettings(); // helpers.jsx, read-only
  if (!apiBase) return { key: null, reason: "no-api-base" };
  let res;
  try {
    res = await fetch(apiBase + "/api/push/key", { method: "GET" });
  } catch (e) {
    return { key: null, reason: "offline" }; // DNS/TLS/no network — never throws out of here
  }
  // The contract promises HTTP 200 always; a non-200 means something else is
  // answering (proxy, old build), which is a server problem, not a null key.
  if (!res.ok) return { key: null, reason: "server-error" };
  const data = await res.json().catch(() => null);
  if (!data || !data.publicKey) return { key: null, reason: "not-configured" };
  return { key: String(data.publicKey), reason: null };
}

async function getPushSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return null;
    return await reg.pushManager.getSubscription();
  } catch (e) {
    console.error("getPushSubscription:", e && e.message);
    return null;
  }
}

// Turns on real push end to end: permission → server key → browser
// subscription → upload the schedule. Returns { ok, reason } like the rest of
// this file; every failure path has its own reason so Settings can say what
// actually went wrong instead of "something failed".
// Reasons: "enabled", "enabled-not-synced", "unsupported", "no-push-manager",
// "no-permission", "no-api-base", "offline", "server-error", "not-configured",
// "error".
async function enablePush() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { ok: false, reason: "unsupported" };
  }
  if (typeof window === "undefined" || !("PushManager" in window)) {
    // iOS Safari in a normal tab lands here — the fix is installing the PWA,
    // which the Settings copy explains.
    return { ok: false, reason: "no-push-manager" };
  }

  const permission = await requestNotifyPermission();
  if (permission !== "granted") return { ok: false, reason: "no-permission" };

  const { key, reason } = await fetchPushPublicKey();
  if (!key) return { ok: false, reason: reason || "not-configured" };

  let subscription;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return { ok: false, reason: "unsupported" };
    const appServerKey = urlBase64ToUint8Array(key);

    subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      // A subscription made against a DIFFERENT applicationServerKey (the VPS
      // rotated its VAPID pair, or this browser subscribed to another deploy)
      // makes subscribe() reject with InvalidStateError. Drop the stale one
      // rather than leaving push permanently broken for this device.
      if (!subscriptionMatchesKey(subscription, appServerKey)) {
        try {
          await subscription.unsubscribe();
        } catch (_) {
          /* best effort — subscribe() below is the real test */
        }
        subscription = null;
      }
    }
    if (!subscription) {
      // userVisibleOnly is mandatory in Chrome: it's the promise that every
      // push shows the user something, which sw.js's push handler keeps.
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
    }
  } catch (e) {
    console.error("enablePush: subscribe failed:", e && e.message);
    return { ok: false, reason: "error", detail: e && e.message };
  }

  setPushEnabled(true);
  const synced = await syncPushReminders();
  // Subscribed but the schedule didn't upload (offline, no API URL, wrong
  // secret): push IS on, it just has nothing to deliver yet. Saying "failed"
  // would be wrong and saying "done" would be a lie, hence a third reason.
  if (!synced.ok) return { ok: true, reason: "enabled-not-synced", detail: synced.reason };
  return { ok: true, reason: "enabled", count: synced.count };
}

// options.applicationServerKey is an ArrayBuffer of the key we subscribed
// with. Not every browser exposes PushSubscription.options; when it's missing
// we assume a match rather than destroying a perfectly good subscription over
// a check we can't make (enablePush's catch covers the rare mismatch).
function subscriptionMatchesKey(subscription, keyBytes) {
  const existing = subscription && subscription.options && subscription.options.applicationServerKey;
  if (!existing) return true;
  const current = new Uint8Array(existing);
  if (current.length !== keyBytes.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== keyBytes[i]) return false;
  }
  return true;
}

// Turns push off. The local flag flips FIRST so the in-tab fallback resumes
// even if the network calls below fail — the user asked for fewer surprises,
// not for silence. Telling the server is best-effort: an unsubscribed endpoint
// is rejected by the push service anyway, so a missed call costs nothing but a
// dead row on the VPS.
async function disablePush() {
  setPushEnabled(false);
  try {
    const subscription = await getPushSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint; // read before unsubscribing
      try {
        await subscription.unsubscribe();
      } catch (e) {
        console.error("disablePush: unsubscribe failed:", e && e.message);
      }
      try {
        if (getSettings().apiBase) await apiFetch("/api/push/unsubscribe", { endpoint });
      } catch (e) {
        console.error("disablePush: server unsubscribe failed:", e && e.message);
      }
    }
  } catch (e) {
    console.error("disablePush:", e && e.message);
  }
  return { ok: true, reason: "disabled" };
}

// ---------- schedule building (pure, so it can be unit tested) ----------

// A "YYYY-MM-DD" plus an hour, as epoch ms in the DEVICE's timezone.
// Built with the Date(y, m, d, h) constructor on purpose: parsing
// "2026-08-22T00:00:00" and then adding hour*3600000 silently lands an hour
// out on the two days a year the clocks change, because a local calendar day
// isn't always 24h long. The constructor asks the platform for the real local
// offset on THAT day.
function localEpochForDate(dateStr, hour) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0, 0).getTime();
  return Number.isFinite(at) ? at : null;
}

// The reminder slot for an instant: the configured hour on that instant's
// local calendar day. Same DST reasoning as above.
function slotForInstant(instantMs, hour) {
  const d = new Date(instantMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).getTime();
}

// The next reminder slot at or after `now` — today's hour if it hasn't passed,
// otherwise tomorrow's. Where everything already overdue gets collected: a
// push scheduled in the past would just be dropped.
function nextSlotFromNow(hour, now) {
  const d = new Date(now);
  let slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0).getTime();
  if (slot <= now) {
    // Date(y, m, d + 1) rolls month/year over correctly, including DST.
    slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, 0, 0, 0).getTime();
  }
  return slot;
}

// Every moment a routine comes due between now and the horizon. Future
// occurrences matter: the whole point is that the schedule keeps working while
// the app stays closed for a fortnight, so one upload has to cover the repeats
// too. A never-done routine is due immediately (matching isRoutineDue), then
// repeats on its interval from now.
function routineOccurrences(routine, now, horizon) {
  const interval = Number(routine && routine.intervalDays);
  const out = [];
  if (!Number.isFinite(interval) || interval <= 0) {
    // No usable interval: it's either due (never done) or unschedulable.
    if (!routine || !routine.lastDone) out.push(now);
    return out;
  }
  const intervalMs = interval * DAY_MS;
  const base = routine.lastDone ? Number(routine.lastDone) : now;
  if (!Number.isFinite(base)) return out;
  if (!routine.lastDone) out.push(now); // due right now
  for (let k = 1; k <= 400 && out.length < PUSH_MAX_OCCURRENCES_PER_ROUTINE; k++) {
    const at = base + k * intervalMs;
    if (at > horizon) break;
    out.push(at);
  }
  return out;
}

// Builds the upload: the next N reminder moments, each already rendered.
// Pure — takes routines/todos/now/hour, touches no globals, returns
// [{ id, at, title, body }] sorted soonest first. NOTHING from the garden goes
// in beyond the item names the user is about to read on their lock screen.
function buildPushReminders(routines, todos, options) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const hour = Number.isFinite(opts.hour) ? opts.hour : getNotifySettings().hour;
  const horizon = now + (opts.horizonDays || PUSH_HORIZON_DAYS) * DAY_MS;
  const soonest = nextSlotFromNow(hour, now);

  // slot epoch -> ordered, de-duplicated item names
  const bySlot = new Map();
  function add(slot, name, dedupeKey) {
    if (!Number.isFinite(slot) || slot > horizon) return;
    if (!bySlot.has(slot)) bySlot.set(slot, { names: [], seen: new Set() });
    const bucket = bySlot.get(slot);
    // One routine can produce several past-due occurrences that all collapse
    // onto the same next slot — name it once.
    if (bucket.seen.has(dedupeKey)) return;
    bucket.seen.add(dedupeKey);
    bucket.names.push(name);
  }

  (routines || []).forEach((routine, index) => {
    if (!routine) return;
    const name = routine.task || "Routine";
    const key = `r:${routine.id != null ? routine.id : index}`;
    routineOccurrences(routine, now, horizon).forEach((instant) => {
      let slot = slotForInstant(instant, hour);
      // Already past (overdue, or due earlier today before the reminder hour):
      // roll it forward to the next slot instead of dropping it.
      if (slot <= now) slot = soonest;
      add(slot, name, key);
    });
  });

  (todos || []).forEach((todo, index) => {
    if (!todo || todo.done) return; // completed to-dos are not news
    if (!todo.dueDate) return; // an undated to-do has no moment to fire at
    const at = localEpochForDate(todo.dueDate, hour);
    if (at == null) return;
    let slot = at <= now ? soonest : at; // overdue → next reminder
    add(slot, todo.text || "To-do", `t:${todo.id != null ? todo.id : index}`);
  });

  return Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, PUSH_MAX_REMINDERS)
    .map(([at, bucket]) => {
      // Several things due the same morning are ONE notification, worded
      // exactly like the in-tab one.
      const { title, body } = formatDueSummary(bucket.names);
      return { id: `due-${at}`, at, title, body };
    });
}

// Uploads the current schedule, replacing whatever the server held for this
// endpoint (that's the contract: POST /api/push/subscribe is a full replace,
// so re-sending the whole list is the normal way to update after a data
// change). Returns { ok, reason }; never throws.
// Reasons: "synced", "push-off", "unsupported", "not-subscribed",
// "no-api-base", "error".
async function syncPushReminders() {
  if (!isPushEnabled()) return { ok: false, reason: "push-off" };
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!getSettings().apiBase) return { ok: false, reason: "no-api-base" };

  const subscription = await getPushSubscription();
  if (!subscription) {
    // The browser dropped the subscription (cleared site data, key rotation,
    // reinstall). Clear the flag so isPushActive() stops suppressing the
    // in-tab fallback and the user isn't left with silence on both tiers.
    setPushEnabled(false);
    return { ok: false, reason: "not-subscribed" };
  }

  try {
    const [routines, todos] = await Promise.all([getAllRoutines(), getAllTodos()]);
    const { hour } = getNotifySettings();
    const reminders = buildPushReminders(routines, todos, { hour, now: Date.now() });
    const res = await apiFetch("/api/push/subscribe", {
      subscription: subscription.toJSON(),
      reminders,
    });
    return { ok: true, reason: "synced", count: reminders.length, stored: res && res.stored };
  } catch (e) {
    console.error("syncPushReminders:", e && e.message);
    return { ok: false, reason: "error", detail: e && e.message };
  }
}

// Debounced entry point for the rest of the app: call it after ANY change to
// routines or to-dos. Coalescing matters because a single user action (ticking
// off three to-dos, an AI batch write) would otherwise fire three full uploads
// of the same 60-item list.
let pushSyncTimer = null;
function schedulePushSync(delayMs) {
  if (!isPushEnabled()) return; // cheap no-op so call sites need no guard
  if (pushSyncTimer) clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(() => {
    pushSyncTimer = null;
    Promise.resolve(syncPushReminders()).catch(() => {});
  }, Number.isFinite(delayMs) ? delayMs : 4000);
}

// Called once by the orchestrator on app load. Two jobs now:
//
//  - TIER 2 (the in-tab fallback): a first check shortly after load, then
//    every 30 min while the page stays open, only actually checking once the
//    clock has reached the configured hour. That "hour" gate lives HERE, not
//    inside checkDueAndNotify, so the Settings "send a test" button — which
//    calls checkDueAndNotify directly — always works immediately regardless
//    of the configured time, and so the pure due/dedupe logic stays trivial to
//    unit test without stubbing the clock.
//  - TIER 1 upkeep: if push is on, re-upload the schedule on load. Cheap
//    insurance — the app may have been closed for days while to-dos were
//    ticked off on another device, and it also re-validates the subscription
//    (a dead one clears the flag, which brings tier 2 back).
function startNotifyTimer() {
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min

  function tick() {
    // Stand down when real push is live: the server is already delivering this
    // exact summary, and checking here too would show it twice on a device
    // that happens to have the app open at the reminder hour.
    if (isPushActive()) return;
    const { hour } = getNotifySettings();
    if (new Date().getHours() >= hour) checkDueAndNotify();
  }

  const startTimeout = setTimeout(tick, 15000); // let app init / IndexedDB reads settle first
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  // Slightly earlier than the first tick: IndexedDB is warm by then, and if
  // this clears a dead subscription the tick right after sees the corrected
  // flag and takes over.
  const pushSyncTimeout = setTimeout(() => {
    if (isPushEnabled()) Promise.resolve(syncPushReminders()).catch(() => {});
  }, 8000);

  return function stopNotifyTimer() {
    clearTimeout(startTimeout);
    clearTimeout(pushSyncTimeout);
    clearInterval(interval);
  };
}

// ---------- Settings UI (FEATURE 3's "Settings section") ----------

const NOTIFY_TEST_MESSAGES = {
  sent: "Sent — check your notifications.",
  "nothing-due": "Nothing's due right now, so there was nothing to notify about — add an overdue routine or to-do, then try again.",
  "no-permission": "Notifications aren't allowed for this site.",
  unsupported: "This browser doesn't support notifications.",
  disabled: "Notifications are turned off above — turn them on and try again.",
  error: "Couldn't read your garden data to check what's due.",
};

// Every reason enablePush/syncPushReminders can return, in plain language.
// A failure the user can act on ("set your VPS URL") must never surface as a
// generic "couldn't turn that on".
const PUSH_STATUS_MESSAGES = {
  enabled: "On — reminders will arrive even with the app closed.",
  "enabled-not-synced":
    "Subscribed, but the reminder schedule couldn't be uploaded — check your VPS API URL and connection, then try again.",
  disabled: "Off — reminders only while the app is open.",
  unsupported: "This browser doesn't support background notifications.",
  "no-push-manager":
    "This browser can't do background notifications. On iPhone/iPad, Safari only allows them once you've installed the app: Share → Add to Home Screen, then open it from there.",
  "no-permission": "Notifications aren't allowed for this site, so nothing can be delivered.",
  "no-api-base": "Set your VPS API URL in Settings first — that's the server that delivers reminders.",
  offline: "Couldn't reach your VPS. Check your connection and try again.",
  "server-error": "Your VPS answered with an error. Check that it's running the latest version.",
  "not-configured":
    "Your VPS doesn't have push notifications configured (no VAPID keys), so reminders can only arrive while the app is open.",
  "not-subscribed": "The browser dropped this device's subscription — turn background reminders back on.",
  "push-off": "Background reminders are off.",
  synced: "Reminder schedule updated.",
  error: "Couldn't turn on background reminders.",
};

// iOS Safari exposes PushManager ONLY to a PWA launched from the Home Screen.
// Used to explain a missing PushManager on iPhone/iPad specifically, instead
// of the useless generic "your browser doesn't support this".
function pushNeedsHomeScreenInstall() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac; the touch-point count gives it away.
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (!isIOS) return false;
  const standalone =
    (typeof window !== "undefined" && window.navigator && window.navigator.standalone === true) ||
    (typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches);
  return !standalone;
}

function notifyFormatHour(h) {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// Self-contained so SettingsModal (shared-ui.jsx) only needs one guarded
// line to use it — manages its own settings/permission/test-result state.
function NotifySettingsSection() {
  const [settings, setSettings] = useState(getNotifySettings());
  const [permission, setPermission] = useState(
    notificationsSupported() ? Notification.permission : "unsupported"
  );
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [pushOn, setPushOn] = useState(isPushEnabled());
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const canPush = pushSupported();

  // The stored flag is only this device's INTENTION; the browser is the
  // authority on whether a subscription still exists (site data cleared, PWA
  // reinstalled, key rotated). Reconcile on open so the toggle never claims
  // "on" while nothing can actually be delivered.
  useEffect(() => {
    let cancelled = false;
    if (!canPush || !isPushEnabled()) return;
    getPushSubscription().then((sub) => {
      if (cancelled || sub) return;
      setPushEnabled(false);
      setPushOn(false);
      setPushMsg(PUSH_STATUS_MESSAGES["not-subscribed"]);
    });
    return () => {
      cancelled = true;
    };
  }, [canPush]);

  async function handlePushChange(e) {
    const want = e.target.value === "on";
    setPushBusy(true);
    setPushMsg("");
    try {
      const result = want ? await enablePush() : await disablePush();
      // enablePush reports ok:true for "enabled-not-synced" — push really is
      // on in that case, so the toggle must follow reality, not optimism.
      const nowOn = want ? !!(result && result.ok) : false;
      setPushOn(nowOn);
      setPushMsg((result && PUSH_STATUS_MESSAGES[result.reason]) || PUSH_STATUS_MESSAGES.error);
      // Turning push on grants notification permission as a side effect —
      // reflect it so the permission-denied branch below stays accurate.
      if (notificationsSupported()) setPermission(Notification.permission);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleEnabledChange(e) {
    const enabled = e.target.value === "on";
    // Only prompt for permission on the transition to "on" — asking again on
    // every render (or when switching back off) would be pointless, and
    // requestNotifyPermission already avoids re-prompting a decided answer.
    if (enabled && permission !== "granted") {
      const result = await requestNotifyPermission();
      setPermission(result);
      if (result !== "granted") return; // refused — leave the select on Off
    }
    const next = { ...settings, enabled };
    setNotifySettings(next);
    setSettings(next);
    // This is the master switch. Leaving a live push subscription behind when
    // the user says "off" would keep delivering the very reminders they just
    // turned off — the most confusing possible outcome.
    if (!enabled && isPushEnabled()) {
      await disablePush();
      setPushOn(false);
      setPushMsg("");
    }
  }

  function handleHourChange(e) {
    const next = { ...settings, hour: Number(e.target.value) };
    setNotifySettings(next);
    setSettings(next);
    // Every scheduled `at` was computed from the old hour, so the whole
    // uploaded schedule is now wrong. Debounced: this select fires on every
    // keyboard arrow-through.
    schedulePushSync(1500);
  }

  async function sendTest() {
    setTesting(true);
    setTestMsg("");
    try {
      const result = await checkDueAndNotify(true);
      setTestMsg((result && NOTIFY_TEST_MESSAGES[result.reason]) || "Couldn't send a test notification.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <React.Fragment>
      <hr />
      <h3 className="notify-section-title">Due-date notifications</h3>

      {!notificationsSupported() ? (
        <p className="hint">This browser doesn't support notifications.</p>
      ) : permission === "denied" ? (
        // "instead of a dead toggle" — the toggle/hour picker are replaced
        // entirely here, since showing a control that can never do anything
        // is worse than explaining why.
        <p className="hint">
          Notifications are blocked for this site, so a toggle here wouldn't do anything. To turn
          them on: open your browser's site settings for this page (usually the lock/info icon in
          the address bar), allow Notifications, then reload the app.
        </p>
      ) : (
        <React.Fragment>
          <label>
            Due-date notifications
            <select value={settings.enabled ? "on" : "off"} onChange={handleEnabledChange}>
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          {settings.enabled && (
            <React.Fragment>
              <label>
                Remind me at
                <select value={settings.hour} onChange={handleHourChange}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{notifyFormatHour(h)}</option>
                  ))}
                </select>
              </label>

              {canPush ? (
                <React.Fragment>
                  <label>
                    When the app is closed
                    <select
                      value={pushOn ? "on" : "off"}
                      onChange={handlePushChange}
                      disabled={pushBusy}
                    >
                      <option value="off">Don't remind me</option>
                      <option value="on">Remind me anyway</option>
                    </select>
                  </label>
                  <p className="hint notify-status" role="status" aria-live="polite">
                    {pushBusy
                      ? "Working…"
                      : pushOn
                      ? "Reminders work with the app closed. Your VPS sends them; the reminder text is worked out on this device, so your garden data never leaves it."
                      : "Only while the app is open. Turn this on to get reminders with the app or browser fully closed — it needs your VPS set up with push keys."}
                  </p>
                </React.Fragment>
              ) : (
                // No PushManager at all. On iPhone/iPad that's usually fixable
                // (install the PWA), so say which case this is instead of a
                // flat "unsupported".
                <p className="hint">
                  {pushNeedsHomeScreenInstall()
                    ? "Reminders will only arrive while the app is open. On iPhone and iPad, background reminders need the app installed to the Home Screen: tap Share → Add to Home Screen, open it from there, then come back to this setting."
                    : "This browser can't deliver reminders while the app is closed, so these will only arrive while it's open."}
                </p>
              )}
              {pushMsg && (
                <p className="hint notify-status" role="status" aria-live="polite">{pushMsg}</p>
              )}
            </React.Fragment>
          )}
        </React.Fragment>
      )}

      <button
        className="btn btn-ghost btn-block"
        onClick={sendTest}
        disabled={testing || !notificationsSupported() || permission === "denied"}
      >
        <i className="bi bi-bell" aria-hidden="true"></i> {testing ? "Sending…" : "Send a test notification"}
      </button>
      {testMsg && <p className="hint notify-status" role="status" aria-live="polite">{testMsg}</p>}

      <p className="hint">
        {pushOn
          ? "The test above is sent by this device, so it proves notifications display here — real reminders are delivered by your VPS at the time you picked, whether the app is open or not. Delivery still depends on the phone being on and online; battery savers can delay it."
          : "Honest limitation: with background reminders off, this can only notify you while Garden Companion is open — closing the app or browser, or the phone suspending the tab, silences it."}
      </p>
    </React.Fragment>
  );
}
