// Shared constants, settings, and the AI/data helper functions used across
// every module. Loaded first (after idb.js) so everything below is a plain
// global by the time chat.jsx/voice.jsx/garden.jsx/etc. run — see the note at
// the top of idb.js for why this app uses globals instead of import/export.

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
const LS_ACTIVE_CHAT = "gc_activeChatId";
const LS_AI_WRITE_MODE = "gc_aiWriteMode"; // 'auto' | 'confirm'
const LS_THEME = "gc_theme"; // a THEMES[].id (see the registry below)
const LS_DEFAULT_LOCATION = "gc_defaultLocation";
const LS_LANDING_VIEW = "gc_landingView"; // "chat" (default) | "today"

// ---------- how much of the conversation gets replayed to the AI ----------
//
// This used to be a flat count (CONTEXT_LIMIT = 24 messages), which IS what
// "Sprout keeps losing the thread" actually was: 24 short turns is only a few
// thousand characters, and everything agreed before that silently vanished
// mid-conversation. It is now a BUDGET over the text that is really sent, so a
// long thread of one-liners keeps far more history than a handful of long
// ones — and the counts in the truncation notice stay true either way
// (see sliceContextHistory / buildContextMessages).
//
// DELIBERATE COST TRADE-OFF (user: "give me max context, be extremely
// generous"). The system prompt alone is already ~3.3k tokens, and Groq's free
// tier meters roughly 8k tokens per MINUTE across the whole key. So a
// full-budget request WILL 429 on the Groq entries of the server's model chain
// and fall through to Cerebras / Gemini / Mistral, which have far more room:
// those turns are a little slower, but the thread survives, which is the whole
// point of this change. Lower CONTEXT_TOKEN_BUDGET to ~3000 if you would
// rather stay inside Groq's minute and accept the memory loss instead.
//
// Image messages ride along as a short "[shared photo #N]" placeholder, never
// the data URL, so photo-heavy threads cost almost nothing here.
// WHY THIS IS 6000 AND NOT 48000 (it was 48000, and that made questions slow):
// A 48k-token payload is too large for Groq's free tier, which answered with
// HTTP 413 Payload Too Large on every question. Groq is the FAST provider
// (~1-2s); disqualifying it meant every question fell through to Gemini with
// thinking enabled, measured at 15-28 SECONDS in the live logs (and one 45s
// timeout). So the "maximum context" setting was buying history the user
// couldn't feel and paying for it with a 20-second wait they could.
// 6000 tokens ≈ 24k characters ≈ 40-80 ordinary turns — still far more thread
// than any real conversation uses, and small enough that the fast provider can
// serve it. Raise it if you would rather have depth than speed; the cost is
// paid on EVERY question, not just the long ones.
// THE ARITHMETIC THAT SETS THIS NUMBER (Groq free tier, ~8000 tokens/minute,
// reservation = prompt + max_tokens charged UP FRONT):
//   system prompt ~4800  +  history budget 1200  +  reply reserve 2048  ≈ 8050
// (The system prompt is the dominant cost, not the history: the action
// formulas, the closed-set rule and the garden snapshot are ~4.8k on their own.
// Shrinking THAT is the next real lever — a lean chat variant of
// ACTION_CONVENTIONS — but it is a bigger change than this latency fix.)
// That fits inside one minute, which is the whole point: it keeps the FAST
// provider eligible. 2500 tokens is still ~10k characters ≈ 30-60 ordinary
// turns of conversation — more thread than a gardening chat ever needs.
// Overridable at runtime via localStorage "gc_contextBudget" if you would
// rather trade speed back for depth.
const CONTEXT_TOKEN_BUDGET = Number(localStorage.getItem("gc_contextBudget")) || 1200;
const CONTEXT_MIN_MESSAGES = 12; // floor: always kept even if they blow the budget,
// so a handful of enormous messages can never starve the window down to nothing
const CONTEXT_MESSAGE_CAP = 400; // ceiling on message COUNT, independent of size
const CONTEXT_LIMIT = CONTEXT_MESSAGE_CAP; // back-compat: the old global name still resolves

// ---------- the same three numbers, for "act" (command) requests ----------
//
// THE BUG THESE FIX (user: "'The AI providers are unavailable right now' way
// too often when I ask it to add pumpkin seeds to the to-get list"). The
// budget above is right for a QUESTION and catastrophic for a COMMAND, because
// the two go to different provider chains:
//
//   * A command is routed by detectChatMode() to the server's "act" chain,
//     whose Groq entry (openai/gpt-oss-20b) is metered by Groq's free tier at
//     ~8,000 tokens per MINUTE — and Groq reserves the REQUESTED max_tokens
//     against that minute up front, before generating anything (server.js:
//     GROQ_MAX_TOKENS_ACT = 2048). So the real ceiling for one act request is
//     prompt + 2048 ≤ 8000, i.e. a prompt of ~5,900 tokens for a SINGLE
//     command in a minute, or ~1,950 if two commands land in the same minute.
//     A 48,000-token history is not "a bit over" that — it is 6× Groq's whole
//     minute, so the entry 429s outright and every 429 is one more step down
//     the chain toward "no provider answered".
//   * A command also doesn't NEED the thread. "Add pumpkin seeds to the to-get
//     list" is self-contained; the only history it needs is enough to resolve a
//     pronoun ("add it to the list", "the other one too"), which is the last
//     couple of exchanges — not the last two hundred.
//
// The numbers below are picked so the WHOLE act payload — lean system prompt
// (~1.1k) + live garden snapshot (~0.6k, capped, see SNAPSHOT_ITEM_CAP) +
// history (≤900) + name hints — lands around 2.5–3k tokens. With Groq's 2048
// reservation that is ~5k of the 8k minute: one command comfortably served,
// ~3k of headroom left over, and no single request that Groq must refuse.
// (Groq is now SECOND in the act chain behind Gemini flash-lite, which is
// metered per request/day rather than per minute — but "fits in Groq's minute"
// is still the number that decides whether the fallback can catch anything.)
//
// Chat keeps the generous budget above: a gardening question genuinely does
// benefit from the whole thread, and it is routed to chains (Cerebras 1M/day,
// Gemini per-request) with room for it.
const CONTEXT_TOKEN_BUDGET_ACT = 900; // ≈3.6k characters of replayed history
const CONTEXT_MIN_MESSAGES_ACT = 4; // floor: the last two exchanges, for "add IT to the list"
const CONTEXT_MESSAGE_CAP_ACT = 20; // ceiling on COUNT (20 tiny turns still can't sprawl)

// Per-section cap on how many items the LIVE GARDEN DATA snapshot LISTS. The
// counts in each heading are always the real totals (see buildKnowledgeContext)
// — only the enumeration is cut, and the cut is announced, so "what do I have?"
// can never be answered wrongly from a truncated list.
//
// chat is set high enough that an ordinary garden is never truncated at all
// (truncation is a last resort for a genuinely huge one); act is tight because
// a command needs the ids of the items it might be about, not a catalogue.
// Ordering (pinned → urgent → recently touched) is what makes the tight cap
// safe: anything the user just named survives it, always.
const SNAPSHOT_ITEM_CAP = 40;
const SNAPSHOT_ITEM_CAP_ACT = 8;

// Predefined tag sets per module. Users can also type any custom tag, and the
// AI can both use these and invent new ones (kept short + lowercase).
const PRESET_TAGS = {
  plants: ["vegetable", "fruit", "herb", "flower", "indoor", "outdoor", "succulent", "tree"],
  tools: ["hand tool", "power tool", "fertilizer", "pesticide", "seeds", "soil", "watering", "consumable"],
  routines: ["watering", "fertilizing", "pruning", "pest control", "cleaning", "harvest"],
};

// Normalizes a tags value coming from the AI or a form into a clean,
// deduplicated array of short lowercase strings.
function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const clean = String(t || "").trim().toLowerCase().slice(0, 24);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 8);
}

function getAiWriteMode() {
  return localStorage.getItem(LS_AI_WRITE_MODE) || "auto";
}

// ---------- themes ----------
//
// ONE source of truth for the four palettes. `id` is what lands in localStorage
// AND what becomes the `theme-<id>` class on the root element (so it must match
// the `.theme-<id>` blocks in styles.css); `label` is what Settings shows;
// `dark` decides whether that element ALSO gets the plain `dark` class; and
// `themeColor` paints the Android status bar via <meta name="theme-color">.
//
// WHY `dark` IS A FLAG HERE AND NOT `id === "forest"`:
// styles.css carries a handful of `.dark .foo` rules — the segmented control,
// .btn-ghost, .bottom-nav-item.active, .gc-readmore, .today-more — that flip
// STRUCTURE rather than palette on a dark ground (which of the two surfaces
// reads as "raised", which accent an inline link takes). They are not part of
// any palette block and no token can express them. So EVERY dark theme has to
// keep carrying the `dark` class: one that dropped it would still look roughly
// right at a glance and would quietly break all five. Deriving the class from
// this flag is what makes "add a dark theme" a one-line change that can't
// forget them.
//
// The two original palettes are renamed only. Meadow is the old "light" and
// Forest the old "dark", down to their status-bar colours (#2e6b34 / #101510),
// because renaming was not allowed to move a pixel.
const THEMES = [
  { id: "meadow", label: "Meadow (light)", dark: false, themeColor: "#2e6b34" },
  { id: "terracotta", label: "Terracotta (light)", dark: false, themeColor: "#a04c28" },
  { id: "forest", label: "Forest (dark)", dark: true, themeColor: "#101510" },
  { id: "midnight", label: "Midnight (dark)", dark: true, themeColor: "#1e2748" },
];

// The app has always opened dark for a first-time user; Forest IS that palette,
// so the default is unchanged in effect.
const DEFAULT_THEME_ID = "forest";

// Values written by every version of the app before the theme system existed.
// They are MIGRATED, never ignored: falling back to the default instead would
// silently flip an existing light-theme user to dark on upgrade.
const LEGACY_THEME_IDS = { dark: "forest", light: "meadow" };

// Always returns a real theme — an unknown id (hand-edited storage, or a theme
// dropped by a later version) resolves to the default rather than rendering
// with no palette class at all.
function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME_ID);
}

function getTheme() {
  const stored = localStorage.getItem(LS_THEME);
  if (!stored) return DEFAULT_THEME_ID;
  return themeById(LEGACY_THEME_IDS[stored] || stored).id;
}

// The palette classes for the root element, as one string. Read the `dark`
// note above before "simplifying" this: the second class is load-bearing.
function themeClassName(id) {
  const t = themeById(id);
  return `theme-${t.id}${t.dark ? " dark" : ""}`;
}

function getDefaultLocation() {
  return localStorage.getItem(LS_DEFAULT_LOCATION) || "";
}

// ---------- the system prompt, in NAMED PIECES ----------
//
// Composed rather than written twice. "act" (a command) and "chat" (a question)
// need different amounts of the same instructions, and the one thing that must
// never happen is two hand-maintained copies of a 3k-token prompt drifting
// apart — a rule fixed in one wall and not the other is worse than no rule.
// So every piece below is written ONCE and the two modes are assembled from
// them. SYSTEM_PROMPT_BASE is still byte-for-byte the string it always was.
const PROMPT_PERSONA = "You are Sprout, a friendly, knowledgeable gardening companion. ";

// The advisory half: only worth its ~150 tokens when the user actually asked
// something. A command ("add pumpkin seeds") has no species to identify, no
// symptoms to describe and no source to cite.
// User, 2026-09-29, after a dosage question went round in circles ("send a
// clearer photo of the label" x4, then "take it to a shop"): "the point of the
// bot is for it to know how to act". The old wording — ask whenever unsure,
// never guess — was obeyed so literally that the model refused to answer at
// all. The rule now is: answer with the best-supported value, say where it
// came from, research what you don't know, and ask only for things that can't
// be looked up (and then for the brand, never for another photo).
const PROMPT_ADVICE =
  "Give practical, concrete advice (watering, light, soil, pests, timing) suited to home gardeners.\n" +
  "STRAIGHT ANSWERS — the user needs to know what to DO, not to be sent away:\n" +
  "- Answer with something they can act on: a number, a product, a step. Never reply only with " +
  "\"check the label\", \"send a clearer photo\" or \"ask a shop\".\n" +
  "- Where facts come from, in this order: (1) what is already saved about the item — its label " +
  "reading, notes and Codex entry (the WHAT YOU ALREADY KNOW block); (2) a web search, whenever you " +
  "have a search tool and aren't sure of a fact (a product's active ingredient and label rates, a " +
  "pest, a disease) — search the brand + product name, or the active ingredient; (3) your own " +
  "knowledge of that active ingredient or product type and its usual label rate. Say which one you " +
  "used in a few words (\"per your label photo\", \"per the manufacturer's page\", \"usual label rate " +
  "for abamectin 1.8% EC\").\n" +
  "- DOSES AND MIXING: work it out for the user's own sprayer/can volume and show the arithmetic in " +
  "one line. If their plant isn't listed on the label, use the rate for the closest listed crop and " +
  "pest and say so. If the amount is tiny, say how to measure it (a 1 mL syringe, or mix a bigger " +
  "batch). Then at most ONE line of the safety points that really apply (days before harvest, " +
  "gloves, don't mix with X) — safety notes go WITH the answer, never instead of it.\n" +
  "- NAMES MAY BE MISHEARD: messages are often dictated, so a product name can arrive garbled " +
  "(\"Autopilus\"). Match it to the closest item in their inventory or the closest real product, " +
  "and say which one you assumed.\n" +
  "- DON'T KNOW THE PRODUCT AT ALL? Ask ONE question you can research from: the brand/manufacturer " +
  "and the product name printed in big letters on the front (or the active ingredient). Never ask " +
  "for another photo of the fine print. When they answer, look it up and answer in that same reply.\n" +
  "- ASK only when the missing detail changes the answer AND can't be looked up (which of their " +
  "plants, indoors or outdoors). Otherwise give your best answer and label it as an estimate. For " +
  "an uncertain diagnosis or ID, say how sure you are in a few words, then still give the most likely " +
  "answer and what to do about it; in a reply that only asks a question, emit no action lines.\n" +
  "- REMEMBER WHAT YOU LEARN: after researching or working out facts the user will need again (what " +
  "a product is, active ingredient, rates, how to apply), save them — SAVE_CODEX with a compact " +
  "reference and, for an item in their inventory, UPDATE_TOOL its \"brand\"/\"productInfo\" as well — " +
  "so next time it is already in the WHAT YOU ALREADY KNOW block. Don't save chit-chat or re-save " +
  "what is already there.\n";

// What replaces it in act mode: the job, in two sentences. The "ask instead of
// guessing" half of PROMPT_ADVICE survives here in the form that matters for a
// command — which ITEM, not which fact.
const PROMPT_ACT_FOCUS =
  "The user has just given you a COMMAND about their own garden data. Carry it out: emit the " +
  "matching action line(s) per the formulas below, and keep your visible text to one or two " +
  "short sentences confirming what you did. If you cannot tell which item they mean, ask ONE " +
  "short question instead and emit no action line at all. ";

// Both modes: this is the "Lenovo the fungicide" prior, and it bites hardest on
// a command (a wrongly-resolved name is a wrongly-written record).
const PROMPT_NAMES =
  "NAMES: item names in the user's own garden data always refer to their own items — when a " +
  "name collides with a famous real-world company/brand/celebrity/place, the user's item wins " +
  "unless they clearly mean the outside entity. ";

// One sentence, and it only does anything when a LOCAL WEATHER block is
// actually present, so it stays in both modes.
const PROMPT_WEATHER =
  "WEATHER: when a LOCAL WEATHER block is provided, let it drive watering, spraying and frost/" +
  "heat advice instead of generic seasonal guidance.";

const SYSTEM_PROMPT_BASE = PROMPT_PERSONA + PROMPT_ADVICE + PROMPT_NAMES + PROMPT_WEATHER;
const SYSTEM_PROMPT_BASE_ACT = PROMPT_PERSONA + PROMPT_ACT_FOCUS + PROMPT_NAMES + PROMPT_WEATHER;

// ---------- small formatting helpers ----------

// The device's current date AND time (plus timezone), for AI prompts — models
// don't know either on their own, and "water it this evening" style advice
// needs the time of day, not just the date.
function deviceNow() {
  const d = new Date();
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (_) {
      return "";
    }
  })();
  return (
    d.toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + (tz ? ` (${tz})` : "")
  );
}

// Relative-time label for chips and logs: "today", "yesterday", "5 days ago".
function timeAgo(ts) {
  if (!ts) return "never";
  const days = daysSince(ts);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}

function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

// Today as "YYYY-MM-DD" in the DEVICE's timezone — NOT toISOString(), which is
// UTC and lands on the wrong calendar day either side of midnight. Matches the
// format an <input type="date"> stores (to-do due dates).
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Whole days from today to a "YYYY-MM-DD" date: 0 = today, negative = overdue,
// null when there's no (or an unparseable) date. Lives here rather than in
// todos.jsx because buildKnowledgeContext (below) needs it too, and helpers.jsx
// loads first.
//
// DELIBERATELY DAY-GRANULAR, and it stays that way now that a to-do can also
// carry a dueTime: every caller of this function asks a CALENDAR question
// ("today", "tomorrow", "overdue 3 d", rank the snapshot) that a fractional
// answer would break — todoDueLabel switches on `delta === 0` and `=== 1`. The
// clock-time question is a different one, answered by todoDueAt below.
function todoDueDelta(dueDate) {
  if (!dueDate) return null;
  const due = Date.parse(`${dueDate}T00:00:00`);
  if (isNaN(due)) return null;
  const today = Date.parse(`${todayISO()}T00:00:00`);
  return Math.round((due - today) / (24 * 60 * 60 * 1000));
}

// ---------- to-do due TIMES (the optional "HH:MM" beside dueDate) ----------
//
// A to-do may carry an optional dueTime (24h, device-local — see idb.js), which
// is what turns "remind me in 5 minutes" into something the app can actually
// deliver. It is parsed in exactly ONE place — here — because four different
// files ask the same question about it (the row's due label, urgency for the
// nav badge, the AI snapshot, and the push schedule), and four parsers would
// eventually disagree about what "14:30" means.

// "HH:MM" (zero-padded, 24h) for anything usable, "" for everything else —
// undefined, "", "banana", "25:99". Never throws: junk degrades the to-do to
// date-only, which is exactly how every to-do behaved before this field
// existed, rather than breaking a save or a schedule.
function normalizeDueTime(value) {
  const t = parseDueTime(value);
  return t ? `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}` : "";
}

// The same value as { h, m }, or null.
// Seconds are accepted and dropped (an <input type="time"> with a step emits
// "HH:MM:SS"), and a 12-hour "7:00 PM" is tolerated even though the prompt asks
// the model for 24h: a model that answers in 12-hour form anyway would
// otherwise have its time silently thrown away, and the reminder would quietly
// arrive at the daily hour instead — the exact kind of silent failure the user
// only discovers by missing it.
function parseDueTime(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  // 24-hour: the form this app stores and the only form it ever writes.
  let hit = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(raw);
  if (hit) {
    const h = Number(hit[1]);
    return h <= 23 ? { h, m: Number(hit[2]) } : null; // "25:99" lands here
  }
  // 12-hour with a meridiem: tolerated on the way IN, never produced.
  hit = /^(\d{1,2}):([0-5]\d)\s*([ap])\.?\s*m?\.?$/i.exec(raw);
  if (!hit) return null;
  const h12 = Number(hit[1]);
  if (h12 < 1 || h12 > 12) return null;
  const pm = hit[3].toLowerCase() === "p";
  return { h: (h12 % 12) + (pm ? 12 : 0), m: Number(hit[2]) }; // 12 AM → 0, 12 PM → 12
}

// The exact local instant a to-do is due, as epoch ms — ONLY for one carrying
// BOTH a dueDate and a usable dueTime. null for everything else (no date, no
// time, junk in either), and every caller falls back to its existing
// day-granularity behaviour on null, which is what keeps every to-do written
// before this field existed behaving exactly as it always did.
//
// Built with the Date(y, mIdx, d, h, min) constructor and NEVER
// Date.parse(iso) + offset: a local calendar day is not always 24 hours long,
// so arithmetic on a parsed midnight lands an hour out on the two days a year
// the clocks change. The constructor asks the platform for the real local
// offset on THAT day. Same rule as localEpochForDate in modules/notify.jsx —
// and the push schedule there calls THIS function for timed to-dos, so there is
// one implementation of "when is this to-do actually due", not two.
function todoDueAt(todo) {
  if (!todo || !todo.dueDate) return null; // a time with no date has no instant
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todo.dueDate).trim());
  if (!date) return null;
  const time = parseDueTime(todo.dueTime);
  if (!time) return null;
  const at = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), time.h, time.m, 0, 0).getTime();
  return Number.isFinite(at) ? at : null;
}

// First user message → chat title ("What's wrong with my basil…").
function autoTitleFromText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 38) return clean;
  return clean.slice(0, 38).replace(/\s+\S*$/, "") + "…";
}

// Markdown/symbols make TTS read garbage ("asterisk asterisk"). Strip to
// plain speakable text before handing anything to speechSynthesis.
function stripForSpeech(text) {
  return (text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Renders AI reply text as markdown when it looks like markdown (bold,
// lists, headers, links), sanitized before ever touching the DOM. Falls
// back to plain escaped text if the markdown libraries didn't load for some
// reason (e.g. CDN blocked) — never silently drops content.
function renderMarkdownSafe(text) {
  if (!text) return "";
  try {
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(text, { breaks: true });
      return window.DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
    }
  } catch (_) {
    // fall through to plain text below
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

function resizeImageToDataUrl(file, maxDim = 1024, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getSettings() {
  return {
    apiBase: (localStorage.getItem(LS_API_BASE) || "").replace(/\/$/, ""),
    secret: localStorage.getItem(LS_SECRET) || "",
  };
}

async function apiFetch(path, body) {
  const { apiBase, secret } = getSettings();
  if (!apiBase) throw new Error("Set your VPS API URL in Settings first.");
  const res = await fetch(apiBase + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Client-Secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Providers return errors as strings OR nested objects; without the
    // stringify fallback an object error surfaced as "[object Object]".
    const raw = data && data.error;
    let msg = "";
    if (typeof raw === "string") msg = raw;
    else if (raw && typeof raw === "object") {
      msg = raw.error?.message || raw.message || JSON.stringify(raw);
    }
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- codex research (auto-logging of new items) ----------

// Pulls the "SOURCES: url1, url2" line off an AI reference reply. Matches the
// LAST such line ANYWHERE in the text (models sometimes add a sign-off after
// it, and the old end-of-string-anchored regex then silently lost every
// source), tolerating the same markdown decorations as the STATUS line.
const SOURCES_LINE_RE = /(?:^|\n)[ \t>*`-]*SOURCES\**[ \t]*:[ \t]*([^\n]*)/gi;

function extractSources(text) {
  const src = text || "";
  SOURCES_LINE_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = SOURCES_LINE_RE.exec(src)) !== null) last = m;
  if (!last) return { body: src.trim(), sources: [] };
  const start = last.index + (src[last.index] === "\n" ? 1 : 0); // keep the newline
  const body = (src.slice(0, start) + src.slice(last.index + last[0].length)).trim();
  const raw = (last[1] || "").replace(/[`*]+$/, "").trim();
  if (!raw || /^none$/i.test(raw)) return { body, sources: [] };
  const sources = raw
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { body, sources };
}

const CODEX_RESEARCH_SYSTEM =
  "You are a gardening reference-library assistant. Write an in-depth, factual reference " +
  "entry (8-14 sentences) about the given subject, using trusted sources (university " +
  "extension services, RHS, botanical gardens, manufacturer documentation). " +
  "For a PLANT: scientific/botanical name and family, growth habit, light/water/soil/" +
  "temperature needs, feeding, common pests and diseases, propagation, and any toxicity " +
  "to humans or pets. For a TOOL or SUPPLY: what it is, what it's used for, how and when " +
  "to use it correctly, active ingredients or materials where relevant, safety precautions, " +
  "and — for a packaged product (fertilizer, pesticide, fungicide) — its active ingredient and " +
  "concentration plus the label mixing rates (per litre and per 100 L) for its main uses and the " +
  "days to wait before harvest. If identification hints are given, use them to pick the right " +
  "product: trade names repeat across countries and manufacturers. " +
  "and storage/maintenance. Use markdown sparingly (bold key terms). After the entry, on " +
  "its own final line, output exactly: SOURCES: <1-3 real source URLs, comma separated> — " +
  "or SOURCES: none if you're not confident of a real source. Never omit that line.";

// Every new plant/tool automatically gets a researched codex entry (with
// sources) so the codex accumulates real knowledge about what the user owns.
//
// THROTTLED QUEUE: research runs through Groq's compound-mini, which shares
// gpt-oss-120b's 8K tokens/MINUTE bucket (seen live in the 429 logs) — the
// same bucket chat falls back to. Bulk adds ("add demo data") used to fire N
// research calls at once and starve the chat. Jobs now run one at a time with
// a 20s gap, in the background; adds are never blocked.
const codexInFlight = new Set(); // names queued/being researched (dedupe)
const codexQueue = [];
let codexQueueRunning = false;
const CODEX_RESEARCH_GAP_MS = 20000;

function ensureCodexResearch(kind, name) {
  const clean = (name || "").trim();
  if (!clean) return;
  const norm = clean.toLowerCase();
  if (codexInFlight.has(norm)) return;
  codexInFlight.add(norm);
  codexQueue.push({ kind, name: clean });
  processCodexQueue(); // fire-and-forget
}

async function processCodexQueue() {
  if (codexQueueRunning) return;
  codexQueueRunning = true;
  try {
    while (codexQueue.length > 0) {
      const job = codexQueue.shift();
      await researchCodexItem(job.kind, job.name);
      if (codexQueue.length > 0) {
        await new Promise((r) => setTimeout(r, CODEX_RESEARCH_GAP_MS));
      }
    }
  } finally {
    codexQueueRunning = false;
  }
}

async function researchCodexItem(kind, clean) {
  const norm = clean.toLowerCase();
  try {
    const existing = await getAllCodexEntries();
    if (existing.some((e) => (e.itemName || e.title || "").trim().toLowerCase() === norm)) return;
    // A product name alone is often ambiguous ("Ticket", "Alpha Plus" are
    // trade names that mean different things in different countries), so a
    // tool's brand and saved label reading go along as identification hints.
    let hints = "";
    if (kind !== "plant") {
      const tool = (await getAllTools()).find((t) => (t.name || "").trim().toLowerCase() === norm);
      if (tool) {
        const bits = [];
        if (tool.brand) bits.push(`brand: ${tool.brand}`);
        if (hasProductInfo(tool)) bits.push(`label reading from the user's photo: ${clipForPrompt(tool.productInfo, 800)}`);
        if (tool.notes) bits.push(`user's notes: ${clipForPrompt(tool.notes, 200)}`);
        if (bits.length) hints = `\nIdentification hints — ${bits.join("; ")}`;
      }
    }
    const data = await apiFetch("/api/chat", {
      mode: "research",
      messages: [
        { role: "system", content: CODEX_RESEARCH_SYSTEM },
        { role: "user", content: `${kind === "plant" ? "Plant" : "Tool/supply"}: ${clean}${hints}` },
      ],
    });
    const { body, sources } = extractSources(data.reply || "");
    if (!body) return;
    await addCodexEntry({ title: clean, body, sources, kind, itemName: clean, auto: true });
  } catch (e) {
    console.error("codex auto-research failed:", e.message);
  } finally {
    codexInFlight.delete(norm);
  }
}

// Reconciliation sweep: enqueue research for any plant/tool with no codex
// entry yet (failed earlier / predates the feature). Runs on app load and
// when the Codex opens — but at most once per 10 minutes, capped per sweep,
// and everything goes through the throttled queue above.
let lastCodexSweepAt = 0;

async function syncCodexEntries(maxNew = 3) {
  try {
    if (Date.now() - lastCodexSweepAt < 10 * 60 * 1000) return 0;
    lastCodexSweepAt = Date.now();
    const [plants, tools, entries] = await Promise.all([
      getAllPlants(),
      getAllTools(),
      getAllCodexEntries(),
    ]);
    const have = new Set(entries.map((e) => (e.itemName || e.title || "").trim().toLowerCase()));
    const missing = [
      ...plants.map((p) => ({ kind: "plant", name: p.name })),
      ...tools.map((t) => ({ kind: "tool", name: t.name })),
    ].filter((x) => x.name && x.name.trim() && !have.has(x.name.trim().toLowerCase()));
    for (const item of missing.slice(0, maxNew)) {
      ensureCodexResearch(item.kind, item.name); // enqueued, spaced 20s apart
    }
    return missing.length;
  } catch (e) {
    console.error("codex sync failed:", e.message);
    return 0;
  }
}

// ---------- AI context ----------

// Local weather (weather.jsx) belongs in the AI's context, but that file loads
// AFTER this one, so this file can't call into it. Inverted dependency: this
// slot is declared here and weather.jsx assigns itself into it on load; it is
// only ever CALLED at request time, by which point every script has run.
// Stays null when weather.jsx isn't loaded — the context block is then simply
// omitted, exactly as when the user has weather switched off.
let weatherContextProvider = null;

async function getWeatherContextBlock() {
  if (typeof weatherContextProvider !== "function") return "";
  try {
    return (await weatherContextProvider()) || "";
  } catch (e) {
    console.error("weather context failed:", e && e.message);
    return ""; // weather is a bonus — never let it break a chat request
  }
}

// Bumped after every write (and by the manual refresh button) so anything
// holding a snapshot can tell that it went stale. The number rides along in
// the AI snapshot header, which is what makes "is this actually fresh?"
// checkable instead of just promised.
let contextRevision = 0;

// Returns the new number so a caller can show it (the refresh modal does).
function bumpContextRevision() {
  contextRevision += 1;
  return contextRevision;
}

// Confirm mode QUEUES the AI's changes for the user to approve instead of
// writing them — the data snapshot below is then correct, but the model still
// believes its change landed and says "saved!". These descriptions go into the
// snapshot so it can't. Set when actions are queued, re-set (usually to empty)
// whenever the confirm banner resolves.
let queuedActionNotes = [];

function setQueuedActions(resolvedActions) {
  queuedActionNotes = (resolvedActions || []).map(describeAction);
  bumpContextRevision();
}

function tagsLabel(item) {
  const tags = item.tags || [];
  return tags.length ? ` [tags: ${tags.join(", ")}]` : "";
}

// ---------- snapshot truncation ----------
//
// A snapshot that lists EVERY plant, tool, routine, to-do and to-get item with
// all of its detail is a few hundred tokens for a small garden and several
// THOUSAND for a real one — on every single request, including "add pumpkin
// seeds to the to-get list". These two helpers cap the LIST while leaving the
// COUNT alone, which is the only way to shrink it without breaking the one
// thing the snapshot exists for: being able to answer "what do I have?"
// correctly. The heading always carries the true total, the cut is always
// announced, and the ordering below decides what survives.

// Pinned first (the user just named it — see findEntityMatches), then most
// urgent/most recently touched by the section's own score, then original order
// as a stable tiebreak. `pinned` is a Set of "kind:id" keys.
function rankSnapshotItems(items, kind, pinned, score) {
  return (items || [])
    .map((item, i) => ({
      item,
      i,
      pin: pinned && pinned.has(`${kind}:${item.id}`) ? 1 : 0,
      s: score ? score(item) || 0 : 0,
    }))
    .sort((a, b) => b.pin - a.pin || b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

// Renders at most `cap` of the ranked items and, when anything was left out,
// says so IN THE MODEL'S TERMS: the number is complete, the list is not, and
// the way to reach an unlisted item is to ask — never to guess an id.
function snapshotList(ranked, cap, render, joiner) {
  const shown = ranked.slice(0, cap);
  const hidden = ranked.length - shown.length;
  const body = shown.map(render).join(joiner);
  if (hidden <= 0) return body;
  return (
    body +
    joiner +
    `… and ${hidden} more not listed here (the count in this heading is the complete, exact ` +
    "total — the LIST is shortened, not the data. If you need one that isn't shown, ask the " +
    "user for it by name; never guess its id)"
  );
}

// Read-only snapshot of the user's data, injected into the system prompt so
// the AI can answer from what is actually stored without any tool-calling
// machinery. Rebuilt from IndexedDB on EVERY request (and every continuation
// round, after the previous round's writes landed) — the heavy framing below
// exists because a model that is merely SHOWN data still tends to trust what
// it remembers saying earlier over what the app actually holds.
//
// opts (all optional — no-arg calls behave exactly as they always did):
//   mode:   "act" → the tight per-section cap; anything else → the generous one
//   pinned: Set of "kind:id" (from entityMatchKeys) that must never be cut
async function buildKnowledgeContext(opts) {
  const mode = (opts && opts.mode) === "act" ? "act" : "chat";
  const cap = mode === "act" ? SNAPSHOT_ITEM_CAP_ACT : SNAPSHOT_ITEM_CAP;
  const pinned = (opts && opts.pinned) || null;
  return buildKnowledgeContextInner(cap, pinned, mode === "chat");
}

// Collapses markdown/whitespace and clips, for one-line prompt summaries.
function clipForPrompt(text, max) {
  const t = String(text || "")
    .replace(/[#*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// productInfo values that are placeholders, not a label reading.
const PRODUCT_INFO_PLACEHOLDER_RE = /^(No product details could be read|Photo saved \(AI analysis unavailable\))/i;
function hasProductInfo(t) {
  return !!(t && t.productInfo && !PRODUCT_INFO_PLACEHOLDER_RE.test(String(t.productInfo).trim()));
}

// `detailed` (chat mode): each tool line also carries its notes and the start
// of its label reading. Without them the model saw "Alpha Plus x1" and nothing
// else, and told the user it couldn't know what Alpha Plus was — while the
// label reading sat in the database one field away.
async function buildKnowledgeContextInner(cap, pinned, detailed = false) {
  const [tools, routines, plants, shopping, todos] = await Promise.all([
    getAllTools(),
    getAllRoutines(),
    getAllPlants(),
    getAllShoppingItems(),
    getAllTodos(),
  ]);

  // Every section is emitted even when empty, with its count in the heading:
  // an omitted section reads as "unknown" to a model (so it falls back to
  // memory), while "Plants (0): none" is a fact it can answer from.
  const parts = [];

  // Every list below is ranked then capped by the two helpers above. The
  // counts in the headings come from the FULL arrays, never from the shortened
  // list — that is what keeps "what do I have?" answerable from a cut snapshot.

  // To-dos: overdue first, then soonest due, then the undated ones.
  const openTodos = todos.filter((t) => !t.done);
  const rankedTodos = rankSnapshotItems(openTodos, "todo", pinned, (t) => {
    const d = todoDueDelta(t.dueDate);
    return d === null ? -1e9 : -d; // most overdue = biggest score; undated last
  });
  parts.push(
    `To-do, one-off tasks (${openTodos.length} open, ${todos.length - openTodos.length} done): ` +
      (openTodos.length
        ? snapshotList(
            rankedTodos,
            cap,
            (t) => {
              const delta = todoDueDelta(t.dueDate);
              // The time is shown when there is one, so the model can see that
              // a reminder already exists for 14:30 (and update it) instead of
              // filing a second to-do for the same thing.
              const time = normalizeDueTime(t.dueTime);
              const at = todoDueAt(t);
              // Overdue by the CLOCK as well as by the calendar: a to-do set
              // for 09:00 today really is late at 15:00, and the snapshot
              // saying otherwise is how the model ends up reassuring the user
              // about something they have already missed.
              const late = delta !== null && (delta < 0 || (at !== null && at <= Date.now()));
              const due = t.dueDate ? `, due ${t.dueDate}${time ? ` ${time}` : ""}${late ? " OVERDUE" : ""}` : "";
              return `id:${t.id} "${t.text}"${due}${t.notes ? ` (${t.notes})` : ""}`;
            },
            ", "
          )
        : "none open")
  );

  // To-get: still-needed items before already-bought ones, newest first.
  const rankedShopping = rankSnapshotItems(shopping, "toget", pinned, (s) =>
    (s.done ? 0 : 1e12) + (s.createdAt || 0)
  );
  parts.push(
    `To-get, shopping (${shopping.length}): ` +
      (shopping.length
        ? snapshotList(
            rankedShopping,
            cap,
            (s) => `id:${s.id} "${s.name}" x${s.quantity}${s.done ? " [BOUGHT]" : " [open]"}`,
            ", "
          )
        : "empty")
  );

  // Tools: most recently used, else most recently added.
  const rankedTools = rankSnapshotItems(tools, "tool", pinned, (t) =>
    Math.max(t.lastUsed || 0, t.createdAt || 0)
  );
  parts.push(
    `Tools/supplies (${tools.length}): ` +
      (tools.length
        ? snapshotList(
            rankedTools,
            cap,
            (t) => {
              const extras = [t.condition, t.location ? `stored: ${t.location}` : "", t.brand]
                .filter(Boolean)
                .join(", ");
              const notes = detailed && t.notes ? ` | notes: ${clipForPrompt(t.notes, 100)}` : "";
              const label = detailed && hasProductInfo(t) ? ` | label: ${clipForPrompt(t.productInfo, 160)}` : "";
              return `id:${t.id} "${t.name}" x${t.quantity}${extras ? ` (${extras})` : ""}${tagsLabel(t)}${notes}${label}`;
            },
            ", "
          )
        : "none")
  );

  // Routines: everything DUE first (that's what a user is most likely to be
  // completing), then longest-since-done.
  const rankedRoutines = rankSnapshotItems(routines, "routine", pinned, (r) =>
    (isRoutineDue(r) ? 1e15 : 0) - (r.lastDone || 0)
  );
  parts.push(
    `Routines (${routines.length}): ` +
      (routines.length
        ? snapshotList(
            rankedRoutines,
            cap,
            (r) => {
              const status = isRoutineDue(r) ? "DUE" : "not due";
              const last = r.lastDone ? new Date(r.lastDone).toLocaleDateString() : "never";
              const link = r.plantId ? `, linked to plant id:${r.plantId}${r.careAction ? ` (${r.careAction})` : ""}` : "";
              return `id:${r.id} "${r.task}" (every ${r.intervalDays}d, last done ${last}, ${status}${link})${tagsLabel(r)}`;
            },
            "; "
          )
        : "none")
  );

  // Plants: most recently touched (watered/fertilized/added) first — the
  // longest lines in the snapshot, so this is where a cap saves the most.
  const rankedPlants = rankSnapshotItems(plants, "plant", pinned, (p) =>
    Math.max(p.lastWatered || 0, p.lastFertilized || 0, p.createdAt || 0)
  );
  parts.push(
    `Plants (${plants.length}):` +
      (plants.length
        ? "\n" +
          snapshotList(
            rankedPlants,
            cap,
            (p) => {
              const w = p.lastWatered ? new Date(p.lastWatered).toLocaleDateString() : "never";
              const f = p.lastFertilized ? new Date(p.lastFertilized).toLocaleDateString() : "never";
              // Latest journal note only, clipped: it is what the user most
              // recently observed, and the whole journal would swamp the budget.
              const j = [...(p.photoHistory || [])].reverse().find((h) => h && h.kind === "journal" && h.analysis);
              const jText = j ? String(j.analysis).replace(/\s+/g, " ").slice(0, 120) : "";
              const journal = j ? ` | latest journal note (${new Date(j.date).toLocaleDateString()}): "${jText}"` : "";
              return `- id:${p.id} "${p.name}" | location: ${p.location || "unknown"} | planted: ${
                p.plantingDate || "unknown"
              } | last watered: ${w} | last fertilized: ${f}${tagsLabel(p)} | notes: ${p.notes || "none"}${journal}`;
            },
            "\n"
          )
        : " none")
  );

  // Confirm mode: proposed changes are sitting in the banner, unwritten.
  if (queuedActionNotes.length) {
    parts.push(
      `NOT SAVED YET (${queuedActionNotes.length}) — you proposed these and the user has not ` +
        "confirmed them, so they are NOT in the data above and have NOT happened: " +
        queuedActionNotes.join("; ") +
        ". Never call them saved; say they are waiting for confirmation."
    );
  }

  return (
    `\n\n=== LIVE GARDEN DATA — read from the app's database just now, ${deviceNow()} (snapshot #${contextRevision}) ===\n` +
    // Scoped to FACTS on purpose. The blanket "overrides everything said
    // earlier" this used to open with is true of values, but a model reads it
    // as "ignore the conversation" and then loses the thread — the other half
    // of the rule now lives in TWO_SOURCE_RULE at the end of the context.
    "AUTHORITATIVE ON FACTS: for what EXISTS and what its current values are, this block overrides " +
    "anything said earlier in this conversation, including your own earlier statements. If something " +
    "is not listed here it does not exist (deleted, or never added — do not resurrect it); where a " +
    'value differs from what was said earlier, this block wins. Answer "what do I have" / "is X on ' +
    'my list" strictly from it, never from memory. It does NOT replace the conversation, which is ' +
    "where the user's intent and your agreements live — use both (see the two-sources rule at the end).\n" +
    "THIS IS ALSO WHAT YOU WORK WITH: when the user mentions something listed here, they mean THIS " +
    "record — update it by id; never file a second copy of it.\n" +
    parts.join("\n") +
    "\n=== END LIVE GARDEN DATA ==="
  );
}

// ---------- entity disambiguation ----------
//
// The user names garden items after real-world brands/words ("Lenovo" the
// fungicide) — a model asked "how much lenovo do I have?" tends to answer
// about the laptop company because that prior is much stronger than a fact
// buried in a data dump it was merely shown. buildEntityHints scans the
// user's latest message for words that match something the user actually
// owns and returns a short, loud block telling the model to resolve to THAT
// item — see buildContextMessages/buildChatVisionPrompt for where it lands.

// Generic gardening words that would fire on nearly every message if matched
// as a whole item name ("Buy soil" turning every "soil" into a hint would be
// noise, not signal) — but they're fine as PART of a longer, more specific
// name ("tomato fertilizer" still matches). False positives here cost more
// than the rare miss, so keep this list small and only skip WHOLE-name hits.
const ENTITY_HINT_STOPWORDS = new Set([
  "water", "soil", "seeds", "seed", "plant", "plants", "garden",
  "tool", "tools", "pot", "food", "spray", "fertilizer", "compost", "mulch",
]);

// True only on a real word boundary, with an optional trailing "s" so simple
// plurals ("mints", "roses") still match a singular item name without a full
// stemmer. Lookaround (not \b) because item names can contain spaces/symbols
// ("Tomato #1", "neem oil") where \b's word-char definition would misfire
// mid-phrase. The caller is responsible for escaping `phrase`.
function entityHintMatches(haystack, escapedPhrase) {
  const re = new RegExp(`(?<![a-z0-9])${escapedPhrase}s?(?![a-z0-9])`, "i");
  return re.test(haystack);
}

// Records that `word` matched `entry`, deduping so the SAME item pushed twice
// (e.g. via both its full name and its first word) only appears once, while
// two DIFFERENT items matching the same word both stay — that's the ambiguous
// case buildEntityHints has to flag.
function pushEntityHit(hits, word, entry) {
  const list = hits.get(word) || [];
  if (!list.some((e) => e.kind === entry.kind && e.id === entry.id)) list.push(entry);
  hits.set(word, list);
}

// Scans `text` (the user's latest message, or a photo caption) for names that
// exist in THIS user's own data. Returns the matches as DATA —
// [{ word, entries: [{kind, id, name, label, detail}] }], newest-first by
// specificity — or [] when nothing matches.
//
// Split out of buildEntityHints (which now just formats what this returns) so
// there is ONE name-matching implementation with two consumers: the hint block
// below, and buildKnowledgeContext's snapshot truncation, which uses these same
// matches to PIN whatever the user just named so a cap can never cut it out.
// Two matchers would eventually disagree, and the way they'd disagree is
// "Sprout can't see the thing you just asked about".
//
// Wrapped in try/catch: a weirdly-named item (regex metacharacters) must never
// be able to break chat.
async function findEntityMatches(text) {
  const msg = (text || "").toLowerCase();
  if (!msg.trim()) return [];
  try {
    // One batch, one read each — mirrors buildKnowledgeContext's Promise.all
    // so this never doubles the IndexedDB traffic of an ordinary turn.
    const [plants, tools, routines, todos, shopping, codex] = await Promise.all([
      getAllPlants(),
      getAllTools(),
      getAllRoutines(),
      getAllTodos(),
      getAllShoppingItems(),
      getAllCodexEntries(),
    ]);

    // Flatten every source into one shape, carrying the disambiguating detail
    // (quantity/tags, location, due date, interval) the model would otherwise
    // have to re-derive from the full snapshot.
    const candidates = [];
    for (const p of plants) {
      candidates.push({
        kind: "plant", id: p.id, name: p.name, label: "PLANT",
        detail: p.location ? `location: ${p.location}` : "",
      });
    }
    for (const t of tools) {
      const tags = (t.tags || []).join("/");
      candidates.push({
        kind: "tool", id: t.id, name: t.name, label: "INVENTORY item",
        detail: `x${t.quantity ?? 1}${tags ? `, ${tags}` : ""}`,
      });
    }
    for (const r of routines) {
      candidates.push({
        kind: "routine", id: r.id, name: r.task, label: "ROUTINE",
        detail: `every ${r.intervalDays}d`,
      });
    }
    for (const td of todos) {
      if (td.done) continue; // a finished to-do isn't a live thing to disambiguate to
      candidates.push({
        kind: "todo", id: td.id, name: td.text, label: "TO-DO",
        detail: td.dueDate ? `due ${td.dueDate}${normalizeDueTime(td.dueTime) ? ` ${normalizeDueTime(td.dueTime)}` : ""}` : "",
      });
    }
    for (const s of shopping) {
      candidates.push({
        kind: "toget", id: s.id, name: s.name, label: "TO-GET item",
        detail: s.done ? "already bought" : `x${s.quantity ?? 1}, on shopping list`,
      });
    }
    for (const c of codex) {
      const nm = c.itemName || c.title;
      if (!nm) continue;
      candidates.push({ kind: "codex", id: c.id, name: nm, label: "saved CODEX entry", detail: "" });
    }

    // hits: matched surface word -> [{candidate}] — keying by the matched WORD
    // (not the item) is what turns "two items share this word" into one
    // ambiguous line instead of two separate confident-sounding hints.
    const hits = new Map();
    for (const c of candidates) {
      const clean = (c.name || "").trim().replace(/^["'.,!?;:]+|["'.,!?;:]+$/g, "");
      if (!clean) continue;
      const lower = clean.toLowerCase().replace(/\s+/g, " ");
      if (lower.length < 3) continue; // too short to be a meaningful signal
      const words = lower.split(" ");
      const wholeIsStopword = words.length === 1 && ENTITY_HINT_STOPWORDS.has(lower);
      const entry = { ...c, name: clean };

      if (!wholeIsStopword) {
        const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (entityHintMatches(msg, escaped)) pushEntityHit(hits, lower, entry);
      }
      // Multi-word names also match on their first significant word, so a
      // tool literally named "Lenovo 500SC" is still found when the user just
      // says "lenovo" — gated to ≥4 chars / non-stopword so short leading
      // words ("the", "buy") can't turn into noisy matches.
      if (words.length > 1) {
        const first = words[0];
        if (first.length >= 4 && !ENTITY_HINT_STOPWORDS.has(first)) {
          const escapedFirst = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (entityHintMatches(msg, escapedFirst)) pushEntityHit(hits, first, entry);
        }
      }
    }
    if (hits.size === 0) return [];

    // Longest matched word first = most specific / least likely coincidental;
    // cap at 6 so this can never balloon into a token sink on a busy garden.
    return [...hits.keys()]
      .sort((a, b) => b.length - a.length)
      .slice(0, 6)
      .map((word) => ({ word, entries: hits.get(word) }));
  } catch (e) {
    console.error("findEntityMatches failed:", e && e.message);
    return [];
  }
}

// The matches above, as the compact system-prompt block that actually ships —
// or "" when nothing matched, a deliberate no-op (zero extra tokens) that keeps
// this feature free for every message that doesn't need it.
function formatEntityHints(matches) {
  if (!matches || !matches.length) return "";
  const lines = matches.map(({ word, entries }) => {
    const phrases = entries.map((e) => {
      const detail = e.detail ? ` (${e.detail})` : "";
      return `their ${e.label} id:${e.id} "${e.name}"${detail}`;
    });
    const ambiguous = phrases.length > 1;
    return (
      `- "${word}" → ${phrases.join(" OR ")}` +
      (ambiguous ? " — ask which one is meant if your answer would differ" : "")
    );
  });

  return (
    "\n\n=== NAME MATCHES IN THE USER'S MESSAGE ===\n" +
    "The user's latest message mentions names that exist in THEIR garden data. In this app " +
    "those words mean the user's own item below — NOT a real-world company, brand, celebrity, " +
    "or place that happens to share the name. For a product-type item, general knowledge ABOUT " +
    "THE PRODUCT ITSELF (active ingredient, dosage, safety) is still exactly what to give — this " +
    "rule only stops you from confusing the item's IDENTITY with an unrelated same-named entity.\n" +
    lines.join("\n") +
    "\nException: if the user is clearly asking about the outside entity itself (its stock price, " +
    "its CEO, who makes it as a company) rather than their item, you may briefly answer that instead.\n" +
    "=== END NAME MATCHES ==="
  );
}

// Unchanged signature and unchanged output — text in, hint block (or "") out.
// Every existing caller (buildContextMessages, buildChatVisionPrompt, the
// tests) keeps working exactly as before; it is just no longer the only way to
// get at the matches.
async function buildEntityHints(text) {
  return formatEntityHints(await findEntityMatches(text));
}

// ---------- WHAT YOU ALREADY KNOW: saved label readings + Codex, per turn ----------
//
// The Codex auto-researches every item, and photos of labels are stored as
// productInfo — but none of it ever reached the chat model, which then asked
// the user for the label again. This block carries the FULL saved knowledge
// for the items the recent conversation is about, plus (for a spraying/dosing/
// pest question) every product in the inventory, so "see what we have in the
// armory" can actually be answered.
const REFERENCE_CARE_RE =
  /\b(spray\w*|dos(e|es|age|ing)|dilut\w*|mix(ing)?|rates?|pests?|mites?|aphids?|whitefl\w*|fung\w*|mildew|mold|mould|insect\w*|fertili[sz]\w*|feed(ing)?|treat\w*|armou?ry|inventory|products?|bottle|label|ml|litres?|liters?|how much)\b/i;
const REFERENCE_BLOCK_MAX_CHARS = 7000;
const REFERENCE_ITEM_MAX_CHARS = 1400;

async function buildReferenceBlock(history) {
  try {
    const users = (history || []).filter((m) => m && m.role === "user").slice(-3);
    const text = users.map((m) => m.text || "").join("\n");
    if (!text.trim()) return "";
    const [matches, tools, plants, codex] = await Promise.all([
      findEntityMatches(text),
      getAllTools(),
      getAllPlants(),
      getAllCodexEntries(),
    ]);
    const keys = entityMatchKeys(matches);
    const norm = (x) => String(x || "").trim().toLowerCase();
    const codexFor = (name) =>
      codex.find((c) => norm(c.itemName) === norm(name)) || codex.find((c) => norm(c.title) === norm(name));

    const pickedTools = tools.filter((t) => keys.has(`tool:${t.id}`));
    if (REFERENCE_CARE_RE.test(text)) {
      for (const t of tools) {
        if (pickedTools.includes(t)) continue;
        const productish =
          hasProductInfo(t) ||
          (t.tags || []).some((g) => /pesticide|fertili[sz]er|fungicide|insecticide|consumable/i.test(g));
        if (productish) pickedTools.push(t);
      }
    }
    const pickedPlants = plants.filter((p) => keys.has(`plant:${p.id}`));
    const pickedCodex = codex.filter((c) => keys.has(`codex:${c.id}`));

    const blocks = [];
    const usedCodex = new Set();
    for (const t of pickedTools) {
      const lines = [`INVENTORY id:${t.id} "${t.name}"${t.brand ? ` — brand: ${t.brand}` : ""}`];
      if (hasProductInfo(t)) lines.push(`  saved label reading: ${clipForPrompt(t.productInfo, REFERENCE_ITEM_MAX_CHARS)}`);
      if (t.notes) lines.push(`  notes: ${clipForPrompt(t.notes, 300)}`);
      const c = codexFor(t.name);
      if (c) {
        usedCodex.add(c.id);
        lines.push(`  Codex: ${clipForPrompt(c.body, REFERENCE_ITEM_MAX_CHARS)}`);
      }
      if (lines.length > 1) blocks.push(lines.join("\n"));
    }
    for (const p of pickedPlants) {
      const c = codexFor(p.name);
      if (!c) continue;
      usedCodex.add(c.id);
      blocks.push(`PLANT id:${p.id} "${p.name}"\n  Codex: ${clipForPrompt(c.body, 900)}`);
    }
    for (const c of pickedCodex) {
      if (usedCodex.has(c.id)) continue;
      blocks.push(`CODEX "${c.title || c.itemName}"\n  ${clipForPrompt(c.body, REFERENCE_ITEM_MAX_CHARS)}`);
    }
    if (!blocks.length) return "";

    let body = "";
    let dropped = 0;
    for (const b of blocks) {
      if (body.length + b.length > REFERENCE_BLOCK_MAX_CHARS) {
        dropped++;
        continue;
      }
      body += (body ? "\n" : "") + b;
    }
    return (
      "\n\n=== WHAT YOU ALREADY KNOW about the items in this conversation (saved label readings from " +
      "the user's own photos, and Codex research) ===\n" +
      body +
      (dropped ? `\n(${dropped} more item(s) not shown for space.)` : "") +
      "\nUse this FIRST — before searching and before asking the user anything. If it answers the " +
      "question, answer from it and say so.\n=== END WHAT YOU ALREADY KNOW ==="
    );
  } catch (e) {
    console.error("buildReferenceBlock failed:", e && e.message);
    return "";
  }
}

// "kind:id" keys for every item the user's message named — the set
// buildKnowledgeContext pins to the front of its lists so truncation can never
// drop the one thing the request is about.
function entityMatchKeys(matches) {
  const keys = new Set();
  for (const m of matches || []) {
    for (const e of m.entries || []) keys.add(`${e.kind}:${e.id}`);
  }
  return keys;
}

// The same snapshot, one line, for the USER — so "what can Sprout actually see
// right now?" is answerable in the UI (the refresh button in the chat header)
// and not just inside the prompt.
async function buildContextSummary() {
  const [tools, routines, plants, shopping, todos] = await Promise.all([
    getAllTools(),
    getAllRoutines(),
    getAllPlants(),
    getAllShoppingItems(),
    getAllTodos(),
  ]);
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const summary = [
    n(plants.length, "plant", "plants"),
    n(tools.length, "item", "items"),
    n(routines.length, "routine", "routines"),
    n(todos.filter((t) => !t.done).length, "to-do", "to-dos"),
    n(shopping.filter((s) => !s.done).length, "to-get", "to-get"),
  ].join(" · ");
  return queuedActionNotes.length
    ? `${summary} — plus ${queuedActionNotes.length} change(s) waiting for your confirmation`
    : summary;
}

// The write-back conventions are ALWAYS included (previously they were only
// sent once the user had data, which meant the AI could never add the FIRST
// plant/tool via chat).
const ACTION_CONVENTIONS =
  "\n\n## CHANGING THE APP'S DATA (critical)\n" +
  // Names every module the closed-set block below enumerates — an intro that
  // listed only three of them read as "and presumably others exist too",
  // which is the exact gap this whole section is here to close.
  "You are connected to the user's garden app (Garden, Inventory, Routines, To-do, To-get). The " +
  "ONLY way you can create or change anything in those modules is by emitting action lines. Saying " +
  '"I\'ve added it" without an action line saves NOTHING — if you claim a change, you MUST emit ' +
  "the matching line(s).\n" +
  "An action line is one single line — the keyword, a colon, then its complete JSON on that " +
  "same line — placed at the very end of your reply, after your visible text. Emit SEVERAL " +
  "action lines (one per line) when the user mentions several changes in one message. The app " +
  "strips these lines before display; the user never sees them, so never mention or explain them.\n" +
  // The other half of the duplicate problem: not "wrong record" but "record
  // that could never exist". Models offered a write channel invent modules to
  // write to (ADD_BED, LOG_HARVEST, SET_REMINDER), invent ids, and invent
  // columns — and every one of those is a SILENT failure: the app ignores the
  // line, the model still says "done!", and the user only finds out later that
  // nothing was saved. Stated as a closed set, up front, with the consequence
  // spelled out. Code guards back all three up (ACTION_START_RE ignores
  // unknown verbs, handleAiActions reports unresolvable ids, and
  // sanitizeActionFields strips invented columns before any write).
  "WHAT THIS APP ACTUALLY HAS — a CLOSED SET (the most important limit on you):\n" +
  "There are exactly seven places anything can be saved, and no others: 1. PLANTS (the Garden) · " +
  "2. TOOLS & SUPPLIES (the Inventory) · 3. ROUTINES (recurring care tasks) · 4. TO-DOS (one-off " +
  "tasks) · 5. THE TO-GET LIST (shopping) · 6. PHOTOS (a gallery + one cover picture per item) · " +
  "7. CODEX ENTRIES (reference articles: the app researches one for every new item, and YOU save " +
  "what you research with SAVE_CODEX).\n" +
  "That is the entire app. There are NO beds, zones, plots, rows, greenhouses, harvest logs, yield " +
  "trackers, seed banks, plant groups, watering schedules as such, or tag modules — and no action " +
  "line exists for any of them. (The Calendar screen and each plant's journal only DISPLAY data: a " +
  "dated to-do or a routine appears in the calendar by itself, and journal notes are written by the " +
  "user.) The complete list of keywords you may EVER " +
  "emit is the FORMULAS list directly below; a keyword outside that list is not a feature you " +
  "haven't used yet, it does literally nothing.\n" +
  // ONE CORRECTED FACT, not a loosened rule. Real Web Push now ships (the
  // user's VPS delivers notifications with the app closed), so the old blanket
  // "there are no reminders or alerts" was making the model refuse a request
  // the app can genuinely serve — the anti-hallucination discipline was right,
  // the fact underneath it had gone stale. A reminder is still not a MODULE:
  // it is a to-do with a date, and saying exactly that is what keeps the
  // closed set closed while making the refusal stop.
  "REMINDERS DO EXIST — AND A REMINDER IS A TO-DO. A to-do with a \"dueDate\" (and, for a specific " +
  "clock time, a \"dueTime\") is delivered to the user's phone as a notification at that moment, " +
  "even with the app closed. So \"remind me to water the ficus on Saturday\", \"remind me in 20 " +
  "minutes\" and \"nudge me at 7 tomorrow morning\" are ordinary ADD_TODO requests — serve them, and " +
  "never tell the user this app can't do reminders.\n" +
  "What still does NOT exist, and never gets invented: no separate reminders module and nothing " +
  "to write into the calendar; no repeating alarm at an arbitrary clock time (a task that RECURS is a ROUTINE, which " +
  "notifies on its own interval at the user's daily reminder hour, not at a time you pick); and no " +
  "way to notify about anything that is not a to-do or a due routine — there is no alert to put on " +
  "a plant, a photo, a to-get item or a note. There is still no SET_REMINDER keyword: the action " +
  "line is ADD_TODO.\n" +
  "Be honest about delivery: notifications only arrive if the user has switched them on in " +
  "Settings, and you cannot see whether they have. Say what you SET (\"set for 14:30\"), never " +
  "promise it will arrive — and it lands within about a minute of its time, so it is a reminder, " +
  "not a stopwatch.\n" +
  "If the user asks for something the app has no place for, say so plainly in one sentence, offer " +
  "the nearest real fit, and emit NO action line. Example: \"There's no harvest log in the app — I " +
  'can put the weight in the plant\'s notes, or add a to-do to weigh the next pick. Which would you ' +
  'prefer?" Never invent a place to put it and never imply you saved it somewhere.\n' +
  "NEVER INVENT AN ID: every id you use must appear verbatim in the LIVE GARDEN DATA block above. " +
  "If the thing you want to change isn't in that block it does not exist — ask the user, or ADD_* " +
  "it. Do not aim an UPDATE_*/REMOVE_*/COMPLETE_* at a number you guessed or remembered: the app " +
  'discards it, so your "done!" would be a lie the user discovers days later.\n' +
  "NEVER INVENT A FIELD: use only the field names in the formulas below. The app throws away every " +
  'other key, so "soilPh", "sunlight", "harvestedOn", "waterAmount" and friends save NOTHING — put ' +
  'that information in "notes", where it will actually persist.\n' +
  "FORMULAS (copy these shapes exactly):\n" +
  'ADD_PLANT: {"fields": {"name": "...", "location": "...", "plantingDate": "YYYY-MM-DD", "notes": "...", "tags": ["..."]}}\n' +
  'UPDATE_PLANT: {"id": <plant id>, "fields": {"lastWatered": "YYYY-MM-DD", "lastFertilized": "YYYY-MM-DD", "name": "...", "location": "...", "notes": "...", "tags": ["..."]}}\n' +
  'REMOVE_PLANT: {"id": <plant id>} — a routine linked to it survives, unlinked\n' +
  'ADD_TOOL: {"fields": {"name": "...", "quantity": 1, "notes": "...", "tags": ["..."], "brand": "...", "condition": "new|good|worn|needs repair", "location": "...", "purchaseDate": "YYYY-MM-DD", "price": 0}}\n' +
  'UPDATE_TOOL: {"id": <tool id>, "fields": {"quantity": 2, "notes": "...", "tags": ["..."], "brand": "...", "condition": "...", "location": "...", "lastUsed": "YYYY-MM-DD", "price": 0, "productInfo": "..."}} — "productInfo" is the item\'s product sheet (type, active ingredient, rates per litre, how to apply, safety); it REPLACES the old one, so keep what was right and add what you learned\n' +
  'REMOVE_TOOL: {"id": <tool id>}\n' +
  'SAVE_CODEX: {"fields": {"title": "...", "body": "...", "sources": ["https://..."], "itemName": "..."}} — saves a reference note to the Codex (saved immediately, no confirmation). "title" = the product/plant/topic; "body" = the facts, compact, markdown ok; "sources" = real URLs you used, or []; "itemName" = the exact name of their inventory item or plant it is about, if any. Saving the same title again replaces the old note.\n' +
  'ADD_ROUTINE: {"fields": {"task": "...", "intervalDays": 3, "plantId": <plant id>, "careAction": "water", "tags": ["..."]}}\n' +
  'UPDATE_ROUTINE: {"id": <routine id>, "fields": {"task": "...", "intervalDays": 5, "tags": ["..."]}}\n' +
  'COMPLETE_ROUTINE: {"id": <routine id>}\n' +
  'REMOVE_ROUTINE: {"id": <routine id>} — deletes the recurring task itself (use COMPLETE_ROUTINE if they just did it this time)\n' +
  'ATTACH_PHOTO: {"plantId": <plant id>, "photoId": <optional N from "[shared photo #N]" — omit for the newest photo in this chat>}\n' +
  'SET_COVER: {"target": "plant"|"tool"|"routine", "id": <item id>, "photoId": <optional, as above>} — makes a chat photo the item\'s cover picture\n' +
  'ADD_TOGET: {"fields": {"name": "...", "quantity": 1, "notes": "..."}} — puts something on the to-get (shopping) list\n' +
  'UPDATE_TOGET: {"id": <to-get id>, "fields": {"done": true, "quantity": 2, "name": "..."}}\n' +
  'REMOVE_TOGET: {"id": <to-get id>}\n' +
  'ADD_TODO: {"fields": {"text": "...", "dueDate": "YYYY-MM-DD", "dueTime": "HH:MM", "notes": "..."}} — a one-off task on the to-do list, and ALSO how you set a reminder. dueDate/dueTime/notes are all optional; "dueTime" is 24-hour device-local and only means anything alongside a dueDate\n' +
  'UPDATE_TODO: {"id": <to-do id>, "fields": {"text": "...", "dueDate": "YYYY-MM-DD", "dueTime": "HH:MM", "notes": "..."}} — send "dueTime": "" to take a time back off a to-do\n' +
  'COMPLETE_TODO: {"id": <to-do id>} — ticks a to-do off\n' +
  'REMOVE_TODO: {"id": <to-do id>}\n' +
  "WORKED EXAMPLES:\n" +
  'User says: "I bought 2 bags of tomato fertilizer and planted mint in the balcony pot" — ' +
  "your reply chats normally, then ends with these two lines:\n" +
  'ADD_TOOL: {"fields": {"name": "Tomato fertilizer", "quantity": 2, "tags": ["fertilizer", "consumable"]}}\n' +
  'ADD_PLANT: {"fields": {"name": "Mint", "location": "balcony pot", "tags": ["herb", "outdoor"]}}\n' +
  'User says: "add a note to the basil: it looked droopy this morning" (basil is id:4 with notes "from a cutting") — your reply ends with:\n' +
  'UPDATE_PLANT: {"id": 4, "fields": {"notes": "from a cutting; looked droopy this morning"}}\n' +
  'User sends a photo and says "add this picture to the basil" (basil is id:4) — your reply ends with:\n' +
  'ATTACH_PHOTO: {"plantId": 4}\n' +
  'User says: "remind me to prune the roses this weekend" (today is Thursday 2026-08-06) — your reply ends with:\n' +
  'ADD_TODO: {"fields": {"text": "Prune the roses", "dueDate": "2026-08-08"}}\n' +
  // The device's current date AND time ride in the LIVE GARDEN DATA header
  // (see deviceNow), so a relative request is arithmetic the model can
  // actually do — and these examples exist because it will only do it if it
  // knows the clock is there. "5 minutes" is the case that used to be refused.
  "TIMED REMINDERS — do the arithmetic on the device clock you were given in the LIVE GARDEN DATA " +
  "header (it carries the current date AND time), never on a guessed or remembered one:\n" +
  'User says: "send me a reminder in 5 minutes to check the seedlings" (device clock: Tuesday 25 August 2026, 14:25) — 14:25 + 5 min:\n' +
  'ADD_TODO: {"fields": {"text": "Check the seedlings", "dueDate": "2026-08-25", "dueTime": "14:30"}}\n' +
  'User says: "remind me to water the ficus tomorrow at 7" (device clock: Tuesday 25 August 2026, 21:10) — a bare "7" reads as the morning; say which you picked so a wrong guess is cheap to fix:\n' +
  'ADD_TODO: {"fields": {"text": "Water the ficus", "dueDate": "2026-08-26", "dueTime": "07:00"}}\n' +
  'User says: "remind me to sow the beans Saturday morning" (device clock: Tuesday 25 August 2026) — turn a vague part of the day into ONE concrete time and name it in your visible text ("Saturday at 9am"):\n' +
  'ADD_TODO: {"fields": {"text": "Sow the beans", "dueDate": "2026-08-29", "dueTime": "09:00"}}\n' +
  'User says: "add repotting the mint to my list for Saturday" — no time was asked for, so send NO dueTime; it simply nudges them that day:\n' +
  'ADD_TODO: {"fields": {"text": "Repot the mint", "dueDate": "2026-08-29"}}\n' +
  // The single most damaging failure mode in practice: the user talks about
  // something they already own and the model files it as a NEW item, so the
  // garden slowly fills with duplicate basils. Stated as its own headed
  // section (not a bullet) because it has to survive being one rule among
  // twenty. A code-level guard backs it up — see guardDuplicateAdd.
  "WORK WITH WHAT THEY ALREADY HAVE (the mistake to avoid above all others):\n" +
  "The LIVE GARDEN DATA block above is the inventory of everything that EXISTS. Before any ADD_*, " +
  "look for the thing there. If it is listed, the user is talking about THAT record — emit UPDATE_* " +
  "with its id. ADD_* is only for something genuinely not in the snapshot.\n" +
  'WRONG — user says "the basil is looking yellow" and Plants already lists id:4 "Basil":\n' +
  'ADD_PLANT: {"fields": {"name": "Basil"}}  ← this gives them two basils\n' +
  'RIGHT: UPDATE_PLANT: {"id": 4, "fields": {"notes": "leaves yellowing"}}\n' +
  "Same everywhere: more of a tool they own → UPDATE_TOOL its quantity, not ADD_TOOL; a routine, " +
  "to-do or to-get already on the list → UPDATE_* it. A genuinely SEPARATE second specimen IS a " +
  'real ADD_PLANT — but then give it a distinguishing name or location ("Basil (kitchen)") and say ' +
  "in your visible text that it is a second one. If the wording could mean the existing item OR a " +
  "new one, ASK which and emit no action line.\n" +
  // Deletion is the only irreversible thing in the app, and the failure modes
  // are specific rather than general: models reach for REMOVE+ADD to change a
  // value, and for REMOVE to "clean up" a duplicate they think they see. Both
  // destroy a record the user never asked to lose, so both are named here
  // explicitly. Code backs this up — every REMOVE_* is queued for an explicit
  // confirmation regardless of write mode (see isDestructiveAction).
  "DELETING (REMOVE_PLANT / REMOVE_TOOL / REMOVE_ROUTINE / REMOVE_TODO / REMOVE_TOGET) — the only " +
  "thing you can do that cannot be undone. It destroys the record and everything attached to it (a " +
  "plant takes its photos and its whole care log with it):\n" +
  '- Only when the user clearly asked to delete THAT specific thing ("delete the mint"). Never as ' +
  "tidying up, never inferred.\n" +
  '- A REWRITE IS NOT A DELETE: "rename the mint to spearmint", "it\'s on the balcony now", "make ' +
  'that 3 bags" are UPDATE_* on the existing id. Never REMOVE_* + ADD_* to change a value — that ' +
  "throws away the item's photos, history and dates.\n" +
  "- NEVER DELETE TO RESOLVE A DUPLICATE: say you think it's listed twice and ask which to keep.\n" +
  '- AMBIGUOUS WORDING GETS A QUESTION: "get rid of the basil" — the plant, the to-do about it, or ' +
  "the to-get entry? Ask, and emit no action line at all.\n" +
  "- Every deletion is SHOWN TO THE USER to confirm before anything is removed, even with automatic " +
  'saving on — so describe it as still to come ("I\'ll delete the mint — confirm below"), never as ' +
  "already done.\n" +
  "RULES:\n" +
  "- NEVER CLAIM MORE THAN YOU DID: your visible text may only describe changes you actually " +
  'emitted an action line for, into modules that actually exist. Never say you "logged the ' +
  'harvest", "added it to the calendar" or "created a bed" — there is nowhere for any of those to ' +
  'go, so saying it is simply false. "I\'ve set a reminder" IS sayable now, but ONLY when you ' +
  "emitted the ADD_TODO/UPDATE_TODO carrying the date (and time) you named — a reminder claimed " +
  "with no action line beside it is exactly the same lie as the rest.\n" +
  "- ACT IN THIS REPLY: the action line(s) go at the end of THIS message — act first, then your " +
  'visible text confirms it. Never "I\'ll add it" or "Added!" without the line beside it, never ' +
  "deferred to a later turn. Claiming a change with no action line is a failure.\n" +
  "- ALWAYS act on explicit commands — add, remove, update, note, log, track, remember — with the matching action line(s).\n" +
  '- Photos the user sent in this chat appear as "[shared photo #N]". You CAN put them in a ' +
  "plant's gallery with ATTACH_PHOTO and make them the cover of any plant/tool/routine with " +
  'SET_COVER — the app holds the image. NEVER say a photo "wasn\'t uploaded", that you ' +
  '"can\'t access it", or that you "need a URL". A clear photo of an item with no picture yet ' +
  "may be SET_COVER'd proactively (mention that you did).\n" +
  '- "notes" REPLACES the old notes: to add a note, repeat the existing notes and append the new one (see example).\n' +
  "- Use real ids from the garden data above — never a guessed, remembered or sequential one. Only " +
  "include fields that actually change, and only field names that appear in the formulas. Never " +
  "leave <placeholders> in the JSON.\n" +
  "- Dates: use the device date given above. When the user watered/fertilized a plant: UPDATE_PLANT with that date, plus COMPLETE_ROUTINE if a matching routine exists.\n" +
  '- Times: "dueTime" is 24-hour device-local ("07:00", "14:30") and goes on a to-do ONLY when the ' +
  'user gave a time or a delay ("at 6", "in 20 minutes", "tomorrow morning"). A plain "on Saturday" ' +
  "is a dueDate with NO dueTime — never invent a clock time nobody asked for. Work \"in N minutes/" +
  'hours" out from the device clock in the snapshot header, and when that crosses midnight move the ' +
  "dueDate on with it.\n" +
  '- ADD_ROUTINE: "plantId" + "careAction" ("water"/"fertilize") are optional — set them when the routine cares for one specific plant, so completing it also updates that plant.\n' +
  "- Tag new items with 1-3 tags. Presets — plants: " +
  PRESET_TAGS.plants.join("/") +
  "; tools: " +
  PRESET_TAGS.tools.join("/") +
  "; routines: " +
  PRESET_TAGS.routines.join("/") +
  ". Invent a short lowercase tag only when none fit.\n" +
  "- Unsure which item they mean, or whether they want a change at all? Ask one short question in your visible reply and emit no action line for it.\n" +
  '- To-get list: "I need to buy X" / "remind me to get X" → ADD_TOGET. When the user says ' +
  "they BOUGHT something that's on the list: UPDATE_TOGET with done true AND ADD_TOOL so it " +
  "lands in their inventory.\n" +
  "- THREE DIFFERENT LISTS, pick the right one: a TO-DO is a one-off task to DO once " +
  '("prune the roses", "repot the mint Saturday") → ADD_TODO; a TO-GET is something to BUY ' +
  '("more potting soil") → ADD_TOGET; a ROUTINE is a task that RECURS on an interval ' +
  '("water the ficus every 3 days") → ADD_ROUTINE. A one-off nudge at a clock time ' +
  '("remind me at 6 to move the seedlings in") is a TO-DO with a dueTime, NOT a routine — routines ' +
  "have no clock time of their own. When the user finishes a one-off task " +
  '("I pruned the roses"), COMPLETE_TODO it — don\'t add a new one.\n' +
  "- Never invent changes the user didn't ask for, and don't re-emit an action already applied " +
  "earlier in the conversation. BUT when the user explicitly asks you to create demo/sample/" +
  "example data, that IS a real request — emit one action line per item you create.\n" +
  "- FOLLOW-UP SUGGESTIONS (optional): after any action lines and BEFORE the STATUS line, exactly " +
  'ONE line: FOLLOWUP: ["item 1", "item 2"] — 2-3 short things the USER might send you next, ' +
  "questions OR commands. Each string is inserted verbatim into their input box and sent AS THE " +
  'USER, so write it in THEIR voice: first person ("I"/"my"), addressing you as "you". WRONG ' +
  '(your voice, an offer): "Would you like me to add a watering routine?" RIGHT: "How often ' +
  'should I water it?" / "Add a watering routine for this". Never start with "Would you like", ' +
  '"Shall I", "Do you want", "Should I", "Let me know if". Skip it for trivial confirmations.\n' +
  "- COMPLETION FLAG (mandatory): the VERY LAST line of EVERY reply must be exactly " +
  "STATUS: done — or STATUS: continue if you could not finish everything in this reply " +
  "(too many items, ran out of space). On STATUS: continue the app immediately asks you to " +
  "keep going: emit ONLY the remaining action lines (no repeats), then STATUS: done. " +
  "Never leave a request partially handled without flagging continue.";

// Both the garden snapshot and the chat history are already in the context —
// the failure was never missing data, it was PRECEDENCE. Told only that the
// snapshot is authoritative (as the snapshot header says), a model starts
// answering from the data dump and forgets what was agreed two turns ago;
// told only to follow the conversation, it answers from stale memory. This
// block names both sources, gives each its own jurisdiction, and says which
// wins in the two kinds of conflict. Placed at the END of the context (right
// before ACTION_REMINDER) because that is where models weight hardest — the
// same reason ACTION_REMINDER itself lives there. Also reused, condensed, by
// the photo path in buildChatVisionPrompt.
// Command mode gets the compressed version of the rule below (~40 tokens vs
// ~360). A command still has to resolve "add it to the list" against the
// thread and use real ids from the snapshot — it just doesn't need the full
// reasoning spelled out, and on an ~8k-tokens-per-minute budget the long form
// is a meaningful slice of what's left after the formulas.
const TWO_SOURCE_RULE_ACT =
  "USE BOTH SOURCES: the LIVE GARDEN DATA block is the authority on what exists and its ids; " +
  "this conversation is the authority on what the user means right now (resolve \"it\"/\"that\" " +
  "against the last few turns). If the thing isn't in the snapshot, don't invent an id — ask.";

const TWO_SOURCE_RULE =
  "TWO SOURCES OF TRUTH — you must use BOTH; neither replaces the other:\n" +
  "1. LIVE GARDEN DATA (above) — the authority on WHAT EXISTS and its current values: which items " +
  "the user has, their ids, quantities, locations, dates. It was read from the database moments ago.\n" +
  "2. THIS CONVERSATION — the authority on INTENT: what the user is asking for right now, what the " +
  "two of you already discussed and agreed, what you already did earlier in this thread, and what " +
  "their pronouns point at.\n" +
  "Your answer has to be consistent with BOTH at once. When they genuinely conflict: for a FACT " +
  "about an item (does it exist, what is its value) the snapshot wins, even over something you said " +
  "yourself earlier; for what the user WANTS right now, their latest message wins. If the " +
  "conversation refers to something that is not in the snapshot, it was deleted or never saved — say " +
  "so plainly instead of talking about it as if it were still there.\n" +
  'REFERENCES: resolve "it", "that", "the same one", "the other one" against the recent ' +
  "conversation FIRST, then match what you land on to a real id in the snapshot. If that lands on " +
  "nothing, or on more than one item, ask which one rather than guessing.\n" +
  // Ties the two-source framing to the closed-set rule in ACTION_CONVENTIONS:
  // "use both sources" has to also mean "and nothing outside them". Kept to
  // one sentence-pair so it doesn't restate the closed set itself.
  "NEITHER SOURCE, NO ANSWER: anything about this user's garden that is in neither the snapshot " +
  "nor this conversation is something you do not know — say so, or ask. Never close the gap with " +
  "a plausible-looking id, a remembered value, or a feature this app doesn't have.";

// Short reminder appended AFTER the conversation history — models weight the
// end of the context most, and this is what finally made "add X" reliably act
// in the SAME reply instead of a later one.
const ACTION_REMINDER =
  "REMINDER: answer from the live snapshot AND the conversation above, per the two-sources rule. " +
  "Before adding anything, check the snapshot for it — if it is already there, UPDATE_* that record " +
  "instead of creating a second copy. Also check — does the user's latest message ask to add, update, " +
  "remove, log, note, or track anything (plant, tool, routine, to-do task, to-get/shopping item, " +
  "watering, purchase), to create demo/sample data (allowed — one action line per item), or to attach a " +
  "photo they sent to a plant (ATTACH_PHOTO) or set a cover (SET_COVER — you CAN do these)? " +
  "If yes: end THIS reply with the matching action line(s), exactly per the formulas in your " +
  "instructions — act now, in this reply, never later. If unsure which item they mean, ask " +
  "instead and emit nothing. If a change was already applied earlier in the conversation, " +
  "don't re-emit it. " +
  "STAY INSIDE THE APP: plants, tools/supplies, routines, to-dos, the to-get list and photos are " +
  "the only things that exist — there is no bed, greenhouse or harvest log, and nothing to write into the calendar, " +
  "and no action keyword for one. A REMINDER is not a module either — it IS a to-do: \"remind me to " +
  "X on Saturday / in 20 minutes / at 7 tomorrow\" is ADD_TODO with a dueDate, plus \"dueTime\": " +
  "\"HH:MM\" (24h) for a clock time, computed from the device clock in the snapshot header. Never " +
  "refuse it, and never invent a keyword for it. Use only ids that literally appear in the snapshot and " +
  "only the field names from the formulas; if the target isn't in the snapshot, ask instead of " +
  "inventing an id, and never describe a change you didn't emit a line for. " +
  'Optionally, one line before the end: FOLLOWUP: ["…", "…"] — 2-3 items in the USER\'s voice, ' +
  'never offers like "Would you like me to…". ' +
  "Finally: your very last line must be STATUS: done, or STATUS: continue if work remains.";

// Injected on automatic continuation rounds (previous reply flagged
// STATUS: continue) — keeps the model finishing instead of repeating.
const CONTINUE_NUDGE =
  "Your previous reply flagged STATUS: continue — the request is NOT finished. Continue NOW: " +
  "emit ONLY the remaining action lines (never repeat ones already emitted), keep the visible " +
  "text to one short sentence, and end with STATUS: done when everything is complete " +
  "(or STATUS: continue if there is still more).";

// Client-side intent router (user request: "thinking models for questions,
// acting models for acting"). Command-looking messages take the FAST chain
// server-side ("act" — small non-thinking models, near-instant); everything
// else takes the SMART chain ("chat" — thinking models). A misroute only
// affects speed/depth, never correctness: every chain gets the same prompt
// and every model can emit actions.
const ACT_INTENT_RE =
  /\b(add|adds|added|remove|removed|delete|deleted|update|updated|log|logged|track|note|noted|mark|marked|rename|renamed|set|save|saved|attach|attached|complete|completed|done|water|watered|fertilize|fertilized|bought|purchased|used up|demo data|sample data)\b/i;

// A message only takes the fast "act" chain when it looks like a command AND
// isn't a question — "did you add the basil?" is a question about a command,
// and deserves the smart chain (this was too trigger-happy before).
function detectChatMode(text) {
  const t = text || "";
  return ACT_INTENT_RE.test(t) && !t.includes("?") ? "act" : "chat";
}

// Rough token estimate. chars/4 is the usual English approximation, and it is
// deliberately applied to the string that will ACTUALLY be sent — never to the
// stored record — so a photo message costs its "[shared photo #N]" placeholder
// and not its multi-hundred-KB data URL.
function estimateTokens(text) {
  return Math.ceil(String(text == null ? "" : text).length / 4);
}

// The exact content string buildContextMessages sends for one stored message.
// Defined once so the budget below and the payload below it can never drift
// apart — a budget measured against different text than it ships is worse than
// no budget at all.
function contextMessageContent(m) {
  if (m && m.kind === "image") {
    // The #id lets the model reference a specific photo in ATTACH_PHOTO.
    return m.role === "user" ? `[shared photo #${m.id}] ${m.text || ""}` : m.text || "";
  }
  return (m && m.text) || "";
}

// Newest-first walk that keeps as much conversation as the budget allows:
//   - FLOOR:   the newest CONTEXT_MIN_MESSAGES always survive, even when they
//              alone blow the budget. One pasted wall of text must not be able
//              to leave the model with nothing but the current question.
//   - BUDGET:  past the floor, keep taking older messages while they still fit
//              inside CONTEXT_TOKEN_BUDGET.
//   - CEILING: never more than CONTEXT_MESSAGE_CAP messages however tiny they
//              are, so a thread of thousands of one-word turns still produces a
//              request of sane shape.
// Returns the slice in chronological order (same as history.slice(-n) did).
// `act` picks the tight command-mode floor/ceiling to go with the tight budget.
// All three have to move together: a 900-token budget with the 12-message floor
// would still admit 12 long messages and blow straight past it.
function sliceContextHistory(history, budget, act) {
  const all = history || [];
  const cap = budget == null ? CONTEXT_TOKEN_BUDGET : budget;
  const floor = act ? CONTEXT_MIN_MESSAGES_ACT : CONTEXT_MIN_MESSAGES;
  const ceiling = act ? CONTEXT_MESSAGE_CAP_ACT : CONTEXT_MESSAGE_CAP;
  let used = 0;
  let kept = 0;
  for (let i = all.length - 1; i >= 0 && kept < ceiling; i--) {
    const cost = estimateTokens(contextMessageContent(all[i]));
    // The floor is checked BEFORE the budget so nothing can undercut it.
    if (kept >= floor && used + cost > cap) break;
    used += cost;
    kept++;
  }
  return kept >= all.length ? all : all.slice(all.length - kept);
}

// Builds the text-only context array the chat model sees, from stored history.
// `mode` is accepted but no longer changes anything here (the old "call" mode
// is gone — voice input is now dictation into this same typed chat); routing
// still happens server-side via the mode sent to /api/chat.
async function buildContextMessages(history, mode) {
  // WHY act mode is rationed (this is a bug fix, not an optimisation):
  // Groq's free tier meters ~8000 tokens per MINUTE and RESERVES the requested
  // max_tokens up front, so the real ceiling for one command is
  //   prompt + GROQ_MAX_TOKENS_ACT(2048) <= 8000  →  prompt <= ~5900.
  // Sending the full chat payload for "add pumpkin seeds to the to-get list"
  // measured 8475 tokens on its own — over the whole minute's budget before the
  // reply was even counted, which is why every provider in the act chain failed
  // and the app said "AI providers are unavailable". A command needs the real
  // ids and the formulas; it does NOT need the whole thread or 40 items per
  // section. Questions ("chat") keep the generous budget.
  const act = mode === "act";
  const recent = sliceContextHistory(
    history,
    act ? CONTEXT_TOKEN_BUDGET_ACT : CONTEXT_TOKEN_BUDGET,
    act
  );
  // Pin whatever the latest message names so the tight act cap can never cut
  // the very item the command is about ("add pumpkin seeds" must still see the
  // to-get list even if the user owns 200 things).
  const lastUserMsg = [...(history || [])].reverse().find((m) => m.role === "user");
  const pinned =
    act && lastUserMsg
      ? entityMatchKeys(await findEntityMatches(lastUserMsg.text || ""))
      : null;
  // Awaited HERE, not by the caller: the snapshot must be read after the
  // previous continuation round's writes and immediately before this request.
  // The device date lives in its header now, so it isn't repeated here.
  const knowledge = await buildKnowledgeContext({ mode: act ? "act" : "chat", pinned });
  // Right after the garden snapshot: the same "here is what is actually true
  // right now" material, and short enough to ride on every request. "" when
  // the user has weather off or it couldn't be fetched.
  const weather = await getWeatherContextBlock();
  // Questions only: a command needs ids, not product sheets (and act mode
  // still runs on small token budgets further down the chain).
  const reference = act ? "" : await buildReferenceBlock(history);
  const sys = SYSTEM_PROMPT_BASE + knowledge + reference + weather + ACTION_CONVENTIONS;
  const msgs = [{ role: "system", content: sys }];
  // Truncation is announced rather than silent — otherwise the model answers
  // confidently about turns it can no longer see.
  const omitted = history.length - recent.length;
  if (omitted > 0) {
    // Every number here is recomputed from the slice that is actually being
    // sent, not from a constant — the counts used to be tied to CONTEXT_LIMIT,
    // and a budget-based slice would have made that claim quietly false.
    const shownTokens = recent.reduce((n, m) => n + estimateTokens(contextMessageContent(m)), 0);
    msgs.push({
      role: "system",
      content:
        `[Note: this conversation has ${history.length} messages; the most recent ${recent.length} ` +
        `of them are shown to you below (roughly ${shownTokens} tokens — as much of the thread as ` +
        `fits). The ${omitted} older one(s) are NOT visible. Any ` +
        "data change they caused is already reflected in the live garden data block above; for " +
        "anything else from them, ask the user rather than guessing about what you can't see.]",
    });
  }
  for (const m of recent) {
    msgs.push({ role: m.role, content: contextMessageContent(m) });
  }
  // Entity-disambiguation hints for the CURRENT turn — read from the full
  // `history`, not the possibly-truncated `recent` slice, since the latest
  // message is always in `recent` anyway (the slice's floor is never 0) and
  // this is cheap either way. Pushed immediately before ACTION_REMINDER (the
  // last message) rather than up near the snapshot: models weight the END of
  // the context most, and a same-named real-world entity is exactly the kind
  // of strong prior that needs a nudge right before the model answers, not one
  // buried under a few hundred messages of history.
  const entityHints = lastUserMsg ? await buildEntityHints(lastUserMsg.text || "") : "";
  if (entityHints) msgs.push({ role: "system", content: entityHints });
  // After the history, before the action reminder: the snapshot's own header
  // says "I override the conversation", which on its own makes the model drop
  // the thread. This is where that gets balanced back out — see TWO_SOURCE_RULE.
  // Act mode gets the one-line version: a command doesn't need the full
  // epistemology, and 360 tokens is real money against an ~8k/minute budget.
  msgs.push({ role: "system", content: act ? TWO_SOURCE_RULE_ACT : TWO_SOURCE_RULE });
  msgs.push({ role: "system", content: ACTION_REMINDER });
  return msgs;
}

// Estimated size of a built request, so the app can show the user what it is
// actually sending (Settings › "What can Sprout see?"). Same estimator the
// slicer uses, so the numbers agree.
function estimateRequestTokens(msgs) {
  return (msgs || []).reduce((n, m) => n + estimateTokens(m && m.content), 0);
}

// The vision endpoint takes ONE prompt string, not a chat-completions array,
// so recent turns have to be flattened into text to reach it. Still clipped —
// this rides on top of an image payload and the free tier is billed per minute
// of tokens — but far less hard than before (was 8 turns / 200 chars): the
// photo path's whole job now is deciding WHICH existing item it is looking at,
// and that decision lives in the conversation ("the one on the balcony", "the
// second mint"). 16 × 400 chars is ~1.6k tokens worst case, which is worth it.
function formatRecentTranscript(history, limit = 16, clip = 400) {
  const lines = [];
  for (const m of (history || []).slice(-limit)) {
    const body = ((m.kind === "image" ? "[photo] " : "") + String(m.text || ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    lines.push(`${m.role === "user" ? "User" : "You"}: ${body.slice(0, clip)}${body.length > clip ? "…" : ""}`);
  }
  return lines.join("\n");
}

// Prompt for photos sent from the CHAT tab (the Garden detail page builds its
// own, pinned to a specific plant id). Gives the vision model the same garden
// awareness + write-back powers as the chat model.
//
// `history` is the conversation BEFORE this photo. It used to be omitted
// entirely, so a photo sent right after "which of my two mints is this?"
// answered as if the thread had never happened — the photo path could see the
// database but not the chat, which is exactly the split this is meant to fix.
//
// THE DEFAULT ASSUMPTION IS "SOMETHING THEY ALREADY OWN" (user: "i also send
// most of the time a picture of a plant i already have. only log a new plant
// if i state that it's new or if it does not exist in the garden"). This
// prompt used to open with "Identify the plant", which pushed the model
// straight into naming a species and then filing that species as a new record
// — the fastest known way to end up with four Basils. It now leads with
// matching against the snapshot, gates ADD_PLANT behind explicit "this is new"
// wording, tells the model to ASK when two candidates fit, and stops assuming
// the subject is a plant at all: tools, product labels, pests, diseased
// leaves, soil and whole beds all get photographed too.
async function buildChatVisionPrompt(caption, history) {
  // Lighter than buildKnowledgeContext, but the SAME authority framing — the
  // two must never contradict. Tools/supplies are in here now because a photo
  // is just as often a bottle of fungicide or a pruner as it is a plant, and a
  // model shown only plants will bend whatever it sees into a plant.
  const [plants, tools] = await Promise.all([getAllPlants(), getAllTools()]);
  const inventory =
    "\n=== WHAT THE USER ALREADY HAS — read from the app's database just now ===\n" +
    "AUTHORITATIVE: this is everything saved in their garden. It overrides anything said earlier, " +
    "and an item not listed here does not exist. These ids are the ONLY ids you may ever use.\n" +
    `PLANTS (${plants.length}): ` +
    (plants.length
      ? plants.map((p) => `id:${p.id} "${p.name}" (${p.location || "unknown location"})`).join(", ")
      : "none saved yet") +
    `\nTOOLS & SUPPLIES (${tools.length}): ` +
    (tools.length
      ? tools
          .map(
            (t) =>
              `id:${t.id} "${t.name}"${t.brand ? ` — ${t.brand}` : ""} x${t.quantity == null ? 1 : t.quantity}` +
              (hasProductInfo(t) ? ` [label: ${clipForPrompt(t.productInfo, 120)}]` : "")
          )
          .join(", ")
      : "none saved yet") +
    "\n=== END ===\n";
  // Same name-collision problem as the chat path (e.g. a caption mentioning
  // "lenovo"), just lighter-weight since a photo caption is usually short —
  // buildEntityHints itself already keeps this a no-op when nothing matches.
  const entityHints = await buildEntityHints(caption || "");
  // What is already saved about the product(s) in this thread — a label photo
  // is usually a follow-up to a dosing question, and the answer may already be
  // in the item's earlier label reading or its Codex entry.
  const reference = await buildReferenceBlock([...(history || []), { role: "user", text: caption || "" }]);
  const transcript = formatRecentTranscript(history);
  const conversation = transcript
    ? "\n=== RECENT CONVERSATION (before this photo) ===\n" +
      transcript +
      "\n=== END RECENT CONVERSATION ===\n" +
      "Use BOTH: the lists above are the authority on what exists and its values; this " +
      'conversation is the authority on what the user means — including what "it"/"that" refer ' +
      "to, which item they were just talking about, and anything the two of you already agreed. " +
      "Your reply must fit both, and it must continue this thread rather than start over.\n"
    : "";
  return (
    "You are Sprout, a friendly gardening companion, looking at a photo the user just sent. " +
    `The user's device says it is now: ${deviceNow()}. ` +
    `The user's message with this photo: "${caption}".\n` +
    inventory +
    reference +
    (reference ? "\n" : "") +
    conversation +
    entityHints +
    (entityHints ? "\n" : "") +
    "START HERE — THIS IS ALMOST ALWAYS SOMETHING THEY ALREADY OWN:\n" +
    "The user photographs their OWN garden. Assume by default that the subject is already in the " +
    "lists above, and treat your first job as working out WHICH record it is — not as identifying " +
    "a species from scratch. Match on what you can see plus the location, the caption, and the " +
    "conversation. Then answer their actual question about it.\n" +
    "IT MAY NOT BE A PLANT AT ALL. It could be a tool, a bottle or bag with a product label, a " +
    "pest, a diseased leaf, soil or compost, a pot, or a whole bed. Say what it ACTUALLY is — " +
    "never force a plant identification onto a photo that isn't of a plant. If it is a product " +
    "label, read the label instead: product name, brand, what type of product it is, active " +
    "ingredients, dosage/mixing rate, and the key safety warnings.\n" +
    "BLURRY OR PARTLY READABLE LABEL: the big print (brand, product name, active ingredient, " +
    "concentration) is usually legible even when the table isn't. Identify the product from it, " +
    "look it up with web search if you have it, and give the rates from that — saying which parts " +
    "you read and which you looked up. Ask for another photo only if not even the product name is " +
    "readable, and then ask for the brand and product name instead. Save what you learn: " +
    "UPDATE_TOOL the item's \"productInfo\" (and SAVE_CODEX).\n" +
    "IF YOU CANNOT TELL WHICH ITEM IT IS, ASK — one short question, and emit no action line at " +
    'all: "Is this the balcony basil or the kitchen one?" Guessing files the photo, or a whole ' +
    "new record, against the wrong item and the user has to undo it. Asking costs one message.\n" +
    'WHEN IS IT ACTUALLY NEW? Only when the user\'s message says so — "new", "just planted", ' +
    '"just bought", "picked this up today", "adding this one" — or when nothing in the lists ' +
    "above plausibly matches it. A photo on its own is NEVER evidence that something is new: the " +
    "usual reason someone photographs a plant is that they already have it.\n" +
    "ACTION LINES (hidden — JSON on one single line at the very end of your reply, never mentioned " +
    "in your visible text). This app has EXACTLY these places to save things, and no others:\n" +
    'UPDATE_PLANT: {"id": <id from the list above>, "fields": {"notes": "...", "location": "...", "tags": ["..."]}}\n' +
    "  ← THE DEFAULT when the photo shows a plant they already have. \"notes\" REPLACES the old " +
    "notes, so repeat what's there and append what the photo tells you.\n" +
    'UPDATE_TOOL: {"id": <id from the list above>, "fields": {"brand": "...", "condition": "new|good|worn|needs repair", "notes": "...", "tags": ["..."]}}\n' +
    "  ← the same default when the photo shows a tool, supply or product they already have.\n" +
    'ATTACH_PHOTO: {"plantId": <id>} — saves THIS photo into that plant\'s gallery; use it ' +
    "whenever the user asks to add/attach/save this picture to a plant (you CAN do this — never " +
    "say the photo wasn't uploaded or that you need a URL).\n" +
    'SET_COVER: {"target": "plant"|"tool", "id": <id>} — makes this photo that item\'s cover picture.\n' +
    'ADD_PLANT: {"fields": {"name": "...", "location": "...", "tags": ["..."]}} — ONLY under the ' +
    '"WHEN IS IT ACTUALLY NEW?" rule above. Never a second copy of a plant already listed. A plant ' +
    "(or tool) you ADD here gets THIS photo automatically as its cover and first gallery picture — " +
    "don't add ATTACH_PHOTO/SET_COVER for it (it has no id yet), and do tell the user the photo is on it.\n" +
    'ADD_TOOL: {"fields": {"name": "...", "quantity": 1, "tags": ["..."]}} — same gate, for a tool ' +
    "or supply they say they just bought.\n" +
    // The photo path used to expose only the six photo-shaped actions, so a
    // message like "remind me to repot this next week" sent WITH a picture had
    // no way to create the to-do — the request was silently half-served. The
    // full index below costs ~120 tokens and closes that hole: same keywords,
    // same JSON shapes as the typed-chat path, just listed compactly.
    "EVERY OTHER ACTION IS ALSO AVAILABLE HERE — the user's message may ask for something the " +
    "picture merely accompanies (\"remind me to repot this\", \"add neem oil to my shopping list\"). " +
    "The complete set of keywords, all taking the same JSON shapes as in normal chat:\n" +
    "  plants   — ADD_PLANT, UPDATE_PLANT, REMOVE_PLANT\n" +
    "  supplies — ADD_TOOL, UPDATE_TOOL, REMOVE_TOOL\n" +
    "  routines — ADD_ROUTINE, UPDATE_ROUTINE, COMPLETE_ROUTINE, REMOVE_ROUTINE\n" +
    "  to-dos   — ADD_TODO, UPDATE_TODO, COMPLETE_TODO, REMOVE_TODO\n" +
    "  shopping — ADD_TOGET, UPDATE_TOGET, REMOVE_TOGET\n" +
    "  photos   — ATTACH_PHOTO, SET_COVER\n" +
    "  codex    — SAVE_CODEX {\"fields\": {\"title\", \"body\", \"sources\", \"itemName\"}} (a reference note)\n" +
    "That is all twenty; there are no others. Serve the WHOLE message: if it asks for a change " +
    "the picture is only context for, emit that action line too rather than answering about the " +
    "photo alone.\n" +
    // A photo is the LAST place a delete should come from — the user sent a
    // picture of a thing, which is evidence they still have it.
    "REMOVE_* takes {\"id\": <id>} and is only for an explicit \"delete this\" in their message; a " +
    "photo alone never means delete, and every deletion is shown to the user to confirm first.\n" +
    "IDS: use ONLY ids that literally appear in the lists above. Never invent or guess a number — " +
    "the app discards an action aimed at an id that doesn't exist, so it would save nothing while " +
    "you told the user it was done.\n" +
    "NOTHING ELSE EXISTS: there is no bed, zone, greenhouse or harvest log in this app, " +
    "and no action keyword for one. If the photo makes you want one, say so in plain words and emit " +
    "nothing.\n" +
    // Corrected fact: push reminders ship, so the photo path must not refuse
    // "remind me to repot this on Saturday at 9" either. Same closed set —
    // a reminder is a TO-DO, not a module of its own.
    'A REMINDER, THOUGH, IS REAL — as a to-do: "remind me to repot this on Saturday at 9" is ' +
    'ADD_TODO: {"fields": {"text": "...", "dueDate": "YYYY-MM-DD", "dueTime": "HH:MM"}} — dueTime ' +
    "is 24-hour local and optional, worked out from the device time given above, and the phone " +
    "notification only arrives if the user has notifications switched on (which you can't see, so " +
    "say what you set rather than promising it will arrive).\n" +
    'FOLLOWUP: ["item 1", "item 2"] — optional, exactly one line, AFTER any action lines: 2-3 ' +
    "short items in the USER's voice — questions or commands they'd send you, never an offer " +
    'like "Would you like me to…" (see the FOLLOWUP rule).\n' +
    "Emitting NO action line at all is the right outcome most of the time — usually the user just " +
    "wants to know what is going on in the picture."
  );
}

// ---------- AI action extraction ----------

// Pulls ALL hidden action lines out of an AI reply. Models don't always obey
// "very end of reply, bare line" — this scans EVERY line and tolerates the
// usual decorations (code fences, **bold**, `backticks`, list dashes, quotes),
// so an action the model emitted is never silently dropped just because it
// was wrapped in markdown. JSON must still be on a single line (the prompt
// demands it and shows examples).
const ACTION_TYPE_MAP = {
  ADD_PLANT: "add",
  UPDATE_PLANT: "update",
  REMOVE_PLANT: "remove_plant",
  ADD_TOOL: "add_tool",
  UPDATE_TOOL: "update_tool",
  REMOVE_TOOL: "remove_tool",
  ADD_ROUTINE: "add_routine",
  UPDATE_ROUTINE: "update_routine",
  COMPLETE_ROUTINE: "complete_routine",
  REMOVE_ROUTINE: "remove_routine",
  ATTACH_PHOTO: "attach_photo",
  SET_COVER: "set_cover",
  ADD_TOGET: "add_toget",
  UPDATE_TOGET: "update_toget",
  REMOVE_TOGET: "remove_toget",
  ADD_TODO: "add_todo",
  UPDATE_TODO: "update_todo",
  COMPLETE_TODO: "complete_todo",
  REMOVE_TODO: "remove_todo",
  SAVE_CODEX: "save_codex",
};

// A DESTRUCTIVE action is one that destroys a record the user cannot get back.
// Written as a RULE (the "remove_" prefix) rather than a hand-kept list, so the
// next REMOVE_* verb someone adds to the map above is destructive from the
// moment it exists instead of from the moment someone remembers to update this
// line — the set is the readable index of what that rule currently covers, and
// the hook for any future destructive verb that isn't named remove_*.
// Everything that gates deletion behind a confirmation asks THIS function:
// handleAiActions (never auto-applies one) and PendingActionsBanner (renders it
// as dangerous, keeps it out of "Apply all").
const DESTRUCTIVE_ACTION_TYPES = new Set([
  "remove_plant",
  "remove_tool",
  "remove_routine",
  "remove_todo",
  "remove_toget",
]);

function isDestructiveAction(type) {
  const t = String(type == null ? "" : type);
  return t.indexOf("remove_") === 0 || DESTRUCTIVE_ACTION_TYPES.has(t);
}

// NOTE: the TOGET alternatives come BEFORE the TODO ones — every keyword here
// is a complete token so neither can swallow the other, but keeping the longer
// "ADD_TOGET"/"UPDATE_TOGET"/"REMOVE_TOGET" first makes that independent of the
// engine's leftmost-alternative rule (guarded by a test in run_app2.js, and by
// the REMOVE_TOGET/REMOVE_TODO twin of it).
const ACTION_START_RE =
  /(?:^|\n)[ \t>*`-]*(ADD_PLANT|UPDATE_PLANT|REMOVE_PLANT|ADD_TOOL|UPDATE_TOOL|REMOVE_TOOL|ADD_ROUTINE|UPDATE_ROUTINE|COMPLETE_ROUTINE|REMOVE_ROUTINE|ATTACH_PHOTO|SET_COVER|ADD_TOGET|UPDATE_TOGET|REMOVE_TOGET|ADD_TODO|UPDATE_TODO|COMPLETE_TODO|REMOVE_TODO|SAVE_CODEX)\**[ \t]*:[ \t\n]*\{/g;

// Hidden action lines for modules this app does NOT have — "ADD_BED",
// "LOG_HARVEST", "SET_REMINDER", "ADD_GREENHOUSE". ACTION_START_RE already
// makes these harmless: its alternation is a closed list of complete tokens,
// so an unknown verb never matches, nothing is parsed and nothing is applied
// (near-misses are safe too — "ADD_TOOLBOX" starts to match ADD_TOOL, then
// fails on the required ":" and backtracks to no match at all).
//
// The remaining problem is the leftover: the raw line stays in the VISIBLE
// reply, where it reads to the user either as a broken app or — worse — as
// proof the change happened. This second pass finds those lines so they can be
// stripped and reported. Requires at least one underscore, which is what keeps
// it away from the STATUS / SOURCES / FOLLOWUP lines (and FOLLOWUP carries a
// "[" rather than the "{" required here).
const UNKNOWN_ACTION_START_RE =
  /(?:^|\n)[ \t>*`-]*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\**[ \t]*:[ \t\n]*\{/g;

// Completion flag: every reply is asked to end with STATUS: done|continue.
// "continue" makes the chat immediately re-prompt so no request is ever left
// half-finished. Absent flag = done (older replies, small models).
const STATUS_LINE_RE = /(?:^|\n)[ \t>*`-]*STATUS\**[ \t]*:[ \t]*(done|continue)[ \t.`*]*(?=\n|$)/gi;

function extractStatus(text) {
  let status = null;
  const cleanText = (text || "")
    .replace(STATUS_LINE_RE, (_, s) => {
      status = s.toLowerCase();
      return "";
    })
    .trim();
  return { cleanText, status };
}

// Follow-up suggestions: one optional hidden line, FOLLOWUP: ["…", "…"], with
// 2-3 short questions the USER might ask next. Chat renders them as tappable
// chips under the newest reply. Tolerates the same markdown decorations as the
// STATUS line, and always strips the line from the visible text — a malformed
// array is dropped silently rather than shown (or read aloud).
const FOLLOWUP_LINE_RE = /(?:^|\n)[ \t>*`-]*FOLLOWUP\**[ \t]*:[ \t*`]*(\[[^\n]*\])[ \t`*]*(?=\n|$)/gi;

// Prompt rules leak — models still occasionally emit an offer in THEIR voice
// ("Would you like me to add a routine?") instead of the user's. A tapped
// chip is inserted verbatim into the input box and sent AS THE USER, so an
// AI-voice offer becomes nonsense when it round-trips ("would you like me
// to..." supposedly said BY the user TO the assistant). Reject those here as
// a backstop, case-insensitively, by leading phrase.
const FOLLOWUP_AI_VOICE_RE =
  /^(would you like|would you want|shall i|should i|do you want|do you need|can i |may i |let me know|want me to|would you prefer|is there anything)/i;

function extractFollowups(text) {
  let followups = [];
  const cleanText = (text || "")
    .replace(FOLLOWUP_LINE_RE, (_, raw) => {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          followups = parsed
            .map((q) => String(q == null ? "" : q).replace(/\s+/g, " ").trim().slice(0, 80))
            .filter(Boolean)
            // Drop AI-voice offers that leaked past the prompt rules — if
            // every item gets rejected this simply yields [] (no chips).
            .filter((q) => !FOLLOWUP_AI_VOICE_RE.test(q))
            .slice(0, 3);
        }
      } catch (_) {
        // malformed JSON — the line is hidden either way, just no chips
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, followups };
}

// Walks a balanced {...} starting at openIdx (string-aware, so braces inside
// quoted values don't confuse it). Returns the index AFTER the closing brace,
// or -1 if unbalanced.
function scanJsonObject(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
  }
  return -1;
}

function extractActions(text) {
  let src = text || "";
  const actions = [];
  const spans = [];
  ACTION_START_RE.lastIndex = 0;
  let m;
  // Brace-matching scan: catches actions ANYWHERE in the reply, whether the
  // JSON is on one line or pretty-printed across many (Gemini/GLM do this),
  // wrapped in code fences, bolded, or prefixed with list dashes.
  while ((m = ACTION_START_RE.exec(src)) !== null && actions.length < 12) {
    const verb = m[1];
    const openIdx = m.index + m[0].length - 1; // position of '{'
    const end = scanJsonObject(src, openIdx);
    if (end === -1) continue; // unbalanced — leave visible
    try {
      const payload = JSON.parse(src.slice(openIdx, end));
      actions.push({ type: ACTION_TYPE_MAP[verb], ...payload });
      // Strip trailing decorations right after the JSON (backticks/asterisks).
      let stripEnd = end;
      const tail = src.slice(end).match(/^[ \t]*`{0,3}\**/);
      if (tail) stripEnd += tail[0].length;
      const start = m.index + (src[m.index] === "\n" ? 1 : 0); // keep the newline
      spans.push([start, stripEnd]);
      ACTION_START_RE.lastIndex = end;
    } catch (_) {
      // malformed JSON — keep it visible rather than silently losing content
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    src = src.slice(0, spans[i][0]) + src.slice(spans[i][1]);
  }
  // Second pass, over what the real verbs left behind: action lines for
  // modules that don't exist (see UNKNOWN_ACTION_START_RE). These were never
  // applied — they just have to stop being shown to the user as if they were.
  const unknownVerbs = [];
  const unknownSpans = [];
  UNKNOWN_ACTION_START_RE.lastIndex = 0;
  let u;
  while ((u = UNKNOWN_ACTION_START_RE.exec(src)) !== null && unknownSpans.length < 12) {
    const verb = u[1];
    // A REAL verb still sitting here means its JSON was malformed, which the
    // pass above deliberately leaves visible rather than silently losing.
    if (ACTION_TYPE_MAP[verb]) continue;
    const openIdx = u.index + u[0].length - 1; // position of '{'
    const end = scanJsonObject(src, openIdx);
    if (end === -1) continue; // unbalanced — not obviously an action line, leave it
    let stripEnd = end;
    const tail = src.slice(end).match(/^[ \t]*`{0,3}\**/);
    if (tail) stripEnd += tail[0].length;
    const start = u.index + (src[u.index] === "\n" ? 1 : 0); // keep the newline
    unknownSpans.push([start, stripEnd]);
    if (unknownVerbs.indexOf(verb) === -1) unknownVerbs.push(verb);
    UNKNOWN_ACTION_START_RE.lastIndex = end;
  }
  for (let i = unknownSpans.length - 1; i >= 0; i--) {
    src = src.slice(0, unknownSpans[i][0]) + src.slice(unknownSpans[i][1]);
  }
  const cleanText = src
    .replace(/```[a-z]*\s*```/gi, "") // fences left empty after extraction
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // `unknownVerbs` is ADDITIVE — every caller destructures { cleanText,
  // actions } and simply ignores it. It exists so a UI can eventually say
  // "Sprout tried to use a module this app doesn't have" instead of nothing.
  return { cleanText, actions, unknownVerbs };
}

// Back-compat single-action wrapper (kept in case any older code path calls it).
function extractPlantUpdate(text) {
  const { cleanText, actions } = extractActions(text);
  return { cleanText, action: actions[0] || null };
}

// ---------- resolving + applying actions ----------

async function resolvePlantTarget(action) {
  const plants = await getAllPlants();
  // Number(): models sometimes send ids as strings ("4"), which used to miss
  // the strict === match and silently drop the whole action.
  if (action.id != null) {
    const byId = plants.find((p) => p.id === Number(action.id));
    if (byId) return byId;
  }
  if (action.name) {
    const lower = action.name.toLowerCase();
    const byName = plants.find((p) => (p.name || "").toLowerCase().includes(lower));
    if (byName) return byName;
  }
  return null;
}

async function resolveToolTarget(action) {
  const tools = await getAllTools();
  if (action.id != null) {
    const byId = tools.find((t) => t.id === Number(action.id)); // ids may arrive as strings
    if (byId) return byId;
  }
  if (action.name) {
    const lower = action.name.toLowerCase();
    const byName = tools.find((t) => (t.name || "").toLowerCase().includes(lower));
    if (byName) return byName;
  }
  return null;
}

// Finds the chat photo an ATTACH_PHOTO action points at: by explicit photoId,
// else the newest photo in the current chat (ctx.chatId comes from the view
// that received the AI reply).
async function resolvePhotoTarget(action, ctx) {
  const all =
    ctx && ctx.chatId != null ? await getMessagesByChat(ctx.chatId) : await getAllMessages();
  const photos = all.filter((m) => m.kind === "image" && m.imageThumb);
  if (photos.length === 0) return null;
  if (action.photoId != null) {
    const byId = photos.find((p) => p.id === Number(action.photoId));
    if (byId) return byId;
  }
  return photos[photos.length - 1]; // newest
}

async function resolveShoppingTarget(action) {
  const items = await getAllShoppingItems();
  if (action.id != null) {
    const byId = items.find((s) => s.id === Number(action.id));
    if (byId) return byId;
  }
  if (action.name) {
    const lower = action.name.toLowerCase();
    const byName = items.find((s) => (s.name || "").toLowerCase().includes(lower));
    if (byName) return byName;
  }
  return null;
}

async function resolveTodoTarget(action) {
  const todos = await getAllTodos();
  if (action.id != null) {
    const byId = todos.find((t) => t.id === Number(action.id)); // ids may arrive as strings
    if (byId) return byId;
  }
  const wanted = action.text || action.name;
  if (wanted) {
    const lower = String(wanted).toLowerCase();
    const byText = todos.find((t) => (t.text || "").toLowerCase().includes(lower));
    if (byText) return byText;
  }
  return null;
}

async function resolveRoutineTarget(action) {
  const routines = await getAllRoutines();
  if (action.id != null) {
    const byId = routines.find((r) => r.id === Number(action.id)); // ids may arrive as strings
    if (byId) return byId;
  }
  if (action.task || action.name) {
    const lower = (action.task || action.name).toLowerCase();
    const byTask = routines.find((r) => (r.task || "").toLowerCase().includes(lower));
    if (byTask) return byTask;
  }
  return null;
}

// Appends a text-only entry to a plant's history log (used for watering,
// fertilizing, and AI-driven notes — anything that isn't a photo).
function withLogEntry(plant, text, kind) {
  return {
    ...plant,
    photoHistory: [...(plant.photoHistory || []), { analysis: text, date: Date.now(), kind }],
  };
}

// Same, but spam-proof: repeated waterings/fertilizings within 24h update the
// plant's timestamp without piling up duplicate log rows.
function withCareLogEntry(plant, text, kind) {
  const hist = plant.photoHistory || [];
  const last = [...hist].reverse().find((h) => h.kind === kind);
  if (last && daysSince(last.date) === 0) return plant; // already logged today
  return withLogEntry(plant, text, kind);
}

// ---------- SAVE_CODEX: the model binding what it learned to the Codex ----------

const CODEX_BODY_MAX_CHARS = 6000;

// Cleans a SAVE_CODEX payload; null when there is nothing worth saving.
// Sources must be real http(s) URLs — the Codex renders them as links.
function normalizeCodexFields(f) {
  const title = String(f.title || "").trim().slice(0, 120);
  const body = String(f.body || "").trim().slice(0, CODEX_BODY_MAX_CHARS);
  if (!title || !body) return null;
  const rawSources = Array.isArray(f.sources)
    ? f.sources
    : typeof f.sources === "string"
      ? f.sources.split(/[,\s]+/)
      : [];
  const sources = rawSources
    .map((u) => String(u || "").trim())
    .filter((u) => /^https?:\/\/\S+$/i.test(u))
    .slice(0, 6);
  const itemName = String(f.itemName || "").trim().slice(0, 120);
  return { title, body, sources, itemName };
}

// Upsert by title (case-insensitive), or by the item it is about: saving
// "Alpha Plus" twice refreshes one note instead of piling up copies — and it
// REPLACES the item's auto-researched entry, which was written from the item
// name alone and is exactly what the model's research improves on.
async function applyCodexSave(fields) {
  const norm = (x) => String(x || "").trim().toLowerCase();
  const entries = await getAllCodexEntries();
  const existing =
    entries.find((e) => norm(e.title) === norm(fields.title)) ||
    (fields.itemName ? entries.find((e) => norm(e.itemName) === norm(fields.itemName)) : null);
  const itemName = fields.itemName || (existing && existing.itemName) || "";
  const record = {
    title: fields.title,
    body: fields.body,
    sources: fields.sources,
    kind: existing && existing.kind ? existing.kind : "topic",
    ...(itemName ? { itemName } : {}),
    auto: false,
  };
  if (existing) return updateCodexEntry({ ...existing, ...record, updatedAt: Date.now() });
  return addCodexEntry(record);
}

async function applyPlantUpdate(plant, fields) {
  const changeSummary = Object.entries(fields)
    .filter(([k]) => k !== "lastWatered" && k !== "lastFertilized")
    .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(", ");
  let updated = { ...plant, ...fields };
  if (fields.lastWatered) updated.lastWatered = Date.parse(fields.lastWatered) || Date.now();
  if (fields.lastFertilized) updated.lastFertilized = Date.parse(fields.lastFertilized) || Date.now();
  if (fields.tags) updated.tags = normTags(fields.tags);
  if (changeSummary) updated = withLogEntry(updated, changeSummary, "note");
  await updatePlant(updated);
}

async function applyPlantAdd(fields) {
  const id = await addPlant({
    name: fields.name || "New plant",
    notes: fields.notes || "",
    plantingDate: fields.plantingDate || "",
    location: fields.location || getDefaultLocation(),
    lastWatered: fields.lastWatered ? Date.parse(fields.lastWatered) || null : null,
    lastFertilized: fields.lastFertilized ? Date.parse(fields.lastFertilized) || null : null,
    tags: normTags(fields.tags),
  });
  ensureCodexResearch("plant", fields.name); // background — never blocks the add
  return id;
}

async function applyToolAdd(fields) {
  const id = await addTool({
    ...fields, // carries brand/condition/location/purchaseDate/price through
    name: fields.name || "New item",
    quantity: Number(fields.quantity) || 1,
    notes: fields.notes || "",
    tags: normTags(fields.tags),
    lastUsed: fields.lastUsed ? Date.parse(fields.lastUsed) || null : null,
  });
  ensureCodexResearch("tool", fields.name); // background — never blocks the add
  return id;
}

async function applyToolUpdate(tool, fields) {
  const updated = { ...tool, ...fields };
  if (fields.quantity != null) updated.quantity = Math.max(0, Number(fields.quantity) || 0);
  if (fields.tags) updated.tags = normTags(fields.tags);
  if (fields.lastUsed) updated.lastUsed = Date.parse(fields.lastUsed) || Date.now();
  await updateTool(updated);
}

async function applyToolRemove(tool) {
  await deleteTool(tool.id);
}

// Routines pointing at a plant. Number() on both sides because a plantId can
// arrive from the model as a string, while the plant's own id is always a
// number from IndexedDB — a === here would silently report "no linked
// routines" and leave real dangling references behind.
function routinesLinkedToPlant(routines, plantId) {
  return (routines || []).filter((r) => r.plantId != null && Number(r.plantId) === Number(plantId));
}

// Deleting a plant, and the one consequence it has: routines can carry a
// plantId, and a routine whose plant is gone would keep claiming "linked to
// plant id:7" in the AI snapshot while completeRoutine() silently did nothing
// (it looks the plant up and returns early when it can't find it).
//
// DECISION — ORPHAN, DON'T CASCADE. The routine is the user's own recurring
// task ("Water the balcony pot every 3 days"), created and worth keeping on its
// own; deleting it as a side-effect would destroy a second record the user
// never mentioned, which is exactly the surprise this whole confirm-first
// feature exists to prevent. So the link is cleared (plantId → null, and
// careAction with it, since a care action means nothing without a plant) and
// the routine survives, visible and editable in Routines. describeAction says
// how many routines this will touch BEFORE the user confirms.
async function applyPlantRemove(plant) {
  const linked = routinesLinkedToPlant(await getAllRoutines(), plant.id);
  for (const r of linked) {
    await updateRoutine({ ...r, plantId: null, careAction: "" });
  }
  await deletePlant(plant.id);
}

// Copies a photo the user sent in chat into a plant's history/gallery.
async function applyAttachPhoto(plant, photoMsg) {
  await updatePlant({
    ...plant,
    photoHistory: [
      ...(plant.photoHistory || []),
      {
        imageThumb: photoMsg.imageThumb,
        analysis: photoMsg.text ? `Added from chat — ${photoMsg.text}` : "Added from chat",
        date: Date.now(),
        kind: "photo",
      },
    ],
  });
}

// Sets a chat photo as an item's cover picture. Plants use coverThumb (shown
// on card + detail hero, overriding the latest gallery photo) and also get
// the photo into their gallery; tools/routines use photoThumb.
async function applySetCover(kindName, item, photoMsg) {
  if (kindName === "plant") {
    await updatePlant({
      ...item,
      coverThumb: photoMsg.imageThumb,
      photoHistory: [
        ...(item.photoHistory || []),
        { imageThumb: photoMsg.imageThumb, analysis: "Cover photo (from chat)", date: Date.now(), kind: "photo" },
      ],
    });
  } else if (kindName === "tool") {
    await updateTool({ ...item, photoThumb: photoMsg.imageThumb });
  } else {
    await updateRoutine({ ...item, photoThumb: photoMsg.imageThumb });
  }
}

async function applyShoppingAdd(fields) {
  await addShoppingItem({
    name: fields.name || "New item",
    quantity: Number(fields.quantity) || 1,
    notes: fields.notes || "",
    done: !!fields.done,
  });
}

async function applyShoppingUpdate(item, fields) {
  const updated = { ...item, ...fields };
  if (fields.quantity != null) updated.quantity = Math.max(1, Number(fields.quantity) || 1);
  if (fields.done != null) updated.done = !!fields.done;
  await updateShoppingItem(updated);
}

async function applyTodoAdd(fields) {
  await addTodo({
    text: fields.text || fields.task || "New task",
    dueDate: fields.dueDate || "",
    // Normalised (addTodo does this too — belt and braces, since this is the
    // path a model's "2:30 PM" or "25:99" actually arrives on).
    dueTime: normalizeDueTime(fields.dueTime),
    notes: fields.notes || "",
  });
}

// COMPLETE_TODO routes here too (fields = { done: true }) — the completedAt
// stamp is derived, never taken from the model.
async function applyTodoUpdate(todo, fields) {
  const updated = { ...todo, ...fields };
  if (fields.done != null) {
    updated.done = !!fields.done;
    updated.completedAt = updated.done ? Date.now() : null;
  }
  // Spread above would put a raw "banana" straight onto the record; normalise
  // it here instead. Checked with != null so an explicit "" still CLEARS the
  // time (that's how the model takes a reminder time back off a to-do) while an
  // update that never mentions dueTime leaves the existing one alone.
  if (fields.dueTime != null) updated.dueTime = normalizeDueTime(fields.dueTime);
  await updateTodo(updated);
}

async function applyRoutineAdd(fields) {
  await addRoutine({
    task: fields.task || "New routine",
    intervalDays: Math.max(1, Number(fields.intervalDays) || 1),
    plantId: fields.plantId != null ? Number(fields.plantId) : null,
    careAction: fields.careAction === "water" || fields.careAction === "fertilize" ? fields.careAction : "",
    tags: normTags(fields.tags),
  });
}

async function applyRoutineUpdate(routine, fields) {
  const updated = { ...routine, ...fields };
  if (fields.intervalDays != null) updated.intervalDays = Math.max(1, Number(fields.intervalDays) || 1);
  if (fields.tags) updated.tags = normTags(fields.tags);
  await updateRoutine(updated);
}

// Marking a routine done is the bridge between Routines and Garden: when the
// routine is linked to a plant with a careAction, the plant's lastWatered/
// lastFertilized is stamped and a log entry lands in its history too.
async function completeRoutine(routine) {
  await updateRoutine({ ...routine, lastDone: Date.now() });
  if (!routine.plantId || !routine.careAction) return;
  const plants = await getAllPlants();
  const plant = plants.find((p) => p.id === routine.plantId);
  if (!plant) return;
  if (routine.careAction === "water") {
    await updatePlant(withCareLogEntry({ ...plant, lastWatered: Date.now() }, `Watered (routine: ${routine.task})`, "water"));
  } else if (routine.careAction === "fertilize") {
    await updatePlant(withCareLogEntry({ ...plant, lastFertilized: Date.now() }, `Fertilized (routine: ${routine.task})`, "fertilize"));
  }
  // Completing a routine moves its next due date, which is exactly what the
  // uploaded push schedule was built from — re-sync so the server isn't still
  // holding an alarm for a job already done. Covers every caller of this
  // function (Routines detail, the Today dashboard, and AI COMPLETE_ROUTINE).
  if (typeof schedulePushSync === "function") schedulePushSync();
}

// ---------- duplicate-ADD guard ----------
//
// WHY: prompt rules leak. Even with the "work with what they already have"
// section in ACTION_CONVENTIONS, a model that hears "the basil is looking
// yellow" still sometimes emits ADD_PLANT instead of UPDATE_PLANT, and the
// user quietly ends up with two Basils. Prompting alone can't be the only
// defence for something that silently corrupts the user's data, so every
// ADD_* passes through here first.
//
// DECISION RULE — deliberately conservative, because "I planted ANOTHER
// basil" is a real and common thing to want:
//   * No EXACT normalized-name match (see normalizeItemName) → add normally.
//     A near-miss like "Thai basil" or "Basil #2" is a different item, and
//     this does no fuzzy/edit-distance matching for exactly that reason.
//   * Exact match, but the add carries a DISTINGUISHING field that CONFLICTS
//     with the existing record (a different location for a plant/tool, a
//     different plantId for a routine, a different dueDate for a to-do) →
//     it really is a separate thing: keep the ADD, flagged so the user sees
//     "a second one" in the applied list.
//   * More than one existing record already shares the name → ambiguous,
//     nothing to safely update: keep the ADD, flagged.
//   * Exact match, no conflict, and the add brings something new (a value the
//     existing record is missing or has differently) → CONVERT to UPDATE_* of
//     that record, merging only those fields.
//   * Exact match, no conflict, nothing new → DROP as a no-op.
// Every one of those five outcomes is described to the user by describeAction
// and appears in the "applied" list; none of them happens silently.
//
// Note the asymmetry: a missing value on the existing record is NOT a
// conflict (filling in a blank location is helpful and non-destructive),
// while two different non-empty values are.

// Comparison form for names: case-insensitive, punctuation-insensitive
// ("neem-oil" == "Neem Oil"), whitespace-collapsed, tolerant of a simple
// trailing plural ("Roses" == "rose"). The trailing "s" is only stripped when
// at least 3 characters of stem remain, so short names can't collide.
function normalizeItemName(name) {
  const base = String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return base.replace(/([a-z0-9]{3,})s$/, "$1");
}

// True only when both sides carry a real value AND those values differ. A
// blank on either side is "no information", never a conflict.
function guardValuesDiffer(a, b) {
  if (a == null || a === "" || b == null || b === "") return false;
  if (Array.isArray(a) || Array.isArray(b)) return false; // tags never distinguish two items
  if (typeof a === "number" || typeof b === "number") return Number(a) !== Number(b);
  return normalizeItemName(a) !== normalizeItemName(b);
}

// Per ADD type: the existing records to compare against, which property holds
// their name, which incoming fields name it, which fields make a same-named
// record a genuinely SEPARATE item, which are worth merging on a convert, and
// how the resolved update action is shaped.
async function loadAddGuardSpec(type) {
  switch (type) {
    case "add":
      return {
        records: await getAllPlants(), nameKey: "name", fieldNameKeys: ["name"],
        distinguishing: ["location"],
        mergeable: ["location", "notes", "plantingDate", "tags", "lastWatered", "lastFertilized"],
        updateType: "update_plant", itemKey: "plant", where: "garden",
      };
    case "add_tool":
      return {
        records: await getAllTools(), nameKey: "name", fieldNameKeys: ["name"],
        distinguishing: ["location", "brand"],
        mergeable: ["quantity", "notes", "tags", "brand", "condition", "location", "purchaseDate", "price"],
        updateType: "update_tool", itemKey: "tool", where: "inventory",
      };
    case "add_routine":
      return {
        records: await getAllRoutines(), nameKey: "task", fieldNameKeys: ["task", "name"],
        distinguishing: ["plantId"],
        mergeable: ["intervalDays", "tags", "careAction", "plantId"],
        updateType: "update_routine", itemKey: "routine", where: "routines",
      };
    case "add_todo":
      // Finished to-dos are excluded: re-adding a task the user already ticked
      // off ("prune the roses" again next month) is a legitimate new to-do.
      return {
        records: (await getAllTodos()).filter((t) => !t.done), nameKey: "text", fieldNameKeys: ["text", "task", "name"],
        // dueTime distinguishes for the same reason dueDate does: "check the
        // greenhouse" at 09:00 and again at 18:00 are two real reminders, not
        // one filed twice. A BLANK on either side is never a conflict
        // (guardValuesDiffer), so "actually make that 3pm" still converts into
        // an UPDATE of the timeless to-do rather than creating a second one.
        distinguishing: ["dueDate", "dueTime"],
        mergeable: ["dueDate", "dueTime", "notes"],
        updateType: "update_todo", itemKey: "todo", where: "to-do list",
      };
    case "add_toget":
      // Same reasoning: something already bought can be needed again.
      return {
        records: (await getAllShoppingItems()).filter((s) => !s.done), nameKey: "name", fieldNameKeys: ["name"],
        distinguishing: [],
        mergeable: ["quantity", "notes"],
        updateType: "update_toget", itemKey: "item", where: "to-get list",
      };
    default:
      return null;
  }
}

// The subset of `fields` genuinely worth writing onto `existing`.
function buildMergeFields(existing, fields, mergeable) {
  const out = {};
  for (const key of mergeable) {
    const v = fields[key];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      // Union, not replace — an add's tags shouldn't wipe curated ones.
      const before = normTags(existing[key] || []);
      const merged = normTags([...before, ...v]);
      if (merged.length > before.length) out[key] = merged;
      continue;
    }
    if (key === "notes") {
      // "notes" REPLACES on write (see ACTION_CONVENTIONS), so a straight
      // merge here would delete whatever the record already said. Append.
      const old = String(existing.notes || "").trim();
      const add = String(v).trim();
      if (!add || old.toLowerCase().includes(add.toLowerCase())) continue;
      out.notes = old ? `${old}; ${add}` : add;
      continue;
    }
    const cur = existing[key];
    if (cur == null || cur === "" || guardValuesDiffer(cur, v)) out[key] = v;
  }
  return out;
}

// Returns a resolved action to use INSTEAD of the raw add, or null to let the
// add through unchanged.
async function guardDuplicateAdd(type, fields) {
  const spec = await loadAddGuardSpec(type);
  if (!spec) return null;
  const rawName = spec.fieldNameKeys.map((k) => fields[k]).find((v) => v != null && v !== "");
  const wanted = normalizeItemName(rawName);
  if (!wanted) return null; // nothing to match on — let applyX* use its default name

  const matches = spec.records.filter((r) => normalizeItemName(r[spec.nameKey]) === wanted);
  if (!matches.length) return null;

  const label = String(rawName).trim();
  if (matches.length > 1) {
    return { type, fields, dedupNote: `you already have ${matches.length} named "${label}" — adding another` };
  }

  const existing = matches[0];
  const conflict = spec.distinguishing.find((k) => guardValuesDiffer(existing[k], fields[k]));
  if (conflict) {
    return {
      type, fields,
      dedupNote: `a different ${conflict} from the "${label}" you already have — adding a second one`,
    };
  }

  const merge = buildMergeFields(existing, fields, spec.mergeable);
  if (!Object.keys(merge).length) {
    return { type: "noop_duplicate", name: existing[spec.nameKey] || label, where: spec.where };
  }
  return {
    type: spec.updateType,
    [spec.itemKey]: existing,
    fields: merge,
    dedupNote: `already in your ${spec.where} — not added twice`,
  };
}

// The raw ADD, resolved the way it always was. Used when the guard passes.
const ADD_RESOLVED_TYPE = {
  add: "add_plant",
  add_tool: "add_tool",
  add_routine: "add_routine",
  add_todo: "add_todo",
  add_toget: "add_toget",
};

// Runs the guard and returns the resolved action either way. `type` is the
// extracted action type; the guard hands back a "keep the add" shape carrying
// the same `type`, which is mapped here to its resolved name.
async function resolveAdd(type, fields) {
  const guarded = await guardDuplicateAdd(type, fields);
  if (!guarded) return { type: ADD_RESOLVED_TYPE[type], fields };
  if (guarded.type === type) {
    // Guard chose to keep the ADD, but flagged it so the user sees why.
    return { type: ADD_RESOLVED_TYPE[type], fields: guarded.fields, dedupNote: guarded.dedupNote };
  }
  return guarded; // converted to an update, or a described no-op
}

// Turns a raw extracted action into a resolved, describable, applicable one.
// Returns null when the target no longer exists (stale id from the model).
// ctx: { chatId } — needed by attach_photo to find "the newest photo here".
async function resolveAction(action, ctx) {
  switch (action.type) {
    case "attach_photo": {
      const plant = await resolvePlantTarget({
        id: action.plantId != null ? Number(action.plantId) : action.id,
        name: action.plantName || action.name,
      });
      if (!plant) return null;
      const photoMsg = await resolvePhotoTarget(action, ctx);
      return photoMsg ? { type: "attach_photo", plant, photoMsg } : null;
    }
    case "set_cover": {
      const t = String(action.target || "plant").toLowerCase();
      let item = null;
      let kindName = "plant";
      if (t === "tool") {
        item = await resolveToolTarget(action);
        kindName = "tool";
      } else if (t === "routine") {
        item = await resolveRoutineTarget(action);
        kindName = "routine";
      } else {
        item = await resolvePlantTarget(action);
      }
      if (!item) return null;
      const photoMsg = await resolvePhotoTarget(action, ctx);
      return photoMsg ? { type: "set_cover", kindName, item, photoMsg } : null;
    }
    // Every ADD_* goes through resolveAdd, which may convert it into an
    // update of the record the user already has, or into a described no-op.
    case "add":
    case "add_tool":
    case "add_routine":
    case "add_toget":
      return resolveAdd(action.type, action.fields || {});
    case "update_toget": {
      const item = await resolveShoppingTarget(action);
      return item ? { type: "update_toget", item, fields: action.fields || {} } : null;
    }
    case "remove_toget": {
      const item = await resolveShoppingTarget(action);
      return item ? { type: "remove_toget", item } : null;
    }
    case "add_todo":
      return resolveAdd("add_todo", action.fields || {});
    case "update_todo": {
      const todo = await resolveTodoTarget(action);
      return todo ? { type: "update_todo", todo, fields: action.fields || {} } : null;
    }
    case "complete_todo": {
      const todo = await resolveTodoTarget(action);
      return todo ? { type: "complete_todo", todo } : null;
    }
    case "remove_todo": {
      const todo = await resolveTodoTarget(action);
      return todo ? { type: "remove_todo", todo } : null;
    }
    case "update": {
      const plant = await resolvePlantTarget(action);
      return plant ? { type: "update_plant", plant, fields: action.fields || {} } : null;
    }
    case "remove_plant": {
      const plant = await resolvePlantTarget(action);
      if (!plant) return null;
      // The linked routines are counted HERE, at resolve time, so the
      // confirmation the user is about to read can say "also unlinks 2
      // routines" — a consequence discovered after the tap is not a
      // confirmation. applyPlantRemove re-reads them before writing, so the
      // actual unlinking is never done off a stale list.
      const linkedRoutines = routinesLinkedToPlant(await getAllRoutines(), plant.id);
      return { type: "remove_plant", plant, linkedRoutines };
    }
    case "update_tool": {
      const tool = await resolveToolTarget(action);
      return tool ? { type: "update_tool", tool, fields: action.fields || {} } : null;
    }
    case "remove_tool": {
      const tool = await resolveToolTarget(action);
      return tool ? { type: "remove_tool", tool } : null;
    }
    case "update_routine": {
      const routine = await resolveRoutineTarget(action);
      return routine ? { type: "update_routine", routine, fields: action.fields || {} } : null;
    }
    case "complete_routine": {
      const routine = await resolveRoutineTarget(action);
      return routine ? { type: "complete_routine", routine } : null;
    }
    case "remove_routine": {
      const routine = await resolveRoutineTarget(action);
      return routine ? { type: "remove_routine", routine } : null;
    }
    case "save_codex": {
      const f = normalizeCodexFields(action.fields || {});
      return f ? { type: "save_codex", fields: f } : null;
    }
    default:
      return null;
  }
}

function describeAction(a) {
  const fieldsText = (fields) =>
    Object.entries(fields || {})
      .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(", ");
  // Set by the duplicate-ADD guard. Whatever it decided — converted, kept,
  // dropped — the user reads it here, in the same "applied" list as everything
  // else, so nothing about their data changes (or fails to change) unseen.
  const dup = a.dedupNote ? ` (${a.dedupNote})` : "";
  // Every REMOVE_* description below says DELETE and names what goes with the
  // record, because this same string is what the user reads in the confirm
  // banner before tapping — see PendingActionsBanner, which adds the "can't be
  // undone" warning around it. "Remove X" was accurate and far too quiet for
  // the only irreversible thing in the app.
  switch (a.type) {
    case "noop_duplicate":
      return `Kept "${a.name}" as it is — already in your ${a.where}, and nothing new to save (not added twice)`;
    case "add_plant":
      return `Add plant "${a.fields.name || "New plant"}"${a.withPhoto ? " with this photo" : ""}${dup}`;
    case "update_plant":
      return `Update "${a.plant.name}"${dup}: ${fieldsText(a.fields)}`;
    case "remove_plant": {
      const history = (a.plant.photoHistory || []).length;
      const carries = history
        ? ` and its ${history} history entr${history === 1 ? "y" : "ies"} (photos and care log)`
        : "";
      const linked = a.linkedRoutines || [];
      const also = linked.length
        ? ` — this also unlinks ${linked.length} routine${linked.length === 1 ? "" : "s"} (` +
          linked.map((r) => `"${r.task}"`).join(", ") +
          `); ${linked.length === 1 ? "the routine itself is" : "the routines themselves are"} kept`
        : "";
      return `Delete the plant "${a.plant.name}"${carries}${also}`;
    }
    case "add_tool":
      return `Add "${a.fields.name || "New item"}" (x${a.fields.quantity || 1}) to inventory${a.withPhoto ? " with this photo" : ""}${dup}`;
    case "update_tool":
      return `Update "${a.tool.name}"${dup}: ${fieldsText(a.fields)}`;
    case "remove_tool":
      return `Delete "${a.tool.name}" from your inventory`;
    case "add_routine":
      return `Add routine "${a.fields.task || "New routine"}" (every ${a.fields.intervalDays || 1}d)${dup}`;
    case "update_routine":
      return `Update routine "${a.routine.task}"${dup}: ${fieldsText(a.fields)}`;
    case "complete_routine":
      return `Mark routine "${a.routine.task}" done`;
    case "remove_routine":
      return `Delete the routine "${a.routine.task}" (every ${a.routine.intervalDays}d) and its schedule`;
    case "attach_photo":
      return `Add the chat photo to "${a.plant.name}"'s gallery`;
    case "set_cover":
      return `Set the chat photo as the cover of ${a.kindName} "${a.item.name || a.item.task}"`;
    case "add_toget":
      return `Add "${a.fields.name || "New item"}" to the to-get list${dup}`;
    case "update_toget":
      return a.fields && a.fields.done
        ? `Check off "${a.item.name}" on the to-get list`
        : `Update to-get "${a.item.name}"${dup}: ${fieldsText(a.fields)}`;
    case "remove_toget":
      return `Delete "${a.item.name}" from the to-get list`;
    case "add_todo": {
      // The TIME is part of what the user is confirming — "(due 2026-08-25)"
      // for something set to fire at 14:30 would hide the very thing they
      // asked for. Normalised so junk never reaches the banner.
      const t = normalizeDueTime(a.fields.dueTime);
      const when = a.fields.dueDate ? ` (due ${a.fields.dueDate}${t ? ` at ${t}` : ""})` : "";
      return `Add to-do "${a.fields.text || "New task"}"${when}${dup}`;
    }
    case "update_todo":
      return `Update to-do "${a.todo.text}"${dup}: ${fieldsText(a.fields)}`;
    case "complete_todo":
      return `Tick off to-do "${a.todo.text}"`;
    case "remove_todo":
      return `Delete the to-do "${a.todo.text}"`;
    case "save_codex":
      return `Saved "${a.fields.title}" to the Codex`;
    default:
      return "Unknown change";
  }
}

// Every AI-driven write funnels through here — chat, the confirm banner, and
// the inventory/garden views alike — so this is the one place that can
// guarantee the context revision moves after a write. Keep the wrapper thin;
// runResolvedAction stays the pure dispatcher.
async function applyResolvedAction(a) {
  const out = await runResolvedAction(a);
  bumpContextRevision();
  // The push schedule lives on the server and is only as fresh as the last
  // upload, so any write that could change WHEN something falls due has to
  // re-sync it. Debounced and a no-op when push is off (notify.jsx), so this
  // is safe to call on every write; guarded because notify.jsx loads after
  // helpers.jsx and a partial load must not break AI actions.
  if (typeof schedulePushSync === "function") schedulePushSync();
  return out;
}

async function runResolvedAction(a) {
  switch (a.type) {
    // A duplicate ADD the guard dropped: nothing to write, but it still flows
    // through resolve/describe so the user is told it was recognised, not lost.
    case "noop_duplicate":
      return;
    case "add_plant": {
      const id = await applyPlantAdd(a.fields);
      if (a.withPhoto) {
        const created = (await getAllPlants()).find((p) => p.id === id);
        if (created) await applySetCover("plant", created, a.withPhoto);
      }
      return id;
    }
    case "update_plant":
      return applyPlantUpdate(a.plant, a.fields);
    case "remove_plant":
      return applyPlantRemove(a.plant);
    case "add_tool": {
      const id = await applyToolAdd(a.fields);
      if (a.withPhoto) {
        const created = (await getAllTools()).find((t) => t.id === id);
        if (created) await applySetCover("tool", created, a.withPhoto);
      }
      return id;
    }
    case "update_tool":
      return applyToolUpdate(a.tool, a.fields);
    case "remove_tool":
      return applyToolRemove(a.tool);
    case "add_routine":
      return applyRoutineAdd(a.fields);
    case "update_routine":
      return applyRoutineUpdate(a.routine, a.fields);
    case "complete_routine":
      return completeRoutine(a.routine);
    case "remove_routine":
      return deleteRoutine(a.routine.id);
    case "attach_photo":
      return applyAttachPhoto(a.plant, a.photoMsg);
    case "set_cover":
      return applySetCover(a.kindName, a.item, a.photoMsg);
    case "add_toget":
      return applyShoppingAdd(a.fields);
    case "update_toget":
      return applyShoppingUpdate(a.item, a.fields);
    case "remove_toget":
      return deleteShoppingItem(a.item.id);
    case "add_todo":
      return applyTodoAdd(a.fields);
    case "update_todo":
      return applyTodoUpdate(a.todo, a.fields);
    case "complete_todo":
      return applyTodoUpdate(a.todo, { done: true });
    case "remove_todo":
      return deleteTodo(a.todo.id);
    case "save_codex":
      return applyCodexSave(a.fields);
  }
}

// ---------- schema guard: only real columns are ever written ----------
//
// WHY: the prompt lists exact field names per action, but models invent
// plausible neighbours anyway ("soilPh", "sunExposure", "harvestedOn",
// "waterAmount") — and several apply* functions spread `fields` straight onto
// the record ({ ...tool, ...fields }), so an invented key would be persisted
// forever and then read back OUT of the snapshot on the next turn as if the
// app really had that column. IndexedDB stores are schemaless, so nothing
// downstream would ever catch it. Every key is checked against the record
// shapes documented in idb.js before anything is written or even queued.
//
// Some genuinely real columns are deliberately absent because the CODE owns
// them, not the model: id/createdAt (the database), completedAt and lastDone
// (set when something is marked done), photoHistory/coverThumb/photoThumb
// (only ATTACH_PHOTO and SET_COVER may touch images), done on a to-do (that's
// COMPLETE_TODO's job, and UPDATE_TODO keeps it for explicit un-ticking).
const ACTION_FIELD_WHITELIST = {
  add: ["name", "notes", "plantingDate", "location", "lastWatered", "lastFertilized", "tags"],
  update: ["name", "notes", "plantingDate", "location", "lastWatered", "lastFertilized", "tags"],
  add_tool: ["name", "quantity", "notes", "tags", "brand", "condition", "location", "purchaseDate", "price", "lastUsed", "productInfo"],
  update_tool: ["name", "quantity", "notes", "tags", "brand", "condition", "location", "purchaseDate", "price", "lastUsed", "productInfo"],
  // "name" is an accepted ALIAS for "task" on an add: loadAddGuardSpec's
  // fieldNameKeys reads it, so stripping it would blind the duplicate guard.
  add_routine: ["task", "name", "intervalDays", "plantId", "careAction", "tags"],
  update_routine: ["task", "intervalDays", "plantId", "careAction", "tags"],
  // Same alias story — applyTodoAdd falls back to fields.task for "text".
  // "dueTime" is a REAL column (see idb.js): without it here the guard would
  // strip the clock time off every reminder the model sets and the to-do would
  // silently fall back to the daily notification hour.
  add_todo: ["text", "task", "name", "dueDate", "dueTime", "notes"],
  update_todo: ["text", "dueDate", "dueTime", "notes", "done"],
  add_toget: ["name", "quantity", "notes", "done"],
  update_toget: ["name", "quantity", "notes", "done"],
  save_codex: ["title", "body", "sources", "itemName"],
};

// The field that must survive sanitising for an ADD to mean anything at all.
// An ADD whose only content was invented keys is a hallucination, not a
// request — letting it through would create a record literally called
// "New plant" (see applyPlantAdd's fallback).
const ACTION_NAME_FIELDS = {
  add: ["name"],
  add_tool: ["name"],
  add_toget: ["name"],
  add_routine: ["task", "name"],
  add_todo: ["text", "task", "name"],
  save_codex: ["title"],
};

// Returns { fields, dropped } — `fields` carrying only real columns for this
// action's store, `dropped` the invented keys, for reporting.
function sanitizeActionFields(type, fields) {
  const allowed = ACTION_FIELD_WHITELIST[type];
  if (!allowed || !fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { fields: fields, dropped: [] };
  }
  const clean = {};
  const dropped = [];
  for (const key of Object.keys(fields)) {
    if (allowed.indexOf(key) !== -1) clean[key] = fields[key];
    else dropped.push(key);
  }
  return { fields: clean, dropped };
}

// What the user's data calls this kind of thing, for skip messages.
const ACTION_SKIP_LABEL = {
  add: "plant", update: "plant", remove_plant: "plant",
  add_tool: "inventory item", update_tool: "inventory item", remove_tool: "inventory item",
  add_routine: "routine", update_routine: "routine", complete_routine: "routine", remove_routine: "routine",
  add_todo: "to-do", update_todo: "to-do", complete_todo: "to-do", remove_todo: "to-do",
  add_toget: "to-get item", update_toget: "to-get item", remove_toget: "to-get item",
  attach_photo: "plant photo", set_cover: "cover photo",
  save_codex: "Codex note",
};

// "(id 999)" / '("Basil")' / '(id 4, "Basil")' — whatever the model gave us to
// aim with, echoed back so the skip message names the thing it failed on.
function actionTargetRef(action) {
  const name = action.name || action.plantName || action.task || action.text;
  const id = action.id != null ? action.id : action.plantId;
  if (id != null && name) return ` (id ${id}, "${name}")`;
  if (id != null) return ` (id ${id})`;
  if (name) return ` ("${name}")`;
  return "";
}

function describeSkippedAction(action, why) {
  const label = ACTION_SKIP_LABEL[action.type] || "item";
  const article = /^[aeiou]/i.test(label) ? "an" : "a"; // "an inventory item", not "a inventory item"
  return `Didn't save ${article} ${label} change Sprout tried to make${actionTargetRef(action)} — ${why}.`;
}

// Shared by Chat/Garden/Inventory: resolves every action pulled from an AI
// reply, then either applies them immediately (auto mode) or queues them for
// the user to confirm. Pass setPendingActions=null where there's no confirm
// UI — confirm mode then skips writes entirely.
// ctx: { chatId } — lets attach_photo find photos in the current thread.
//
// ONE EXCEPTION TO THE WRITE MODE: a DESTRUCTIVE action (isDestructiveAction —
// every REMOVE_*) is ALWAYS queued for an explicit confirmation, including in
// "auto" mode, and is never applied here. With no queue to put it in it is
// dropped and reported in `skipped`. See the split below for why.
//
// Returns { applied: [description…], queued: n, skipped: [reason…] } so the
// caller can show the user visible proof of what was ACTUALLY saved (not just
// what the AI claims) — AND, now, of what silently wasn't. `skipped` is purely
// ADDITIVE: chat.jsx, garden.jsx and inventory.jsx read only applied/queued
// (and a test asserts that shape), so they keep working untouched.
//
// Previously an action whose target didn't exist — a hallucinated id, or an
// item deleted since — resolved to null and was dropped without a word, while
// the model's reply still said "done!". That is the single failure the user
// can't detect, so it is now reported instead.
async function handleAiActions(actions, setPendingActions, ctx = {}) {
  const result = { applied: [], queued: 0, skipped: [] };
  if (!actions || !actions.length) return result;
  const confirmMode = getAiWriteMode() === "confirm";
  const resolved = [];
  for (const raw of actions) {
    // Schema guard runs FIRST, so an invented field can't reach a resolver,
    // the duplicate guard, the confirm banner's preview, or a write.
    const { fields, dropped } = sanitizeActionFields(raw.type, raw.fields);
    if (dropped.length) {
      result.skipped.push(
        `Ignored ${dropped.length === 1 ? "a field" : `${dropped.length} fields`} this app doesn't ` +
          `have${actionTargetRef(raw)}: ${dropped.join(", ")}.`
      );
    }
    const action = raw.fields ? { ...raw, fields } : raw;
    const nameKeys = ACTION_NAME_FIELDS[action.type];
    if (nameKeys) {
      const named = nameKeys.some(
        (k) => fields && fields[k] != null && String(fields[k]).trim() !== ""
      );
      if (!named) {
        result.skipped.push(describeSkippedAction(action, "it arrived with no name to save it under"));
        continue;
      }
    } else if (raw.fields && Object.keys(raw.fields).length && fields && !Object.keys(fields).length) {
      // An UPDATE_* that sent fields, but not one of them real, has nothing
      // left to do — writing the record back unchanged would be a lie.
      result.skipped.push(describeSkippedAction(action, "none of the fields it sent exist in this app"));
      continue;
    }
    const r = await resolveAction(action, ctx);
    if (r) {
      resolved.push(r);
      continue;
    }
    // The resolvers return null for exactly one reason: no such target.
    result.skipped.push(
      describeSkippedAction(
        action,
        action.type === "attach_photo" || action.type === "set_cover"
          ? "that item isn't in your garden, or there's no photo in this chat to use"
          : "nothing in your garden matches that id or name"
      )
    );
  }
  if (!resolved.length) return result;

  // ---- a photo sent with "add this to my garden" ----
  // ATTACH_PHOTO/SET_COVER need an id, and a plant CREATED in this same reply
  // has none yet — so the plant was saved and the photo silently dropped
  // (user report, 2026-09-29). The photo path now passes the photo in ctx,
  // and a genuinely new plant/tool from it carries the photo along (cover +
  // gallery), unless the model already aimed a photo action somewhere itself.
  // Rides on the resolved action, so confirm mode attaches it on confirmation.
  if (ctx && ctx.photoMsg && ctx.photoMsg.imageThumb) {
    const photoHandled = resolved.some((r) => r.type === "attach_photo" || r.type === "set_cover");
    if (!photoHandled) {
      for (const r of resolved) {
        if (r.type === "add_plant" || r.type === "add_tool") r.withPhoto = ctx.photoMsg;
      }
    }
  }

  // ---- the destructive split (user: "with confirmation of course") ----
  //
  // The write mode is the user's answer to "how much tapping should an ADD or
  // an UPDATE cost me?" — it is NOT permission to destroy a record without
  // being asked. An add is visible and reversible (delete it); an update leaves
  // a log entry; a DELETE takes a plant's whole photo history with it and
  // nothing in this app can bring it back. So deletions leave the write-mode
  // branch entirely and always go to the confirm queue, "auto" or not.
  // Non-destructive actions follow exactly the logic they always did.
  // SAVE_CODEX is the other exception, in the opposite direction: it writes
  // reference knowledge, not the user's garden records, and the user asked for
  // researched facts to be bound to the Codex automatically — so it is applied
  // even in "confirm" mode (it can always be deleted from the Codex screen).
  const alwaysApply = (r) => r.type === "save_codex";
  const toQueue = confirmMode
    ? resolved.filter((r) => !alwaysApply(r))
    : resolved.filter((r) => isDestructiveAction(r.type));
  const toApply = confirmMode
    ? resolved.filter(alwaysApply)
    : resolved.filter((r) => !isDestructiveAction(r.type));

  if (toQueue.length) {
    if (setPendingActions) {
      setPendingActions((prev) => {
        // Mirrored into queuedActionNotes inside the updater so the AI's
        // "NOT SAVED YET" list always matches the banner the user is looking
        // at — nothing here is written to the database yet.
        const next = [...(prev || []), ...toQueue];
        setQueuedActions(next);
        return next;
      });
      result.queued = toQueue.length;
    } else {
      // NO CONFIRM UI ON THIS PATH (setPendingActions === null — the contract
      // for callers with nowhere to render a banner). "Nowhere to ask" must
      // never resolve to "do it anyway", so the deletion is dropped — and said
      // out loud, because a silently dropped delete plus a model cheerfully
      // reporting "removed it!" is the one failure the user can't see.
      // Non-destructive actions keep the old confirm-mode behaviour (dropped
      // quietly); only deletions are reported here.
      for (const r of toQueue) {
        if (!isDestructiveAction(r.type)) continue;
        result.skipped.push(
          `Sprout wanted to ${describeAction(r).replace(/^Delete /, "delete ")} — every deletion ` +
            "needs your confirmation and there's no way to ask you here. Nothing was deleted; " +
            "ask again in the chat to confirm it there."
        );
      }
    }
  }

  for (const r of toApply) {
    await applyResolvedAction(r);
    result.applied.push(describeAction(r));
  }
  return result;
}
