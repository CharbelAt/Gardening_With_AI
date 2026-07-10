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
const CONTEXT_LIMIT = 12; // how many past messages get sent back to the AI as context

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

// ---------- helpers ----------

// Renders AI reply text as markdown when it looks like markdown (bold,
// lists, headers, links), sanitized before ever touching the DOM. Falls
// back to plain escaped text if the markdown libraries didn't load for some
// reason (e.g. CDN blocked) — never silently drops content.
function renderMarkdownSafe(text) {
  if (!text) return "";
  try {
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(text, { breaks: true });
      return window.DOMPurify.sanitize(html);
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
      "Tools/supplies: " + tools.map((t) => `id:${t.id} "${t.name}" x${t.quantity}`).join(", ")
    );
  }

  if (routines.length) {
    parts.push(
      "Routines: " +
        routines
          .map((r) => {
            const status = isRoutineDue(r) ? "DUE" : "not due";
            const last = r.lastDone ? new Date(r.lastDone).toLocaleDateString() : "never";
            return `${r.task} (every ${r.intervalDays}d, last done ${last}, ${status})`;
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
            } | last watered: ${w} | last fertilized: ${f} | notes: ${p.notes || "none"}`;
          })
          .join("\n")
    );
  }

  if (!parts.length) return "";
  return "\n\nCurrent garden data (for your reference):\n" + parts.join("\n");
}

// Builds the text-only context array the chat model sees, from stored history.
async function buildContextMessages(history, mode) {
  const recent = history.slice(-CONTEXT_LIMIT);
  const knowledge = await buildKnowledgeContext();
  const sys =
    SYSTEM_PROMPT_BASE +
    (mode === "call"
      ? " The user is talking to you by voice on a phone call — keep replies short (1-3 sentences), conversational, and easy to read aloud."
      : "") +
    knowledge +
    (knowledge
      ? "\n\nYou can propose changes to the garden data by ending your reply with ONE hidden " +
        "machine-readable line (never mention or explain it — it is not part of your visible reply). " +
        "Only ever include ONE such line, choosing whichever single change is most relevant:\n" +
        '- To update an existing plant (e.g. they watered it, fertilized it, or shared a new ' +
        'observation): UPDATE_PLANT: {"id": <plant id>, "fields": {"lastWatered": "2026-01-01", "notes": "..."}}\n' +
        '- To add a brand new plant the user mentions that isn\'t in the list above: ADD_PLANT: ' +
        '{"fields": {"name": "...", "location": "...", "plantingDate": "...", "notes": "..."}} ' +
        '— omit "location" entirely if the user didn\'t say where it is, a default will be used.\n' +
        '- To add a tool, pesticide, fertilizer, or other supply the user says they bought/have: ' +
        'ADD_TOOL: {"fields": {"name": "...", "quantity": 1, "notes": "..."}}\n' +
        '- To remove or use up a tool/supply the user says they got rid of, used up, or lost ' +
        '(match it against the Tools/supplies list above by id): REMOVE_TOOL: {"id": <tool id>}\n' +
        "Use today's date for lastWatered/lastFertilized, only include fields that should change, " +
        "and only add a line when a genuine change is warranted."
      : "");
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
  return msgs;
}

// Pulls a trailing hidden action line (ADD_PLANT/UPDATE_PLANT/ADD_TOOL/
// REMOVE_TOOL: {...}) out of an AI reply, if present.
const ACTION_TYPE_MAP = {
  ADD_PLANT: "add",
  UPDATE_PLANT: "update",
  ADD_TOOL: "add_tool",
  REMOVE_TOOL: "remove_tool",
};
function extractPlantUpdate(text) {
  const match = text.match(/(ADD_PLANT|UPDATE_PLANT|ADD_TOOL|REMOVE_TOOL):\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { cleanText: text, action: null };
  try {
    const payload = JSON.parse(match[2]);
    const cleanText = text.slice(0, match.index).trim();
    return { cleanText, action: { type: ACTION_TYPE_MAP[match[1]], ...payload } };
  } catch (_) {
    return { cleanText: text, action: null };
  }
}

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
    .map(([k, v]) => `${k} → ${v}`)
    .join(", ");
  let updated = { ...plant, ...fields };
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
  });
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

async function applyToolAdd(fields) {
  await addTool({
    name: fields.name || "New item",
    quantity: Number(fields.quantity) || 1,
    notes: fields.notes || "",
  });
}

async function applyToolRemove(tool) {
  await deleteTool(tool.id);
}

// Shared by Chat/Call: resolves + applies (or queues for confirmation) an
// ADD_PLANT/UPDATE_PLANT/ADD_TOOL/REMOVE_TOOL action extracted from an AI reply.
async function handlePlantAction(action, setPendingUpdate) {
  if (!action) return;
  const confirmMode = getAiWriteMode() === "confirm";

  if (action.type === "add") {
    if (confirmMode) setPendingUpdate({ type: "add", fields: action.fields || {} });
    else await applyPlantAdd(action.fields || {});
    return;
  }
  if (action.type === "add_tool") {
    if (confirmMode) setPendingUpdate({ type: "add_tool", fields: action.fields || {} });
    else await applyToolAdd(action.fields || {});
    return;
  }
  if (action.type === "remove_tool") {
    const tool = await resolveToolTarget(action);
    if (!tool) return;
    if (confirmMode) setPendingUpdate({ type: "remove_tool", tool });
    else await applyToolRemove(tool);
    return;
  }

  const plant = await resolvePlantTarget(action);
  if (!plant) return;
  if (confirmMode) setPendingUpdate({ type: "update", plant, fields: action.fields || {} });
  else await applyPlantUpdate(plant, action.fields || {});
}
