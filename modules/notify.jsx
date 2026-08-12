// Due-date notifications: nudges the user when a routine or to-do comes due
// without them having to open the app and check. This file owns the whole
// feature — pure logic (checkDueAndNotify/startNotifyTimer) AND its own
// Settings UI section (NotifySettingsSection), rendered from SettingsModal in
// shared-ui.jsx with one guarded line, so that file stays short.
//
// HONEST LIMITATION — read this before assuming more than it does: there is
// no push server behind Garden Companion, so nothing here can wake the app
// up. A Notification can only be shown while THIS TAB is open and running —
// closing the tab/browser, or the OS suspending a backgrounded tab, silences
// it. iOS Safari / home-screen PWAs have no web-push or background-execution
// capability at all, so this does nothing there once the app isn't the
// foreground tab. Android Chrome throttles backgrounded tabs too, so even
// there this is best-effort, not guaranteed. In short: this is "remind me
// while I happen to have the app open," never a real push notification
// system — the Settings copy below says so in plain language, and that must
// stay true if this file changes.
//
// Classic script, shares the page's global scope like every other module —
// see the note at the top of idb.js for why (no import/export, no build step).

const NOTIFY_ENABLED_KEY = "gc_notifyEnabled";
const NOTIFY_HOUR_KEY = "gc_notifyHour";
// Internal only (not part of the contract other files rely on): remembers
// the last date+signature a notification actually fired for, so the same due
// list doesn't re-notify every 30 minutes all day.
const NOTIFY_LAST_KEY = "gc_notifyLastFired";

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

  const title = items.length === 1 ? "1 thing needs attention" : `${items.length} things need attention`;
  const shown = items.slice(0, 3);
  const body = shown.join(", ") + (items.length > shown.length ? `, +${items.length - shown.length} more` : "");

  try {
    new Notification(title, { body, icon: "./icons/icon-192.png", tag: "garden-due" });
  } catch (e) {
    console.error("checkDueAndNotify: Notification constructor failed:", e && e.message);
    return { fired: false, reason: "error" };
  }
  localStorage.setItem(NOTIFY_LAST_KEY, dedupeKey);
  return { fired: true, reason: "sent" };
}

// Called once by the orchestrator on app load (see the honest-limitation
// note at the top of this file — this is a while-the-tab-is-open reminder,
// not real push). Runs a first check shortly after load, then every 30 min
// while the page stays open, only actually checking once the clock has
// reached the configured hour. That "hour" gate lives HERE, not inside
// checkDueAndNotify, so the Settings "send a test" button — which calls
// checkDueAndNotify directly — always works immediately regardless of the
// configured time, and so the pure due/dedupe logic stays trivial to unit
// test without stubbing the clock.
function startNotifyTimer() {
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min

  function tick() {
    const { hour } = getNotifySettings();
    if (new Date().getHours() >= hour) checkDueAndNotify();
  }

  const startTimeout = setTimeout(tick, 15000); // let app init / IndexedDB reads settle first
  const interval = setInterval(tick, CHECK_INTERVAL_MS);

  return function stopNotifyTimer() {
    clearTimeout(startTimeout);
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
  }

  function handleHourChange(e) {
    const next = { ...settings, hour: Number(e.target.value) };
    setNotifySettings(next);
    setSettings(next);
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
            <label>
              Remind me at
              <select value={settings.hour} onChange={handleHourChange}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{notifyFormatHour(h)}</option>
                ))}
              </select>
            </label>
          )}
        </React.Fragment>
      )}

      <button
        className="btn btn-ghost btn-block"
        onClick={sendTest}
        disabled={testing || !notificationsSupported() || permission === "denied"}
      >
        <i className="bi bi-bell"></i> {testing ? "Sending…" : "Send a test notification"}
      </button>
      {testMsg && <p className="hint notify-status">{testMsg}</p>}

      <p className="hint">
        Honest limitation: this can only notify you while Garden Companion is open in a browser
        tab — there's no push server behind it, so nothing can be delivered while the app or
        browser is fully closed. iOS can't do this at all for web apps; Android support varies by
        browser and battery settings.
      </p>
    </React.Fragment>
  );
}
