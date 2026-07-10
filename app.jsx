import { addMessage, getAllMessages, clearAllMessages } from "./idb.js";

const { useState, useEffect, useRef, useCallback } = React;

const LS_API_BASE = "gc_apiBase";
const LS_SECRET = "gc_clientSecret";
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
    if (!confirm("Delete all locally-stored conversation history? This can't be undone.")) return;
    await clearAllMessages();
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

function ChatTab({ messages, setMessages, busy, setBusy }) {
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
    const userMsg = { role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setBusy(true);
    try {
      const data = await apiFetch("/api/chat", {
        messages: buildContextMessages(nextHistory, "chat"),
      });
      const aiMsg = { role: "assistant", kind: "text", text: data.reply, createdAt: Date.now() };
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
      const aiMsg = { role: "assistant", kind: "text", text: data.reply, createdAt: Date.now() };
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

function CallTab({ messages, setMessages }) {
  const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SpeechRecognitionCtor && "speechSynthesis" in window;

  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | speaking
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const callActiveRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const startListening = useCallback(() => {
    if (!callActiveRef.current) return;
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
      // If nothing final came through and the call is still on, keep listening.
      if (callActiveRef.current && status !== "thinking" && status !== "speaking") {
        try {
          rec.start();
        } catch (_) {}
      }
    };

    recognitionRef.current = rec;
    setStatus("listening");
    setLiveTranscript("");
    rec.start();
  }, [status]);

  async function handleUserUtterance(text) {
    recognitionRef.current?.stop();
    setStatus("thinking");
    setLiveTranscript("");
    setError("");

    const userMsg = { role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messagesRef.current, userMsg];
    setMessages(nextHistory);

    try {
      const data = await apiFetch("/api/chat", {
        messages: buildContextMessages(nextHistory, "call"),
      });
      const reply = data.reply || "Sorry, I didn't catch that.";
      const aiMsg = { role: "assistant", kind: "text", text: reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      speak(reply);
    } catch (e) {
      setError(e.message);
      setStatus("listening");
      if (callActiveRef.current) startListening();
    }
  }

  function speak(text) {
    setStatus("speaking");
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.onend = () => {
      if (callActiveRef.current) startListening();
      else setStatus("idle");
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
    setStatus("idle");
    setLiveTranscript("");
    recognitionRef.current?.stop();
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
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState("chat");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAllMessages().then((history) => {
      setMessages(history);
      setLoaded(true);
      if (!getSettings().apiBase) setShowSettings(true);
    });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">🌱 Garden Companion</span>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
      </header>

      <nav className="tabs">
        <button className={tab === "chat" ? "tab active" : "tab"} onClick={() => setTab("chat")}>Chat</button>
        <button className={tab === "call" ? "tab active" : "tab"} onClick={() => setTab("call")}>Call</button>
      </nav>

      {loaded && tab === "chat" && (
        <ChatTab messages={messages} setMessages={setMessages} busy={busy} setBusy={setBusy} />
      )}
      {loaded && tab === "call" && (
        <CallTab messages={messages} setMessages={setMessages} />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onCleared={() => setMessages([])}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
