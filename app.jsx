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
} from "./idb.js";

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
const LS_ACTIVE_CHAT = "gc_activeChatId";
const CONTEXT_LIMIT = 12; // how many past messages get sent back to the AI as context

const SYSTEM_PROMPT_BASE =
  "You are Sprout, a friendly, knowledgeable gardening companion. Give practical, " +
  "concrete advice (watering, light, soil, pests, timing) suited to home gardeners.";

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

// Builds the text-only context array the chat model sees, from stored history.
function buildContextMessages(history, mode) {
  const recent = history.slice(-CONTEXT_LIMIT);
  const sys =
    SYSTEM_PROMPT_BASE +
    (mode === "call"
      ? " The user is talking to you by voice on a phone call — keep replies short (1-3 sentences), conversational, and easy to read aloud."
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

// ---------- UI pieces ----------

function SettingsModal({ onClose, onCleared }) {
  const [apiBase, setApiBase] = useState(getSettings().apiBase);
  const [secret, setSecret] = useState(getSettings().secret);

  function save() {
    localStorage.setItem(LS_API_BASE, apiBase.trim());
    localStorage.setItem(LS_SECRET, secret.trim());
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
              <button className="icon-btn small" title="Rename" onClick={() => onRename(c)}>✏️</button>
              <button className="icon-btn small" title="Delete" onClick={() => onDelete(c)}>🗑️</button>
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
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);

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
        messages: buildContextMessages(nextHistory, "chat"),
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
      <div className="composer">
        <button
          className="icon-btn"
          title="Analyze a photo"
          onClick={() => fileInputRef.current.click()}
          disabled={busy}
        >
          📷
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
        messages: buildContextMessages(nextHistory, "call"),
      });
      const reply = data.reply || "Sorry, I didn't catch that.";
      const aiMsg = { chatId, role: "assistant", kind: "text", text: reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      speak(reply);
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

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState("chat");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatList, setShowChatList] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
        <button className="icon-btn" onClick={() => setShowChatList(true)} title="Chats">💬</button>
        <span className="app-title">🌱 Garden Companion</span>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
      </header>

      <nav className="tabs">
        <button className={tab === "chat" ? "tab active" : "tab"} onClick={() => setTab("chat")}>Chat</button>
        <button className={tab === "call" ? "tab active" : "tab"} onClick={() => setTab("call")}>Call</button>
      </nav>

      {loaded && tab === "chat" && (
        <ChatTab chatId={activeChatId} messages={messages} setMessages={setMessages} busy={busy} setBusy={setBusy} />
      )}
      {loaded && tab === "call" && (
        <CallTab chatId={activeChatId} messages={messages} setMessages={setMessages} />
      )}

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
