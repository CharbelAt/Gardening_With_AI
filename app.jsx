import {
  addMessage,
  getAllMessages,
  clearAllMessages,
  addChat,
  getAllChats,
  updateChat,
  deleteChat,
  clearAllChats,
  ensureDefaultChat,
  getMessagesByChat,
  addTool,
  getAllTools,
  deleteTool,
  addRoutine,
  getAllRoutines,
  deleteRoutine,
  updateRoutine,
  isRoutineDue,
  addPlant,
  getAllPlants,
  updatePlant,
  deletePlant,
} from "./idb.js";

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
const LS_ACTIVE_CHAT = "gc_activeChatId";
const LS_AI_WRITE_MODE = "gc_aiWriteMode"; // 'auto' | 'confirm'
const CONTEXT_LIMIT = 12; // how many past messages get sent back to the AI as context

function getAiWriteMode() {
  return localStorage.getItem(LS_AI_WRITE_MODE) || "auto";
}

const SYSTEM_PROMPT_BASE =
  "You are Sprout, a friendly, knowledgeable gardening companion. Give practical, " +
  "concrete advice (watering, light, soil, pests, timing) suited to home gardeners. " +
  "If you're not fully confident about a specific fact — exact species identification, " +
  "disease diagnosis, or precise care details — say so plainly rather than guessing " +
  "confidently, and search for or reference a trusted source (university extension " +
  "services, RHS, Missouri Botanical Garden, etc.) when you can.";

// ---------- helpers ----------

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
    parts.push("Tools: " + tools.map((t) => `${t.name} x${t.quantity}`).join(", "));
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
      ? '\n\nIf the user tells you something that should update one of these plant records (e.g. they watered it, fertilized it, or shared a new observation), end your reply with a new line formatted EXACTLY as: UPDATE_PLANT: {"id": <plant id>, "fields": {"lastWatered": "2026-01-01", "notes": "..."}} — use today\'s date for lastWatered/lastFertilized, only include fields that should change, and only add this line when a genuine update is warranted. Never mention this line to the user or explain it; it is a hidden machine-readable instruction, not part of your visible reply.'
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

// Pulls a trailing "UPDATE_PLANT: {...}" line out of an AI reply, if present.
function extractPlantUpdate(text) {
  const match = text.match(/UPDATE_PLANT:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { cleanText: text, update: null };
  try {
    const update = JSON.parse(match[1]);
    const cleanText = text.slice(0, match.index).trim();
    return { cleanText, update };
  } catch (_) {
    return { cleanText: text, update: null };
  }
}

async function resolvePlantTarget(update) {
  const plants = await getAllPlants();
  if (update.id != null) {
    const byId = plants.find((p) => p.id === update.id);
    if (byId) return byId;
  }
  if (update.name) {
    const lower = update.name.toLowerCase();
    const byName = plants.find((p) => (p.name || "").toLowerCase().includes(lower));
    if (byName) return byName;
  }
  return null;
}

async function applyPlantUpdate(plant, fields) {
  await updatePlant({ ...plant, ...fields });
}

// ---------- UI pieces ----------

function SettingsModal({ onClose, onCleared }) {
  const [apiBase, setApiBase] = useState(getSettings().apiBase);
  const [secret, setSecret] = useState(getSettings().secret);
  const [writeMode, setWriteMode] = useState(getAiWriteMode());

  function save() {
    localStorage.setItem(LS_API_BASE, apiBase.trim());
    localStorage.setItem(LS_SECRET, secret.trim());
    localStorage.setItem(LS_AI_WRITE_MODE, writeMode);
    onClose();
  }

  async function clearMemory() {
    if (!confirm("Delete ALL chats and conversation history on this device? This can't be undone.")) return;
    await clearAllMessages();
    await clearAllChats();
    onCleared();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          VPS API URL
          <input
            type="text"
            placeholder="https://your-vps-domain.com"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
          />
        </label>
        <label>
          Client secret
          <input
            type="password"
            placeholder="matches CLIENT_SECRET on your server"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label>
          AI plant updates
          <select value={writeMode} onChange={(e) => setWriteMode(e.target.value)}>
            <option value="auto">Apply automatically</option>
            <option value="confirm">Ask before saving</option>
          </select>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={save}>Save</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
        <hr />
        <p className="hint">Conversation memory is stored only in this browser.</p>
        <button className="btn btn-danger" onClick={clearMemory}>Clear local memory</button>
      </div>
    </div>
  );
}

function ChatListModal({ chats, activeChatId, onSwitch, onNew, onRename, onDelete, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Chats</h2>
        <div className="chat-list">
          {chats.map((c) => (
            <div key={c.id} className={c.id === activeChatId ? "chat-row active" : "chat-row"}>
              <button className="chat-row-title" onClick={() => onSwitch(c.id)}>
                {c.title || "Untitled chat"}
              </button>
              <button className="icon-btn small" title="Rename" onClick={() => onRename(c)}><i className="bi bi-pencil"></i></button>
              <button className="icon-btn small" title="Delete" onClick={() => onDelete(c)}><i className="bi bi-trash"></i></button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onNew}>+ New chat</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  return (
    <div className={`bubble ${msg.role}`}>
      {msg.kind === "image" && msg.imageThumb && (
        <img className="bubble-img" src={msg.imageThumb} alt="uploaded plant" />
      )}
      {msg.text && <div className="bubble-text">{msg.text}</div>}
    </div>
  );
}

function ChatTab({ chatId, messages, setMessages, busy, setBusy }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);

  async function confirmPendingUpdate() {
    if (!pendingUpdate) return;
    await applyPlantUpdate(pendingUpdate.plant, pendingUpdate.fields);
    setPendingUpdate(null);
  }

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function sendText() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    const userMsg = { chatId, role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setBusy(true);
    try {
      const data = await apiFetch("/api/chat", {
        messages: await buildContextMessages(nextHistory, "chat"),
      });
      const { cleanText, update } = extractPlantUpdate(data.reply || "");
      const aiMsg = { chatId, role: "assistant", kind: "text", text: cleanText, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      if (update) await handlePlantUpdate(update);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePlantUpdate(update) {
    const plant = await resolvePlantTarget(update);
    if (!plant) return;
    if (getAiWriteMode() === "confirm") {
      setPendingUpdate({ plant, fields: update.fields || {} });
    } else {
      await applyPlantUpdate(plant, update.fields || {});
    }
  }

  async function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    setError("");
    setBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const [, base64] = dataUrl.split(",");
      const userMsg = {
        chatId,
        role: "user",
        kind: "image",
        text: "What's going on with this plant?",
        imageThumb: dataUrl,
        createdAt: Date.now(),
      };
      userMsg.id = await addMessage(userMsg);
      setMessages((prev) => [...prev, userMsg]);

      const data = await apiFetch("/api/vision", {
        imageBase64: base64,
        mimeType: "image/jpeg",
        prompt:
          "Identify this plant, assess its health from the photo, and give concrete gardening care advice.",
      });
      const aiMsg = { chatId, role: "assistant", kind: "text", text: data.reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tab-panel chat-tab">
      <div className="messages">
        {messages.length === 0 && (
          <p className="empty-hint">Ask a gardening question or snap a photo of a plant to get started.</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {busy && <div className="bubble assistant typing">…</div>}
        <div ref={scrollRef} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {pendingUpdate && (
        <div className="confirm-banner">
          <span>
            Update "{pendingUpdate.plant.name}": {Object.entries(pendingUpdate.fields).map(([k, v]) => `${k} → ${v}`).join(", ")}?
          </span>
          <div className="confirm-actions">
            <button className="btn small" onClick={confirmPendingUpdate}>Apply</button>
            <button className="btn btn-ghost small" onClick={() => setPendingUpdate(null)}>Dismiss</button>
          </div>
        </div>
      )}
      <div className="composer">
        <button
          className="icon-btn"
          title="Analyze a photo"
          onClick={() => fileInputRef.current.click()}
          disabled={busy}
        >
          <i className="bi bi-camera"></i>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />
        <input
          className="text-input"
          type="text"
          placeholder="Ask Sprout something…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendText()}
          disabled={busy}
        />
        <button className="btn" onClick={sendText} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function CallTab({ chatId, messages, setMessages }) {
  const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SpeechRecognitionCtor && "speechSynthesis" in window;

  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | speaking
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const callActiveRef = useRef(false);
  const statusRef = useRef("idle");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  function updateStatus(next) {
    statusRef.current = next;
    setStatus(next);
  }

  // Kills whatever recognizer is currently running, detaching its onend first
  // so stopping it doesn't trigger the auto-restart logic below.
  function killRecognition() {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.abort();
      } catch (_) {}
      recognitionRef.current = null;
    }
  }

  const startListening = useCallback(() => {
    if (!callActiveRef.current) return;
    killRecognition(); // never run two recognizers at once

    const rec = new SpeechRecognitionCtor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      setLiveTranscript(interim || finalText);
      if (finalText.trim()) handleUserUtterance(finalText.trim());
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(`Mic error: ${e.error}`);
    };

    rec.onend = () => {
      // Only auto-restart if we're still supposed to be in the listening
      // phase (e.g. it timed out on silence). Reading statusRef here instead
      // of the React state avoids a stale-closure bug where this handler
      // would restart the mic during "thinking"/"speaking" and pick up the
      // AI's own voice as new input.
      if (callActiveRef.current && statusRef.current === "listening") {
        try {
          rec.start();
        } catch (_) {}
      }
    };

    recognitionRef.current = rec;
    updateStatus("listening");
    setLiveTranscript("");
    rec.start();
  }, []);

  async function handleUserUtterance(text) {
    killRecognition();
    updateStatus("thinking");
    setLiveTranscript("");
    setError("");

    const userMsg = { chatId, role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messagesRef.current, userMsg];
    setMessages(nextHistory);

    try {
      const data = await apiFetch("/api/chat", {
        messages: await buildContextMessages(nextHistory, "call"),
      });
      const { cleanText, update } = extractPlantUpdate(data.reply || "");
      const reply = cleanText || "Sorry, I didn't catch that.";
      const aiMsg = { chatId, role: "assistant", kind: "text", text: reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      speak(reply);
      // Voice calls apply updates only in auto mode — there's no good way to
      // show a confirm prompt mid-call, so confirm-mode just skips writing.
      if (update && getAiWriteMode() === "auto") {
        const plant = await resolvePlantTarget(update);
        if (plant) await applyPlantUpdate(plant, update.fields || {});
      }
    } catch (e) {
      setError(e.message);
      if (callActiveRef.current) startListening();
      else updateStatus("idle");
    }
  }

  function speak(text) {
    killRecognition(); // guarantee the mic is off before we start talking
    updateStatus("speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.onend = () => {
      // Short pause lets the phone speaker's audio tail die out before the
      // mic reopens, so it doesn't hear its own reply as new input.
      setTimeout(() => {
        if (callActiveRef.current) startListening();
        else updateStatus("idle");
      }, 500);
    };
    utter.onerror = () => {
      if (callActiveRef.current) startListening();
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function startCall() {
    setError("");
    callActiveRef.current = true;
    setCallActive(true);
    startListening();
  }

  function endCall() {
    callActiveRef.current = false;
    setCallActive(false);
    updateStatus("idle");
    setLiveTranscript("");
    killRecognition();
    window.speechSynthesis.cancel();
  }

  useEffect(() => () => endCall(), []); // stop everything if the tab unmounts

  if (!supported) {
    return (
      <div className="tab-panel call-tab">
        <p className="empty-hint">
          Voice calls need browser speech recognition, which isn't available here.
          Try Chrome on Android.
        </p>
      </div>
    );
  }

  const statusLabel = {
    idle: "Tap to start a call",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  }[status];

  return (
    <div className="tab-panel call-tab">
      <div className={`call-orb ${status}`} />
      <p className="call-status">{statusLabel}</p>
      {liveTranscript && <p className="live-transcript">"{liveTranscript}"</p>}
      {error && <div className="error-banner">{error}</div>}
      {!callActive ? (
        <button className="btn btn-call" onClick={startCall}>Start Call</button>
      ) : (
        <button className="btn btn-end-call" onClick={endCall}>End Call</button>
      )}
    </div>
  );
}

// ---------- side drawer + help ----------

function SideDrawer({ onClose, onNavigate }) {
  const rows = [
    { key: "garden", label: "Garden", icon: "bi-flower3" },
    { key: "inventory", label: "Inventory", icon: "bi-box-seam" },
    { key: "routines", label: "Routines", icon: "bi-arrow-repeat" },
    { key: "codex", label: "Codex", icon: "bi-book" },
    { key: "settings", label: "Settings", icon: "bi-gear" },
    { key: "help", label: "Help", icon: "bi-question-circle" },
  ];
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <span className="app-title"><i className="bi bi-flower1"></i> Garden Companion</span>
          <button className="icon-btn" onClick={onClose}><i className="bi bi-x-lg"></i></button>
        </div>
        {rows.map((r) => (
          <button key={r.key} className="drawer-row" onClick={() => onNavigate(r.key)}>
            <i className={`bi ${r.icon}`}></i>
            <span>{r.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function HelpModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <h2>How to use Garden Companion</h2>
        <div className="help-content">
          <h3>Chat</h3>
          <p>Type gardening questions to Sprout. Tap the camera icon to analyze a photo of a plant — it'll identify it and assess its health.</p>
          <h3>Call</h3>
          <p>Tap Start Call for a hands-free voice conversation. Speak, wait for the reply, then keep talking. Works best in Chrome on Android.</p>
          <h3>Chats</h3>
          <p>The chat bubble icon at the top lets you keep separate conversation threads, rename them, or start a new one.</p>
          <h3>Garden</h3>
          <p>Track your individual plants: name, location, planting date, and care history. Take photos from a plant's page to build a history and let the AI suggest updates to its record.</p>
          <h3>Inventory</h3>
          <p>A simple list of your gardening tools and how many of each you have.</p>
          <h3>Routines</h3>
          <p>Recurring care tasks (watering, fertilizing) with a due/overdue indicator. Tap Done when you complete one — no push notifications, just check the app.</p>
          <h3>Codex</h3>
          <p>A quick-reference library of common plants, pests, and gardening topics — browse or search it any time.</p>
          <h3>Settings</h3>
          <p>Set your backend URL and client secret (from your VPS), choose whether AI-suggested plant updates apply automatically or ask first, and clear local data if needed.</p>
          <h3>Your data</h3>
          <p>Everything (chats, plants, tools, routines) is stored only in this browser — nothing is synced anywhere else.</p>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- inventory ----------

function InventoryView({ onBack }) {
  const [tools, setTools] = useState([]);
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);

  async function refresh() {
    setTools(await getAllTools());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!name.trim()) return;
    await addTool({ name: name.trim(), quantity: Number(qty) || 1 });
    setName("");
    setQty(1);
    refresh();
  }

  async function remove(id) {
    await deleteTool(id);
    refresh();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Inventory</h2>
      </div>
      <div className="list-add-row">
        <input placeholder="Tool name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="qty-input"
        />
        <button className="btn" onClick={add}>Add</button>
      </div>
      <div className="simple-list">
        {tools.length === 0 && <p className="empty-hint">No tools yet — add your first one above.</p>}
        {tools.map((t) => (
          <div key={t.id} className="simple-list-row">
            <span>{t.name} × {t.quantity}</span>
            <button className="icon-btn small" onClick={() => remove(t.id)}><i className="bi bi-trash"></i></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- routines ----------

function RoutinesView({ onBack }) {
  const [routines, setRoutines] = useState([]);
  const [task, setTask] = useState("");
  const [interval, setInterval_] = useState(3);

  async function refresh() {
    setRoutines(await getAllRoutines());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!task.trim()) return;
    await addRoutine({ task: task.trim(), intervalDays: Number(interval) || 1 });
    setTask("");
    setInterval_(3);
    refresh();
  }

  async function markDone(r) {
    await updateRoutine({ ...r, lastDone: Date.now() });
    refresh();
  }

  async function remove(id) {
    await deleteRoutine(id);
    refresh();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Routines</h2>
      </div>
      <div className="list-add-row">
        <input placeholder="e.g. Water tomatoes" value={task} onChange={(e) => setTask(e.target.value)} />
        <input
          type="number"
          min="1"
          title="Every N days"
          value={interval}
          onChange={(e) => setInterval_(e.target.value)}
          className="qty-input"
        />
        <button className="btn" onClick={add}>Add</button>
      </div>
      <div className="simple-list">
        {routines.length === 0 && <p className="empty-hint">No routines yet — add a recurring task above.</p>}
        {routines.map((r) => {
          const due = isRoutineDue(r);
          return (
            <div key={r.id} className={due ? "routine-row due" : "routine-row"}>
              <div>
                <div className="routine-task">{r.task}{due && <span className="due-badge">Due</span>}</div>
                <div className="routine-meta">
                  Every {r.intervalDays}d · {r.lastDone ? `last done ${new Date(r.lastDone).toLocaleDateString()}` : "never done"}
                </div>
              </div>
              <div className="routine-actions">
                <button className="btn btn-ghost small" onClick={() => markDone(r)}>Done</button>
                <button className="icon-btn small" onClick={() => remove(r.id)}><i className="bi bi-trash"></i></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- garden (plants) ----------

function AddPlantModal({ onClose, onAdded }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [plantingDate, setPlantingDate] = useState("");
  const [notes, setNotes] = useState("");

  async function save() {
    if (!name.trim()) return;
    await addPlant({ name: name.trim(), location, plantingDate, notes });
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add plant</h2>
        <label>
          Name / species
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tomato #1" />
        </label>
        <label>
          Location
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. backyard bed" />
        </label>
        <label>
          Planting date
          <input type="date" value={plantingDate} onChange={(e) => setPlantingDate(e.target.value)} />
        </label>
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PlantDetail({ plant, onBack, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: plant.name || "",
    location: plant.location || "",
    plantingDate: plant.plantingDate || "",
    notes: plant.notes || "",
  });
  const fileInputRef = useRef(null);

  async function saveForm() {
    await updatePlant({ ...plant, ...form });
    setEditing(false);
    onChanged();
  }

  async function markWatered() {
    await updatePlant({ ...plant, lastWatered: Date.now() });
    onChanged();
  }
  async function markFertilized() {
    await updatePlant({ ...plant, lastFertilized: Date.now() });
    onChanged();
  }

  async function removePlant() {
    if (!confirm(`Delete "${plant.name}" and its photo history? This can't be undone.`)) return;
    await deletePlant(plant.id);
    onBack();
    onChanged();
  }

  async function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    setError("");
    setBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const [, base64] = dataUrl.split(",");
      const prompt =
        `You are analyzing a photo of the user's plant "${plant.name}" ` +
        `(location: ${plant.location || "unknown"}, planted: ${plant.plantingDate || "unknown"}, ` +
        `current notes: ${plant.notes || "none"}). Identify visible health issues and give care advice. ` +
        `If this photo suggests an update to this plant's record, end your reply with a new line formatted ` +
        `EXACTLY as: UPDATE_PLANT: {"id": ${plant.id}, "fields": {"notes": "..."}} — only include fields that ` +
        `should change, and only add this line if genuinely warranted. Never mention this line in your visible reply.`;

      const data = await apiFetch("/api/vision", { imageBase64: base64, mimeType: "image/jpeg", prompt });
      const { cleanText, update } = extractPlantUpdate(data.reply || "");

      const updatedPlant = {
        ...plant,
        photoHistory: [...(plant.photoHistory || []), { imageThumb: dataUrl, analysis: cleanText, date: Date.now() }],
      };
      await updatePlant(updatedPlant);
      onChanged();

      if (update) {
        if (getAiWriteMode() === "confirm") {
          setPendingUpdate({ plant: updatedPlant, fields: update.fields || {} });
        } else {
          await applyPlantUpdate(updatedPlant, update.fields || {});
          onChanged();
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPendingUpdate() {
    if (!pendingUpdate) return;
    await applyPlantUpdate(pendingUpdate.plant, pendingUpdate.fields);
    setPendingUpdate(null);
    onChanged();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{plant.name || "Unnamed plant"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)}><i className="bi bi-pencil"></i></button>
      </div>

      <div className="plant-detail">
        <div className="plant-facts">
          <div><i className="bi bi-geo-alt"></i> {plant.location || "no location set"}</div>
          <div><i className="bi bi-calendar3"></i> planted {plant.plantingDate || "unknown"}</div>
          <div><i className="bi bi-droplet"></i> watered {plant.lastWatered ? new Date(plant.lastWatered).toLocaleDateString() : "never"}</div>
          <div><i className="bi bi-flower2"></i> fertilized {plant.lastFertilized ? new Date(plant.lastFertilized).toLocaleDateString() : "never"}</div>
          {plant.notes && <div className="plant-notes"><i className="bi bi-journal-text"></i> {plant.notes}</div>}
        </div>

        <div className="plant-quick-actions">
          <button className="btn small" onClick={markWatered}>Mark watered</button>
          <button className="btn small" onClick={markFertilized}>Mark fertilized</button>
          <button className="btn small" onClick={() => fileInputRef.current.click()} disabled={busy}>
            <i className="bi bi-camera"></i> {busy ? "Analyzing…" : "Add photo"}
          </button>
          <button className="btn btn-danger small" onClick={removePlant}>Delete plant</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />

        {error && <div className="error-banner">{error}</div>}
        {pendingUpdate && (
          <div className="confirm-banner">
            <span>
              Update record: {Object.entries(pendingUpdate.fields).map(([k, v]) => `${k} → ${v}`).join(", ")}?
            </span>
            <div className="confirm-actions">
              <button className="btn small" onClick={confirmPendingUpdate}>Apply</button>
              <button className="btn btn-ghost small" onClick={() => setPendingUpdate(null)}>Dismiss</button>
            </div>
          </div>
        )}

        <h3>Photo history</h3>
        {(!plant.photoHistory || plant.photoHistory.length === 0) && (
          <p className="empty-hint">No photos yet — tap "Add photo" above.</p>
        )}
        <div className="photo-history">
          {(plant.photoHistory || [])
            .slice()
            .reverse()
            .map((p, i) => (
              <div key={i} className="photo-history-item">
                <img src={p.imageThumb} alt="" />
                <div>
                  <div className="photo-date">{new Date(p.date).toLocaleDateString()}</div>
                  <div className="photo-analysis">{p.analysis}</div>
                </div>
              </div>
            ))}
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit plant</h2>
            <label>
              Name / species
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Location
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </label>
            <label>
              Planting date
              <input
                type="date"
                value={form.plantingDate}
                onChange={(e) => setForm({ ...form, plantingDate: e.target.value })}
              />
            </label>
            <label>
              Notes
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={saveForm}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GardenView({ onBack }) {
  const [plants, setPlants] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setPlants(await getAllPlants());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = plants.find((p) => p.id === selectedId) || null;

  if (selected) {
    return <PlantDetail plant={selected} onBack={() => setSelectedId(null)} onChanged={refresh} />;
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Garden</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)}><i className="bi bi-plus-lg"></i></button>
      </div>
      <div className="plant-grid">
        {plants.length === 0 && <p className="empty-hint">No plants yet — tap + to add one.</p>}
        {plants.map((p) => (
          <button key={p.id} className="plant-card" onClick={() => setSelectedId(p.id)}>
            {p.photoHistory && p.photoHistory.length > 0 ? (
              <img src={p.photoHistory[p.photoHistory.length - 1].imageThumb} alt={p.name} />
            ) : (
              <div className="plant-card-placeholder"><i className="bi bi-flower3"></i></div>
            )}
            <span>{p.name || "Unnamed plant"}</span>
          </button>
        ))}
      </div>
      {showAdd && (
        <AddPlantModal
          onClose={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------- codex (static reference library) ----------

const CODEX_ENTRIES = [
  { title: "Tomatoes", body: "6-8 hours direct sun. Water deeply and consistently — irregular watering causes blossom end rot. Stake or cage for support. Feed every 2-3 weeks once fruiting starts." },
  { title: "Basil", body: "Loves warmth and sun (6+ hours). Pinch off flower buds to keep leaves coming. Water when the top inch of soil is dry — avoid soggy roots." },
  { title: "Roses", body: "Full sun, well-drained soil. Water at the base, not the leaves, to avoid fungal disease. Prune in late winter/early spring. Feed monthly during growing season." },
  { title: "Succulents", body: "Bright light, minimal water — let soil dry out completely between waterings. Overwatering is the #1 killer. Use gritty, fast-draining soil." },
  { title: "Pothos", body: "Tolerates low light but grows faster in bright, indirect light. Water when top 1-2 inches of soil are dry. Very forgiving — good for beginners." },
  { title: "Lettuce", body: "Cool-season crop, partial shade in hot climates. Keep soil consistently moist. Harvest outer leaves to extend the plant's life." },
  { title: "Peppers", body: "Full sun, warm soil. Water consistently; inconsistent watering causes blossom drop. Feed with a balanced or low-nitrogen fertilizer once flowering." },
  { title: "Lavender", body: "Full sun, very well-drained (even poor) soil. Overwatering kills it faster than drought. Prune after flowering to keep it compact." },
  { title: "Mint", body: "Spreads aggressively — grow in a container to contain roots. Tolerates partial shade. Keep soil moist; pinch back to encourage bushiness." },
  { title: "Aphids (pest)", body: "Small sap-sucking insects, often clustered on new growth. Spray off with water, or use insecticidal soap/neem oil. Ladybugs are a natural predator." },
  { title: "Powdery mildew (disease)", body: "White powdery coating on leaves, common in humid conditions with poor airflow. Improve air circulation, avoid overhead watering, treat with a sulfur or potassium bicarbonate fungicide." },
  { title: "Overwatering signs", body: "Yellowing leaves, soft/mushy stems, wilting despite wet soil, root rot smell. Let soil dry out and check drainage before watering again." },
  { title: "Underwatering signs", body: "Dry, crispy leaf edges, drooping, soil pulling away from pot edges. Water deeply and check moisture more frequently." },
  { title: "Composting basics", body: "Balance 'greens' (nitrogen: food scraps, grass) with 'browns' (carbon: dry leaves, cardboard). Turn regularly for airflow. Should smell earthy, not rotten." },
  { title: "Soil pH basics", body: "Most vegetables prefer slightly acidic to neutral soil (6.0-7.0). Acid-lovers (blueberries, azaleas) want lower pH (~5.0-5.5). Test with a cheap soil pH kit before amending." },
];

function CodexView({ onBack }) {
  const [query, setQuery] = useState("");
  const filtered = CODEX_ENTRIES.filter(
    (e) =>
      e.title.toLowerCase().includes(query.toLowerCase()) ||
      e.body.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Codex</h2>
      </div>
      <input
        className="text-input codex-search"
        placeholder="Search plants, pests, topics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="codex-list">
        {filtered.map((e) => (
          <div key={e.title} className="codex-entry">
            <h3>{e.title}</h3>
            <p>{e.body}</p>
          </div>
        ))}
        {filtered.length === 0 && <p className="empty-hint">No matches — try a different search.</p>}
      </div>
    </div>
  );
}

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState("chat");
  const [view, setView] = useState(null); // null = show chat/call tabs; else 'garden'|'inventory'|'routines'|'codex'
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatList, setShowChatList] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);

  function navigateFromDrawer(key) {
    setShowDrawer(false);
    if (key === "settings") setShowSettings(true);
    else if (key === "help") setShowHelp(true);
    else setView(key);
  }

  // Initial load: run the one-time migration, figure out which chat is
  // active, and load its messages.
  useEffect(() => {
    (async () => {
      const defaultId = await ensureDefaultChat();
      const allChats = await getAllChats();
      setChats(allChats);

      const stored = Number(localStorage.getItem(LS_ACTIVE_CHAT));
      const activeId = allChats.some((c) => c.id === stored) ? stored : defaultId;
      setActiveChatId(activeId);

      const history = await getMessagesByChat(activeId);
      setMessages(history);
      setLoaded(true);
      if (!getSettings().apiBase) setShowSettings(true);
    })();
  }, []);

  async function switchChat(id) {
    setActiveChatId(id);
    localStorage.setItem(LS_ACTIVE_CHAT, String(id));
    const history = await getMessagesByChat(id);
    setMessages(history);
    setShowChatList(false);
  }

  async function newChat() {
    const id = await addChat({ title: `Chat ${chats.length + 1}` });
    const allChats = await getAllChats();
    setChats(allChats);
    await switchChat(id);
  }

  async function renameChat(chat) {
    const title = prompt("Rename chat", chat.title);
    if (!title || !title.trim()) return;
    await updateChat({ ...chat, title: title.trim() });
    setChats(await getAllChats());
  }

  async function removeChat(chat) {
    if (!confirm(`Delete "${chat.title}" and all its messages? This can't be undone.`)) return;
    await deleteChat(chat.id);
    const allChats = await getAllChats();
    if (allChats.length === 0) {
      // Always keep at least one chat around.
      const id = await ensureDefaultChat();
      setChats(await getAllChats());
      await switchChat(id);
    } else {
      setChats(allChats);
      if (chat.id === activeChatId) await switchChat(allChats[0].id);
    }
  }

  async function onMemoryCleared() {
    const id = await ensureDefaultChat();
    setChats(await getAllChats());
    await switchChat(id);
  }

  return (
    <div className="app">
      <header className="app-header">
        <button className="icon-btn" onClick={() => setShowChatList(true)} title="Chats"><i className="bi bi-chat-dots"></i></button>
        <span className="app-title"><i className="bi bi-flower1"></i> Garden Companion</span>
        <button className="icon-btn" onClick={() => setShowDrawer(true)} title="Menu"><i className="bi bi-gear"></i></button>
      </header>

      {view === null && (
        <nav className="tabs">
          <button className={tab === "chat" ? "tab active" : "tab"} onClick={() => setTab("chat")}>Chat</button>
          <button className={tab === "call" ? "tab active" : "tab"} onClick={() => setTab("call")}>Call</button>
        </nav>
      )}

      {view === null && loaded && tab === "chat" && (
        <ChatTab chatId={activeChatId} messages={messages} setMessages={setMessages} busy={busy} setBusy={setBusy} />
      )}
      {view === null && loaded && tab === "call" && (
        <CallTab chatId={activeChatId} messages={messages} setMessages={setMessages} />
      )}
      {view === "garden" && <GardenView onBack={() => setView(null)} />}
      {view === "inventory" && <InventoryView onBack={() => setView(null)} />}
      {view === "routines" && <RoutinesView onBack={() => setView(null)} />}
      {view === "codex" && <CodexView onBack={() => setView(null)} />}

      {showChatList && (
        <ChatListModal
          chats={chats}
          activeChatId={activeChatId}
          onSwitch={switchChat}
          onNew={newChat}
          onRename={renameChat}
          onDelete={removeChat}
          onClose={() => setShowChatList(false)}
        />
      )}

      {showDrawer && (
        <SideDrawer onClose={() => setShowDrawer(false)} onNavigate={navigateFromDrawer} />
      )}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onCleared={onMemoryCleared}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
