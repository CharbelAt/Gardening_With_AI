// Shared constants, settings, and the AI/data helper functions used across
// every module. Loaded first (after idb.js) so everything below is a plain
// global by the time chat.jsx/voice.jsx/garden.jsx/etc. run — see the note at
// the top of idb.js for why this app uses globals instead of import/export.

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
const LS_ACTIVE_CHAT = "gc_activeChatId";
const LS_AI_WRITE_MODE = "gc_aiWriteMode"; // 'auto' | 'confirm'
const LS_THEME = "gc_theme"; // 'dark' | 'light'
const LS_DEFAULT_LOCATION = "gc_defaultLocation";
const LS_LANDING_VIEW = "gc_landingView"; // "chat" (default) | "today"
const CONTEXT_LIMIT = 24; // how many past messages get sent back to the AI as context — balance between context loss and free-tier token-per-minute budgets

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

function getTheme() {
  return localStorage.getItem(LS_THEME) || "dark";
}

function getDefaultLocation() {
  return localStorage.getItem(LS_DEFAULT_LOCATION) || "";
}

const SYSTEM_PROMPT_BASE =
  "You are Sprout, a friendly, knowledgeable gardening companion. Give practical, " +
  "concrete advice (watering, light, soil, pests, timing) suited to home gardeners. " +
  "If you're not fully confident about a specific fact — exact species identification, " +
  "disease diagnosis, or precise care details — say so plainly rather than guessing " +
  "confidently, and search for or reference a trusted source (university extension " +
  "services, RHS, Missouri Botanical Garden, etc.) when you can. " +
  "ASK WHEN UNSURE: if the question is ambiguous, or a missing detail would materially " +
  "change your answer (which plant or variety, indoor vs outdoor, their climate/location, " +
  "what the symptoms actually look like and when they started), ask ONE short clarifying " +
  "question first instead of guessing — and in that reply emit no action lines. " +
  "When the detail doesn't change the answer, just answer. " +
  "NAMES: item names in the user's own garden data always refer to their own items — when a " +
  "name collides with a famous real-world company/brand/celebrity/place, the user's item wins " +
  "unless they clearly mean the outside entity. " +
  "WEATHER: when a LOCAL WEATHER block is provided, let it drive watering, spraying and frost/" +
  "heat advice instead of generic seasonal guidance.";

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
function todoDueDelta(dueDate) {
  if (!dueDate) return null;
  const due = Date.parse(`${dueDate}T00:00:00`);
  if (isNaN(due)) return null;
  const today = Date.parse(`${todayISO()}T00:00:00`);
  return Math.round((due - today) / (24 * 60 * 60 * 1000));
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
    const data = await apiFetch("/api/chat", {
      mode: "research",
      messages: [
        { role: "system", content: CODEX_RESEARCH_SYSTEM },
        { role: "user", content: `${kind === "plant" ? "Plant" : "Tool/supply"}: ${clean}` },
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

// Read-only snapshot of the user's data, injected into the system prompt so
// the AI can answer from what is actually stored without any tool-calling
// machinery. Rebuilt from IndexedDB on EVERY request (and every continuation
// round, after the previous round's writes landed) — the heavy framing below
// exists because a model that is merely SHOWN data still tends to trust what
// it remembers saying earlier over what the app actually holds.
async function buildKnowledgeContext() {
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

  const openTodos = todos.filter((t) => !t.done);
  parts.push(
    `To-do, one-off tasks (${openTodos.length} open, ${todos.length - openTodos.length} done): ` +
      (openTodos.length
        ? openTodos
            .map((t) => {
              const delta = todoDueDelta(t.dueDate);
              const due = t.dueDate ? `, due ${t.dueDate}${delta !== null && delta < 0 ? " OVERDUE" : ""}` : "";
              return `id:${t.id} "${t.text}"${due}${t.notes ? ` (${t.notes})` : ""}`;
            })
            .join(", ")
        : "none open")
  );

  parts.push(
    `To-get, shopping (${shopping.length}): ` +
      (shopping.length
        ? shopping
            .map((s) => `id:${s.id} "${s.name}" x${s.quantity}${s.done ? " [BOUGHT]" : " [open]"}`)
            .join(", ")
        : "empty")
  );

  parts.push(
    `Tools/supplies (${tools.length}): ` +
      (tools.length
        ? tools
            .map((t) => {
              const extras = [t.condition, t.location ? `stored: ${t.location}` : "", t.brand]
                .filter(Boolean)
                .join(", ");
              return `id:${t.id} "${t.name}" x${t.quantity}${extras ? ` (${extras})` : ""}${tagsLabel(t)}`;
            })
            .join(", ")
        : "none")
  );

  parts.push(
    `Routines (${routines.length}): ` +
      (routines.length
        ? routines
            .map((r) => {
              const status = isRoutineDue(r) ? "DUE" : "not due";
              const last = r.lastDone ? new Date(r.lastDone).toLocaleDateString() : "never";
              const link = r.plantId ? `, linked to plant id:${r.plantId}${r.careAction ? ` (${r.careAction})` : ""}` : "";
              return `id:${r.id} "${r.task}" (every ${r.intervalDays}d, last done ${last}, ${status}${link})${tagsLabel(r)}`;
            })
            .join("; ")
        : "none")
  );

  parts.push(
    `Plants (${plants.length}):` +
      (plants.length
        ? "\n" +
          plants
            .map((p) => {
              const w = p.lastWatered ? new Date(p.lastWatered).toLocaleDateString() : "never";
              const f = p.lastFertilized ? new Date(p.lastFertilized).toLocaleDateString() : "never";
              return `- id:${p.id} "${p.name}" | location: ${p.location || "unknown"} | planted: ${
                p.plantingDate || "unknown"
              } | last watered: ${w} | last fertilized: ${f}${tagsLabel(p)} | notes: ${p.notes || "none"}`;
            })
            .join("\n")
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
    "AUTHORITATIVE: this block is the single source of truth and OVERRIDES everything said earlier " +
    "in this conversation, including your own earlier statements. If something is not listed here, " +
    "it does not exist (deleted, or never added — do not resurrect it); where a value differs from " +
    'what was said earlier, this block wins. Answer "what do I have" / "is X on my list" strictly ' +
    "from it, never from memory.\n" +
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
// exist in THIS user's own data and returns a compact system-prompt block, or
// "" when nothing matches — a deliberate no-op (zero extra tokens) that keeps
// this feature free for every message that doesn't need it. Wrapped in
// try/catch: a weirdly-named item (regex metacharacters) must never be able
// to break chat.
async function buildEntityHints(text) {
  const msg = (text || "").toLowerCase();
  if (!msg.trim()) return "";
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
        detail: td.dueDate ? `due ${td.dueDate}` : "",
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
    if (hits.size === 0) return "";

    // Longest matched word first = most specific / least likely coincidental;
    // cap at 6 so this can never balloon into a token sink on a busy garden.
    const words = [...hits.keys()].sort((a, b) => b.length - a.length).slice(0, 6);

    const lines = words.map((word) => {
      const entries = hits.get(word);
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
  } catch (e) {
    console.error("buildEntityHints failed:", e && e.message);
    return "";
  }
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
  "You are connected to the user's garden app (Garden, Inventory, Routines modules). The ONLY " +
  "way you can create or change anything in those modules is by emitting action lines. Saying " +
  '"I\'ve added it" without an action line saves NOTHING — if you claim a change, you MUST emit ' +
  "the matching line(s).\n" +
  "An action line is one single line — the keyword, a colon, then its complete JSON on that " +
  "same line — placed at the very end of your reply, after your visible text. Emit SEVERAL " +
  "action lines (one per line) when the user mentions several changes in one message. The app " +
  "strips these lines before display; the user never sees them, so never mention or explain them.\n" +
  "FORMULAS (copy these shapes exactly):\n" +
  'ADD_PLANT: {"fields": {"name": "...", "location": "...", "plantingDate": "YYYY-MM-DD", "notes": "...", "tags": ["..."]}}\n' +
  'UPDATE_PLANT: {"id": <plant id>, "fields": {"lastWatered": "YYYY-MM-DD", "lastFertilized": "YYYY-MM-DD", "name": "...", "location": "...", "notes": "...", "tags": ["..."]}}\n' +
  'ADD_TOOL: {"fields": {"name": "...", "quantity": 1, "notes": "...", "tags": ["..."], "brand": "...", "condition": "new|good|worn|needs repair", "location": "...", "purchaseDate": "YYYY-MM-DD", "price": 0}}\n' +
  'UPDATE_TOOL: {"id": <tool id>, "fields": {"quantity": 2, "notes": "...", "tags": ["..."], "brand": "...", "condition": "...", "location": "...", "lastUsed": "YYYY-MM-DD", "price": 0}}\n' +
  'REMOVE_TOOL: {"id": <tool id>}\n' +
  'ADD_ROUTINE: {"fields": {"task": "...", "intervalDays": 3, "plantId": <plant id>, "careAction": "water", "tags": ["..."]}}\n' +
  'UPDATE_ROUTINE: {"id": <routine id>, "fields": {"task": "...", "intervalDays": 5, "tags": ["..."]}}\n' +
  'COMPLETE_ROUTINE: {"id": <routine id>}\n' +
  'ATTACH_PHOTO: {"plantId": <plant id>, "photoId": <optional N from "[shared photo #N]" — omit for the newest photo in this chat>}\n' +
  'SET_COVER: {"target": "plant"|"tool"|"routine", "id": <item id>, "photoId": <optional, as above>} — makes a chat photo the item\'s cover picture\n' +
  'ADD_TOGET: {"fields": {"name": "...", "quantity": 1, "notes": "..."}} — puts something on the to-get (shopping) list\n' +
  'UPDATE_TOGET: {"id": <to-get id>, "fields": {"done": true, "quantity": 2, "name": "..."}}\n' +
  'REMOVE_TOGET: {"id": <to-get id>}\n' +
  'ADD_TODO: {"fields": {"text": "...", "dueDate": "YYYY-MM-DD", "notes": "..."}} — a one-off task on the to-do list (dueDate/notes optional)\n' +
  'UPDATE_TODO: {"id": <to-do id>, "fields": {"text": "...", "dueDate": "YYYY-MM-DD", "notes": "..."}}\n' +
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
  "RULES:\n" +
  "- ACT IN THIS REPLY: when the user asks for a change, the action line(s) must be at the end " +
  "of THIS message — act first, then your visible text simply confirms it. NEVER answer " +
  '"I\'ll add it" or "Added!" without the line in the same reply, and never defer the action ' +
  "to a later turn. A reply that claims a change but has no action line is a failure.\n" +
  "- ALWAYS act on explicit commands — add, remove, update, note, log, track, remember — with the matching action line(s).\n" +
  '- Photos the user sent in this chat appear as "[shared photo #N]". You CAN put them in a ' +
  "plant's gallery with ATTACH_PHOTO, and set them as the cover picture of any plant, tool, " +
  "or routine with SET_COVER — the app holds the image itself. NEVER say a photo " +
  '"wasn\'t uploaded", that you "can\'t access it", or that you "need a URL". When the user ' +
  "shares a clear photo of one of their items that has no picture yet, you may proactively " +
  "SET_COVER it (mention that you did).\n" +
  '- "notes" REPLACES the old notes: to add a note, repeat the existing notes and append the new one (see example).\n' +
  "- Use real ids from the garden data above. Only include fields that actually change. Never leave <placeholders> in the JSON.\n" +
  "- Dates: use the device date given above. When the user watered/fertilized a plant: UPDATE_PLANT with that date, plus COMPLETE_ROUTINE if a matching routine exists.\n" +
  '- ADD_ROUTINE: "plantId" + "careAction" ("water"/"fertilize") are optional — set them when the routine cares for one specific plant, so completing it also updates that plant.\n' +
  "- Tag new items with 1-3 tags. Presets — plants: " +
  PRESET_TAGS.plants.join("/") +
  "; tools: " +
  PRESET_TAGS.tools.join("/") +
  "; routines: " +
  PRESET_TAGS.routines.join("/") +
  ". Invent a short lowercase tag only when none fit.\n" +
  "- If you are UNSURE which item the user means, or whether they really want a change: ask a short clarifying question in your visible reply and emit NO action line for that change.\n" +
  '- To-get list: "I need to buy X" / "remind me to get X" → ADD_TOGET. When the user says ' +
  "they BOUGHT something that's on the list: UPDATE_TOGET with done true AND ADD_TOOL so it " +
  "lands in their inventory.\n" +
  "- THREE DIFFERENT LISTS, pick the right one: a TO-DO is a one-off task to DO once " +
  '("prune the roses", "repot the mint Saturday") → ADD_TODO; a TO-GET is something to BUY ' +
  '("more potting soil") → ADD_TOGET; a ROUTINE is a task that RECURS on an interval ' +
  '("water the ficus every 3 days") → ADD_ROUTINE. When the user finishes a one-off task ' +
  '("I pruned the roses"), COMPLETE_TODO it — don\'t add a new one.\n' +
  "- Never invent changes the user didn't ask for, and don't re-emit an action already applied " +
  "earlier in the conversation. BUT when the user explicitly asks you to create demo/sample/" +
  "example data, that IS a real request — emit one action line per item you create.\n" +
  "- FOLLOW-UP SUGGESTIONS (optional): after any action lines and BEFORE the STATUS line, you " +
  'may emit exactly ONE line: FOLLOWUP: ["item 1", "item 2", "item 3"] — 2-3 short items the ' +
  "USER might send you next, questions OR commands/requests. Each string is inserted verbatim " +
  "into the user's input box and sent AS THE USER when tapped, so it must be something THEY " +
  'would type to YOU: first person ("I"/"my"), addressing you as "you". WRONG (your voice, an ' +
  'offer): "Would you like me to add a watering routine?" / "Shall I check the soil pH?" / "Do ' +
  'you want more details?" RIGHT (their voice): "How often should I water it?" / "Add a ' +
  'watering routine for this" / "What pests should I watch for?" / "Remind me to spray next ' +
  'week". Rule of thumb: never start with "Would you like", "Shall I", "Do you want", "Should ' +
  'I", or "Let me know if" — start with a word the USER would say. Skip it for trivial ' +
  "confirmations.\n" +
  "- COMPLETION FLAG (mandatory): the VERY LAST line of EVERY reply must be exactly " +
  "STATUS: done — or STATUS: continue if you could not finish everything in this reply " +
  "(too many items, ran out of space). On STATUS: continue the app immediately asks you to " +
  "keep going: emit ONLY the remaining action lines (no repeats), then STATUS: done. " +
  "Never leave a request partially handled without flagging continue.";

// Short reminder appended AFTER the conversation history — models weight the
// end of the context most, and this is what finally made "add X" reliably act
// in the SAME reply instead of a later one.
const ACTION_REMINDER =
  "REMINDER: before answering, re-check the live data snapshot above rather than relying on " +
  "conversation memory. Also check — does the user's latest message ask to add, update, " +
  "remove, log, note, or track anything (plant, tool, routine, to-do task, to-get/shopping item, " +
  "watering, purchase), to create demo/sample data (allowed — one action line per item), or to attach a " +
  "photo they sent to a plant (ATTACH_PHOTO) or set a cover (SET_COVER — you CAN do these)? " +
  "If yes: end THIS reply with the matching action line(s), exactly per the formulas in your " +
  "instructions — act now, in this reply, never later. If unsure which item they mean, ask " +
  "instead and emit nothing. If a change was already applied earlier in the conversation, " +
  "don't re-emit it. Never claim a change without its action line in this same reply. " +
  'Optionally, one line before the end: FOLLOWUP: ["…", "…"] — 2-3 items in the USER\'s voice, ' +
  "questions or commands they'd send you, never offers like \"Would you like me to…\" (see the " +
  "FOLLOWUP rule above). " +
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

// Builds the text-only context array the chat model sees, from stored history.
// `mode` is accepted but no longer changes anything here (the old "call" mode
// is gone — voice input is now dictation into this same typed chat); routing
// still happens server-side via the mode sent to /api/chat.
async function buildContextMessages(history, mode) {
  const recent = history.slice(-CONTEXT_LIMIT);
  // Awaited HERE, not by the caller: the snapshot must be read after the
  // previous continuation round's writes and immediately before this request.
  // The device date lives in its header now, so it isn't repeated here.
  const knowledge = await buildKnowledgeContext();
  // Right after the garden snapshot: the same "here is what is actually true
  // right now" material, and short enough to ride on every request. "" when
  // the user has weather off or it couldn't be fetched.
  const weather = await getWeatherContextBlock();
  const sys = SYSTEM_PROMPT_BASE + knowledge + weather + ACTION_CONVENTIONS;
  const msgs = [{ role: "system", content: sys }];
  // Truncation is announced rather than silent — otherwise the model answers
  // confidently about turns it can no longer see.
  const omitted = history.length - recent.length;
  if (omitted > 0) {
    msgs.push({
      role: "system",
      content:
        `[Note: ${omitted} earlier message(s) in this conversation are NOT shown to you. The live ` +
        "garden data block above is current and already reflects them; for anything else from " +
        "those messages, ask the user rather than guessing about what you can't see.]",
    });
  }
  for (const m of recent) {
    if (m.kind === "image") {
      // The #id lets the model reference a specific photo in ATTACH_PHOTO.
      msgs.push({
        role: m.role,
        content:
          m.role === "user"
            ? `[shared photo #${m.id}] ${m.text || ""}`
            : m.text || "",
      });
    } else {
      msgs.push({ role: m.role, content: m.text || "" });
    }
  }
  // Entity-disambiguation hints for the CURRENT turn — read from the full
  // `history`, not the possibly-truncated `recent` slice, since the latest
  // message is always in `recent` anyway (CONTEXT_LIMIT is never 0) and this
  // is cheap either way. Pushed immediately before ACTION_REMINDER (the last
  // message) rather than up near the snapshot: models weight the END of the
  // context most, and a same-named real-world entity is exactly the kind of
  // strong prior that needs a nudge right before the model answers, not one
  // buried under 24 messages of history.
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const entityHints = lastUser ? await buildEntityHints(lastUser.text || "") : "";
  if (entityHints) msgs.push({ role: "system", content: entityHints });
  msgs.push({ role: "system", content: ACTION_REMINDER });
  return msgs;
}

// Prompt for photos sent from the CHAT tab (the Garden detail page builds its
// own, pinned to a specific plant id). Gives the vision model the same garden
// awareness + write-back powers as the chat model.
async function buildChatVisionPrompt(caption) {
  // Lighter than buildKnowledgeContext (a photo only ever needs the plant
  // list), but the SAME authority framing — the two must never contradict.
  const plants = await getAllPlants();
  const plantList =
    `AUTHORITATIVE plant list, read from the app's database just now (${plants.length}) — it ` +
    "overrides anything said earlier, and a plant not on it does not exist: " +
    (plants.length
      ? plants.map((p) => `id:${p.id} "${p.name}" (${p.location || "unknown location"})`).join(", ")
      : "none saved yet") +
    ". ";
  // Same name-collision problem as the chat path (e.g. a caption mentioning
  // "lenovo"), just lighter-weight since a photo caption is usually short —
  // buildEntityHints itself already keeps this a no-op when nothing matches.
  const entityHints = await buildEntityHints(caption || "");
  return (
    "You are Sprout, a friendly gardening companion analyzing a photo for a home gardener. " +
    `The user's device says it is now: ${deviceNow()}. ` +
    plantList +
    "Identify the plant, assess its health from the photo, and give concrete care advice. " +
    `The user's question about this photo: "${caption}". ` +
    entityHints +
    (entityHints ? " " : "") +
    "You may end your reply with hidden action lines (JSON on a single line, never mentioned " +
    "in your visible reply):\n" +
    'UPDATE_PLANT: {"id": <plant id>, "fields": {"notes": "..."}} — if this photo warrants a record update.\n' +
    'ADD_PLANT: {"fields": {...}} — if the user clearly wants this new plant tracked.\n' +
    'ATTACH_PHOTO: {"plantId": <plant id>} — saves THIS photo into that plant\'s gallery; use it ' +
    "whenever the user asks to add/attach/save this picture to a plant (you CAN do this — never " +
    "say the photo wasn't uploaded or that you need a URL).\n" +
    'FOLLOWUP: ["item 1", "item 2"] — optional, exactly one line, AFTER any action lines: 2-3 ' +
    "short items in the USER's voice — questions or commands they'd send you, never an offer " +
    'like "Would you like me to…" (see the FOLLOWUP rule).\n' +
    "Emit none of them when not genuinely warranted."
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
  ADD_TOOL: "add_tool",
  UPDATE_TOOL: "update_tool",
  REMOVE_TOOL: "remove_tool",
  ADD_ROUTINE: "add_routine",
  UPDATE_ROUTINE: "update_routine",
  COMPLETE_ROUTINE: "complete_routine",
  ATTACH_PHOTO: "attach_photo",
  SET_COVER: "set_cover",
  ADD_TOGET: "add_toget",
  UPDATE_TOGET: "update_toget",
  REMOVE_TOGET: "remove_toget",
  ADD_TODO: "add_todo",
  UPDATE_TODO: "update_todo",
  COMPLETE_TODO: "complete_todo",
  REMOVE_TODO: "remove_todo",
};
// NOTE: the TOGET alternatives come BEFORE the TODO ones — every keyword here
// is a complete token so neither can swallow the other, but keeping the longer
// "ADD_TOGET"/"UPDATE_TOGET" first makes that independent of the engine's
// leftmost-alternative rule (guarded by a test in run_app2.js).
const ACTION_START_RE =
  /(?:^|\n)[ \t>*`-]*(ADD_PLANT|UPDATE_PLANT|ADD_TOOL|UPDATE_TOOL|REMOVE_TOOL|ADD_ROUTINE|UPDATE_ROUTINE|COMPLETE_ROUTINE|ATTACH_PHOTO|SET_COVER|ADD_TOGET|UPDATE_TOGET|REMOVE_TOGET|ADD_TODO|UPDATE_TODO|COMPLETE_TODO|REMOVE_TODO)\**[ \t]*:[ \t\n]*\{/g;

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
  const cleanText = src
    .replace(/```[a-z]*\s*```/gi, "") // fences left empty after extraction
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, actions };
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
  await addPlant({
    name: fields.name || "New plant",
    notes: fields.notes || "",
    plantingDate: fields.plantingDate || "",
    location: fields.location || getDefaultLocation(),
    lastWatered: fields.lastWatered ? Date.parse(fields.lastWatered) || null : null,
    lastFertilized: fields.lastFertilized ? Date.parse(fields.lastFertilized) || null : null,
    tags: normTags(fields.tags),
  });
  ensureCodexResearch("plant", fields.name); // background — never blocks the add
}

async function applyToolAdd(fields) {
  await addTool({
    ...fields, // carries brand/condition/location/purchaseDate/price through
    name: fields.name || "New item",
    quantity: Number(fields.quantity) || 1,
    notes: fields.notes || "",
    tags: normTags(fields.tags),
    lastUsed: fields.lastUsed ? Date.parse(fields.lastUsed) || null : null,
  });
  ensureCodexResearch("tool", fields.name); // background — never blocks the add
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
    case "add":
      return { type: "add_plant", fields: action.fields || {} };
    case "add_tool":
      return { type: "add_tool", fields: action.fields || {} };
    case "add_routine":
      return { type: "add_routine", fields: action.fields || {} };
    case "add_toget":
      return { type: "add_toget", fields: action.fields || {} };
    case "update_toget": {
      const item = await resolveShoppingTarget(action);
      return item ? { type: "update_toget", item, fields: action.fields || {} } : null;
    }
    case "remove_toget": {
      const item = await resolveShoppingTarget(action);
      return item ? { type: "remove_toget", item } : null;
    }
    case "add_todo":
      return { type: "add_todo", fields: action.fields || {} };
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
    default:
      return null;
  }
}

function describeAction(a) {
  const fieldsText = (fields) =>
    Object.entries(fields || {})
      .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(", ");
  switch (a.type) {
    case "add_plant":
      return `Add plant "${a.fields.name || "New plant"}"`;
    case "update_plant":
      return `Update "${a.plant.name}": ${fieldsText(a.fields)}`;
    case "add_tool":
      return `Add "${a.fields.name || "New item"}" (x${a.fields.quantity || 1}) to inventory`;
    case "update_tool":
      return `Update "${a.tool.name}": ${fieldsText(a.fields)}`;
    case "remove_tool":
      return `Remove "${a.tool.name}" from inventory`;
    case "add_routine":
      return `Add routine "${a.fields.task || "New routine"}" (every ${a.fields.intervalDays || 1}d)`;
    case "update_routine":
      return `Update routine "${a.routine.task}": ${fieldsText(a.fields)}`;
    case "complete_routine":
      return `Mark routine "${a.routine.task}" done`;
    case "attach_photo":
      return `Add the chat photo to "${a.plant.name}"'s gallery`;
    case "set_cover":
      return `Set the chat photo as the cover of ${a.kindName} "${a.item.name || a.item.task}"`;
    case "add_toget":
      return `Add "${a.fields.name || "New item"}" to the to-get list`;
    case "update_toget":
      return a.fields && a.fields.done
        ? `Check off "${a.item.name}" on the to-get list`
        : `Update to-get "${a.item.name}": ${fieldsText(a.fields)}`;
    case "remove_toget":
      return `Remove "${a.item.name}" from the to-get list`;
    case "add_todo":
      return `Add to-do "${a.fields.text || "New task"}"${a.fields.dueDate ? ` (due ${a.fields.dueDate})` : ""}`;
    case "update_todo":
      return `Update to-do "${a.todo.text}": ${fieldsText(a.fields)}`;
    case "complete_todo":
      return `Tick off to-do "${a.todo.text}"`;
    case "remove_todo":
      return `Remove to-do "${a.todo.text}"`;
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
  return out;
}

async function runResolvedAction(a) {
  switch (a.type) {
    case "add_plant":
      return applyPlantAdd(a.fields);
    case "update_plant":
      return applyPlantUpdate(a.plant, a.fields);
    case "add_tool":
      return applyToolAdd(a.fields);
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
  }
}

// Shared by Chat/Garden/Inventory: resolves every action pulled from an AI
// reply, then either applies them immediately (auto mode) or queues them for
// the user to confirm. Pass setPendingActions=null where there's no confirm
// UI — confirm mode then skips writes entirely.
// ctx: { chatId } — lets attach_photo find photos in the current thread.
// Returns { applied: [description…], queued: n } so the caller can show the
// user visible proof of what was ACTUALLY saved (not just what the AI claims).
async function handleAiActions(actions, setPendingActions, ctx = {}) {
  const result = { applied: [], queued: 0 };
  if (!actions || !actions.length) return result;
  const confirmMode = getAiWriteMode() === "confirm";
  const resolved = [];
  for (const action of actions) {
    const r = await resolveAction(action, ctx);
    if (r) resolved.push(r);
  }
  if (!resolved.length) return result;
  if (confirmMode) {
    if (setPendingActions) {
      setPendingActions((prev) => {
        // Mirrored into queuedActionNotes inside the updater so the AI's
        // "NOT SAVED YET" list always matches the banner the user is looking
        // at — nothing here is written to the database yet.
        const next = [...(prev || []), ...resolved];
        setQueuedActions(next);
        return next;
      });
      result.queued = resolved.length;
    }
    return result;
  }
  for (const r of resolved) {
    await applyResolvedAction(r);
    result.applied.push(describeAction(r));
  }
  return result;
}
