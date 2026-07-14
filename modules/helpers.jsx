// Shared constants, settings, and the AI/data helper functions used across
// every module. Loaded first (after idb.js) so everything below is a plain
// global by the time chat.jsx/call.jsx/garden.jsx/etc. run — see the note at
// the top of idb.js for why this app uses globals instead of import/export.

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
const LS_ACTIVE_CHAT = "gc_activeChatId";
const LS_AI_WRITE_MODE = "gc_aiWriteMode"; // 'auto' | 'confirm'
const LS_THEME = "gc_theme"; // 'dark' | 'light'
const LS_DEFAULT_LOCATION = "gc_defaultLocation";
const CONTEXT_LIMIT = 16; // how many past messages get sent back to the AI as context

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
  "services, RHS, Missouri Botanical Garden, etc.) when you can.";

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
    throw new Error(
      (data && data.error && (data.error.error?.message || data.error)) ||
        `Request failed (${res.status})`
    );
  }
  return data;
}

// ---------- codex research (auto-logging of new items) ----------

// Pulls a trailing "SOURCES: url1, url2" line off an AI reference reply.
// (Lives here, not codex.jsx, because auto-research below needs it too.)
function extractSources(text) {
  const match = text.match(/SOURCES:\s*(.+)\s*$/i);
  if (!match) return { body: text.trim(), sources: [] };
  const body = text.slice(0, match.index).trim();
  const raw = match[1].trim();
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
// Fire-and-forget: never blocks or breaks the add itself; skips duplicates.
// mode:"research" routes to the web-search-capable model chain server-side.
const codexInFlight = new Set(); // names being researched right now (dedupe)

async function ensureCodexResearch(kind, name) {
  const clean = (name || "").trim();
  if (!clean) return;
  const norm = clean.toLowerCase();
  if (codexInFlight.has(norm)) return;
  codexInFlight.add(norm);
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

// Reconciliation sweep: research any plant/tool that somehow has no codex
// entry yet (e.g. Groq was down at add time, or the item predates the codex
// feature). Runs on app load and whenever the Codex opens; capped per sweep
// so it can never burn through the free-tier quota in one go.
async function syncCodexEntries(maxNew = 3) {
  try {
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
      await ensureCodexResearch(item.kind, item.name); // sequential — gentle on the quota
    }
    return missing.length;
  } catch (e) {
    console.error("codex sync failed:", e.message);
    return 0;
  }
}

// ---------- AI context ----------

function tagsLabel(item) {
  const tags = item.tags || [];
  return tags.length ? ` [tags: ${tags.join(", ")}]` : "";
}

// Read-only snapshot of tools/routines/plants, injected into the system
// prompt so the AI knows the user's current garden state without needing
// any tool-calling machinery just to read data.
async function buildKnowledgeContext() {
  const [tools, routines, plants] = await Promise.all([
    getAllTools(),
    getAllRoutines(),
    getAllPlants(),
  ]);

  const parts = [];

  if (tools.length) {
    parts.push(
      "Tools/supplies: " +
        tools
          .map((t) => {
            const extras = [t.condition, t.location ? `stored: ${t.location}` : "", t.brand]
              .filter(Boolean)
              .join(", ");
            return `id:${t.id} "${t.name}" x${t.quantity}${extras ? ` (${extras})` : ""}${tagsLabel(t)}`;
          })
          .join(", ")
    );
  }

  if (routines.length) {
    parts.push(
      "Routines: " +
        routines
          .map((r) => {
            const status = isRoutineDue(r) ? "DUE" : "not due";
            const last = r.lastDone ? new Date(r.lastDone).toLocaleDateString() : "never";
            const link = r.plantId ? `, linked to plant id:${r.plantId}${r.careAction ? ` (${r.careAction})` : ""}` : "";
            return `id:${r.id} "${r.task}" (every ${r.intervalDays}d, last done ${last}, ${status}${link})${tagsLabel(r)}`;
          })
          .join("; ")
    );
  }

  if (plants.length) {
    parts.push(
      "Plants:\n" +
        plants
          .map((p) => {
            const w = p.lastWatered ? new Date(p.lastWatered).toLocaleDateString() : "never";
            const f = p.lastFertilized ? new Date(p.lastFertilized).toLocaleDateString() : "never";
            return `- id:${p.id} "${p.name}" | location: ${p.location || "unknown"} | planted: ${
              p.plantingDate || "unknown"
            } | last watered: ${w} | last fertilized: ${f}${tagsLabel(p)} | notes: ${p.notes || "none"}`;
          })
          .join("\n")
    );
  }

  if (!parts.length) return "\n\nThe user's garden data (plants, tools, routines) is currently empty.";
  return "\n\nCurrent garden data (for your reference):\n" + parts.join("\n");
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
  "WORKED EXAMPLES:\n" +
  'User says: "I bought 2 bags of tomato fertilizer and planted mint in the balcony pot" — ' +
  "your reply chats normally, then ends with these two lines:\n" +
  'ADD_TOOL: {"fields": {"name": "Tomato fertilizer", "quantity": 2, "tags": ["fertilizer", "consumable"]}}\n' +
  'ADD_PLANT: {"fields": {"name": "Mint", "location": "balcony pot", "tags": ["herb", "outdoor"]}}\n' +
  'User says: "add a note to the basil: it looked droopy this morning" (basil is id:4 with notes "from a cutting") — your reply ends with:\n' +
  'UPDATE_PLANT: {"id": 4, "fields": {"notes": "from a cutting; looked droopy this morning"}}\n' +
  "RULES:\n" +
  "- ACT IN THIS REPLY: when the user asks for a change, the action line(s) must be at the end " +
  "of THIS message — act first, then your visible text simply confirms it. NEVER answer " +
  '"I\'ll add it" or "Added!" without the line in the same reply, and never defer the action ' +
  "to a later turn. A reply that claims a change but has no action line is a failure.\n" +
  "- ALWAYS act on explicit commands — add, remove, update, note, log, track, remember — with the matching action line(s).\n" +
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
  "- Never invent changes the user didn't state, and don't re-emit an action already applied earlier in the conversation.";

// Short reminder appended AFTER the conversation history — models weight the
// end of the context most, and this is what finally made "add X" reliably act
// in the SAME reply instead of a later one.
const ACTION_REMINDER =
  "REMINDER — check before you answer: does the user's latest message ask to add, update, " +
  "remove, log, note, or track anything (plant, tool, routine, watering, purchase)? " +
  "If yes: end THIS reply with the matching action line(s), exactly per the formulas in your " +
  "instructions — act now, in this reply, never later. If unsure which item they mean, ask " +
  "instead and emit nothing. If a change was already applied earlier in the conversation, " +
  "don't re-emit it. Never claim a change without its action line in this same reply.";

// Builds the text-only context array the chat model sees, from stored history.
// Calls send a shorter tail — every spoken turn is a fresh request, and the
// smaller payload keeps them well under Groq's free-tier token-per-minute caps.
async function buildContextMessages(history, mode) {
  const recent = history.slice(mode === "call" ? -10 : -CONTEXT_LIMIT);
  const knowledge = await buildKnowledgeContext();
  const sys =
    SYSTEM_PROMPT_BASE +
    ` The user's device says it is now: ${deviceNow()}.` +
    (mode === "call"
      ? " The user is talking to you by voice on a phone call — keep replies short (1-3 sentences), conversational, and easy to read aloud. Never use markdown, bullet points, or emoji."
      : "") +
    knowledge +
    ACTION_CONVENTIONS;
  const msgs = [{ role: "system", content: sys }];
  for (const m of recent) {
    if (m.kind === "image") {
      msgs.push({
        role: m.role,
        content:
          m.role === "user"
            ? `[shared a photo] ${m.text || ""}`
            : m.text || "",
      });
    } else {
      msgs.push({ role: m.role, content: m.text || "" });
    }
  }
  msgs.push({ role: "system", content: ACTION_REMINDER });
  return msgs;
}

// Prompt for photos sent from the CHAT tab (the Garden detail page builds its
// own, pinned to a specific plant id). Gives the vision model the same garden
// awareness + write-back powers as the chat model.
async function buildChatVisionPrompt(caption) {
  const plants = await getAllPlants();
  const plantList = plants.length
    ? "The user's plants: " +
      plants.map((p) => `id:${p.id} "${p.name}" (${p.location || "unknown location"})`).join(", ") +
      ". "
    : "The user has no plants saved yet. ";
  return (
    "You are Sprout, a friendly gardening companion analyzing a photo for a home gardener. " +
    `The user's device says it is now: ${deviceNow()}. ` +
    plantList +
    "Identify the plant, assess its health from the photo, and give concrete care advice. " +
    `The user's question about this photo: "${caption}". ` +
    "If the photo clearly shows one of the user's saved plants and its record should change, " +
    'you may end your reply with ONE line, JSON on a single line, formatted exactly as ' +
    'UPDATE_PLANT: {"id": <plant id>, "fields": {"notes": "..."}} — or ADD_PLANT: {"fields": {...}} ' +
    "if they clearly want this new plant tracked. Never mention that line in your visible reply; " +
    "skip it entirely when not genuinely warranted."
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
};
const ACTION_LINE_RE =
  /^[\s>*`-]*(ADD_PLANT|UPDATE_PLANT|ADD_TOOL|UPDATE_TOOL|REMOVE_TOOL|ADD_ROUTINE|UPDATE_ROUTINE|COMPLETE_ROUTINE)\**\s*:\s*(\{.*\})[\s`*]*$/;

function extractActions(text) {
  const lines = (text || "").split("\n");
  const actions = [];
  const kept = [];
  for (const line of lines) {
    const match = line.match(ACTION_LINE_RE);
    if (match && actions.length < 12) {
      try {
        const payload = JSON.parse(match[2]);
        actions.push({ type: ACTION_TYPE_MAP[match[1]], ...payload });
        continue; // consumed — never shown to the user
      } catch (_) {
        // malformed JSON — keep the line visible rather than losing content
      }
    }
    kept.push(line);
  }
  // Remove code fences that only existed to wrap action lines (now empty).
  const cleanText = kept
    .join("\n")
    .replace(/```[a-z]*\s*```/gi, "")
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
  if (action.id != null) {
    const byId = plants.find((p) => p.id === action.id);
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
    const byId = tools.find((t) => t.id === action.id);
    if (byId) return byId;
  }
  if (action.name) {
    const lower = action.name.toLowerCase();
    const byName = tools.find((t) => (t.name || "").toLowerCase().includes(lower));
    if (byName) return byName;
  }
  return null;
}

async function resolveRoutineTarget(action) {
  const routines = await getAllRoutines();
  if (action.id != null) {
    const byId = routines.find((r) => r.id === action.id);
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
    await updatePlant(withLogEntry({ ...plant, lastWatered: Date.now() }, `Watered (routine: ${routine.task})`, "water"));
  } else if (routine.careAction === "fertilize") {
    await updatePlant(withLogEntry({ ...plant, lastFertilized: Date.now() }, `Fertilized (routine: ${routine.task})`, "fertilize"));
  }
}

// Turns a raw extracted action into a resolved, describable, applicable one.
// Returns null when the target no longer exists (stale id from the model).
async function resolveAction(action) {
  switch (action.type) {
    case "add":
      return { type: "add_plant", fields: action.fields || {} };
    case "add_tool":
      return { type: "add_tool", fields: action.fields || {} };
    case "add_routine":
      return { type: "add_routine", fields: action.fields || {} };
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
    default:
      return "Unknown change";
  }
}

async function applyResolvedAction(a) {
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
  }
}

// Shared by Chat/Call/Garden: resolves every action pulled from an AI reply,
// then either applies them immediately (auto mode) or queues them for the
// user to confirm. Pass setPendingActions=null where there's no confirm UI
// (voice calls) — confirm mode then skips writes entirely, as before.
async function handleAiActions(actions, setPendingActions) {
  if (!actions || !actions.length) return;
  const confirmMode = getAiWriteMode() === "confirm";
  const resolved = [];
  for (const action of actions) {
    const r = await resolveAction(action);
    if (r) resolved.push(r);
  }
  if (!resolved.length) return;
  if (confirmMode) {
    if (setPendingActions) setPendingActions((prev) => [...(prev || []), ...resolved]);
    return;
  }
  for (const r of resolved) {
    await applyResolvedAction(r);
  }
}
