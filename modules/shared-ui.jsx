// App-shell / reusable UI: confirm & prompt dialogs, settings, the chat
// switcher, message bubbles, the side drawer, and the help manual.

// Generic replacements for window.confirm()/prompt() — styled to match the
// app instead of the browser's native dialog boxes.
function ConfirmModal({ title = "Are you sure?", message, confirmLabel = "Delete", danger = true, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="hint">{message}</p>
        <div className="modal-actions">
          <button className={danger ? "btn btn-danger" : "btn"} onClick={onConfirm}>{confirmLabel}</button>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PromptModal({ title = "Enter a value", label, initialValue = "", confirmLabel = "Save", onConfirm, onCancel }) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <label>
          {label}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && onConfirm(value.trim())}
          />
        </label>
        <div className="modal-actions">
          <button className="btn" disabled={!value.trim()} onClick={() => onConfirm(value.trim())}>{confirmLabel}</button>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ onClose, onCleared, theme, onThemeChange }) {
  const [apiBase, setApiBase] = useState(getSettings().apiBase);
  const [secret, setSecret] = useState(getSettings().secret);
  const [writeMode, setWriteMode] = useState(getAiWriteMode());
  const [defaultLocation, setDefaultLocation] = useState(getDefaultLocation());
  const [confirmClear, setConfirmClear] = useState(false);

  function save() {
    localStorage.setItem(LS_API_BASE, apiBase.trim());
    localStorage.setItem(LS_SECRET, secret.trim());
    localStorage.setItem(LS_AI_WRITE_MODE, writeMode);
    localStorage.setItem(LS_DEFAULT_LOCATION, defaultLocation.trim());
    onClose();
  }

  async function clearMemory() {
    await clearAllMessages();
    await clearAllChats();
    setConfirmClear(false);
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
        <label>
          Theme
          <select value={theme} onChange={(e) => onThemeChange(e.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          Default plant location
          <input
            type="text"
            placeholder="e.g. Backyard (used when the AI doesn't state one)"
            value={defaultLocation}
            onChange={(e) => setDefaultLocation(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={save}>Save</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
        <hr />
        <p className="hint">Conversation memory is stored only in this browser.</p>
        <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>Clear local memory</button>
      </div>

      {confirmClear && (
        <ConfirmModal
          title="Clear local memory?"
          message="Deletes ALL chats and conversation history on this device. This can't be undone."
          confirmLabel="Delete everything"
          onConfirm={clearMemory}
          onCancel={() => setConfirmClear(false)}
        />
      )}
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

function MessageBubble({ msg, onRegenerate, regenerating }) {
  const [speaking, setSpeaking] = useState(false);
  const [copied, setCopied] = useState(false);

  function toggleSpeak() {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(msg.text);
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    setSpeaking(true);
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(msg.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  }

  return (
    <div className={`bubble ${msg.role}`}>
      {msg.kind === "image" && msg.imageThumb && (
        <img className="bubble-img" src={msg.imageThumb} alt="uploaded plant" />
      )}
      {msg.text && (
        <div className="bubble-text" dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(msg.text) }} />
      )}
      {msg.text && msg.kind === "text" && (
        <div className="bubble-actions">
          <button className={speaking ? "active" : ""} title="Read aloud" onClick={toggleSpeak}>
            <i className={speaking ? "bi bi-volume-mute" : "bi bi-volume-up"}></i>
          </button>
          <button className={copied ? "active" : ""} title="Copy" onClick={copyText}>
            <i className={copied ? "bi bi-check2" : "bi bi-clipboard"}></i>
          </button>
          {msg.role === "assistant" && onRegenerate && (
            <button title="Regenerate" onClick={onRegenerate} disabled={regenerating}>
              <i className="bi bi-arrow-clockwise"></i>
            </button>
          )}
        </div>
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
          <p>Your gardening tools and supplies as cards — tap one for details, notes, and to edit or delete it. You can also just tell the AI in chat what you bought or used up and it'll update this for you.</p>
          <h3>Routines</h3>
          <p>Recurring care tasks (watering, fertilizing) as cards, with a "Due" badge when one's overdue. Tap a card for details, to mark it done, or to edit it.</p>
          <h3>Codex</h3>
          <p>A quick-reference library of common plants, pests, and gardening topics — browse or search it any time. If nothing matches, tap the search icon for an in-depth AI search with sources.</p>
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
