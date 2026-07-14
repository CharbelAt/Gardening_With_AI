// App-shell / reusable UI: confirm & prompt dialogs, settings, the chat
// switcher, message bubbles, the bottom navigation bar, the AI-action
// confirm banner, and the help manual.

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

// Full-screen viewer for plant photos (tap a history thumbnail to open).
function ImageLightbox({ src, caption, onClose }) {
  return (
    <div className="lightbox-backdrop" onClick={onClose}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption">{caption}</p>}
      <button className="icon-btn lightbox-close" onClick={onClose} title="Close">
        <i className="bi bi-x-lg"></i>
      </button>
    </div>
  );
}

function SettingsModal({ onClose, onCleared, onShowHelp, theme, onThemeChange }) {
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

  // Wipes EVERYTHING the app stores on this device — conversations, plants,
  // tools, routines, and the codex library.
  async function clearMemory() {
    await clearAllMessages();
    await clearAllChats();
    await clearAllPlants();
    await clearAllTools();
    await clearAllRoutines();
    await clearAllCodexEntries();
    await clearAllShoppingItems();
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
          AI data updates
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
        <button className="btn btn-ghost btn-block" onClick={onShowHelp}>
          <i className="bi bi-question-circle"></i> How to use Garden Companion
        </button>
        <p className="hint">All app data is stored only in this browser.</p>
        <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>Clear all data</button>
      </div>

      {confirmClear && (
        <ConfirmModal
          title="Clear ALL data?"
          message="Deletes everything stored on this device: chats, messages, plants, tools, routines, and saved codex entries. This can't be undone."
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
    const utter = new SpeechSynthesisUtterance(stripForSpeech(msg.text));
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

// ---------- AI-proposed changes (confirm mode) ----------

// One banner for however many actions the AI proposed in a reply. Each row
// can be applied or dismissed on its own; "Apply all" clears the queue.
function PendingActionsBanner({ actions, onResolve }) {
  if (!actions || actions.length === 0) return null;

  async function applyOne(index) {
    await applyResolvedAction(actions[index]);
    onResolve(actions.filter((_, i) => i !== index));
  }
  function dismissOne(index) {
    onResolve(actions.filter((_, i) => i !== index));
  }
  async function applyAll() {
    for (const a of actions) await applyResolvedAction(a);
    onResolve([]);
  }

  return (
    <div className="confirm-banner">
      <div className="confirm-banner-title">
        <i className="bi bi-magic"></i> Sprout suggests {actions.length === 1 ? "a change" : `${actions.length} changes`}:
      </div>
      {actions.map((a, i) => (
        <div key={i} className="confirm-row">
          <span>{describeAction(a)}</span>
          <div className="confirm-actions">
            <button className="btn small" onClick={() => applyOne(i)}>Apply</button>
            <button className="btn btn-ghost small" onClick={() => dismissOne(i)}>Dismiss</button>
          </div>
        </div>
      ))}
      {actions.length > 1 && (
        <div className="confirm-actions confirm-all">
          <button className="btn small" onClick={applyAll}>Apply all</button>
          <button className="btn btn-ghost small" onClick={() => onResolve([])}>Dismiss all</button>
        </div>
      )}
    </div>
  );
}

// ---------- tags ----------

// Tag selector used by every add/edit modal: preset chips toggle on/off, plus
// a free-text row for custom tags (the AI can also assign tags via actions).
function TagPicker({ presets, tags, onChange }) {
  const [custom, setCustom] = useState("");
  const shown = Array.from(new Set([...(presets || []), ...(tags || [])]));

  function toggle(t) {
    onChange(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  }
  function addCustom() {
    const t = custom.trim().toLowerCase();
    if (!t) return;
    if (!tags.includes(t)) onChange([...tags, t]);
    setCustom("");
  }

  return (
    <div className="tag-picker">
      <span className="tag-picker-label">Tags</span>
      <div className="tag-chip-row">
        {shown.map((t) => (
          <button
            type="button"
            key={t}
            className={tags.includes(t) ? "tag-chip active" : "tag-chip"}
            onClick={() => toggle(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="tag-picker-add">
        <input
          value={custom}
          placeholder="custom tag…"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" className="btn small" onClick={addCustom} disabled={!custom.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

// Horizontal filter bar above the card grids: shows every tag in use for that
// module; tapping one filters the grid, tapping again (or "All") clears it.
function TagFilterBar({ items, activeTag, onSelect }) {
  const tags = Array.from(new Set(items.flatMap((i) => i.tags || []))).sort();
  if (tags.length === 0) return null;
  return (
    <div className="tag-filter-bar">
      <button className={!activeTag ? "tag-chip active" : "tag-chip"} onClick={() => onSelect(null)}>
        All
      </button>
      {tags.map((t) => (
        <button
          key={t}
          className={activeTag === t ? "tag-chip active" : "tag-chip"}
          onClick={() => onSelect(activeTag === t ? null : t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// Small read-only tag chips for detail pages.
function TagChips({ tags }) {
  if (!tags || tags.length === 0) return null;
  return (
    <React.Fragment>
      {tags.map((t) => (
        <span key={t} className="chip tag">
          <i className="bi bi-tag"></i> {t}
        </span>
      ))}
    </React.Fragment>
  );
}

// ---------- bottom navigation ----------

const NAV_ITEMS = [
  { key: "chat", label: "Chat", icon: "bi-chat-dots" },
  { key: "garden", label: "Garden", icon: "bi-flower3" },
  { key: "routines", label: "Routines", icon: "bi-arrow-repeat" },
  { key: "inventory", label: "Inventory", icon: "bi-box-seam" },
  { key: "codex", label: "Codex", icon: "bi-book" },
];

function BottomNav({ view, onNavigate, dueCount, togetCount }) {
  const activeKey = view;
  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          className={activeKey === item.key ? "bottom-nav-item active" : "bottom-nav-item"}
          onClick={() => onNavigate(item.key)}
        >
          <span className="bottom-nav-icon">
            <i className={`bi ${item.icon}`}></i>
            {item.key === "routines" && dueCount > 0 && (
              <span className="nav-badge">{dueCount > 9 ? "9+" : dueCount}</span>
            )}
            {item.key === "inventory" && togetCount > 0 && (
              <span className="nav-badge">{togetCount > 9 ? "9+" : togetCount}</span>
            )}
          </span>
          <span className="bottom-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function HelpModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <h2>How to use Garden Companion</h2>
        <div className="help-content">
          <h3>Getting around</h3>
          <p>The bar at the bottom switches between Chat, Garden, Routines, Inventory, and Codex. The gear in the header opens Settings.</p>
          <h3>Chat</h3>
          <p>Type gardening questions to Sprout. The camera button takes a new photo; the pictures button picks one from your gallery — either way it'll identify the plant and assess its health. Sprout knows your plants, tools, and routines, and can update them for you: just say things like "I watered the tomatoes" or "I bought neem oil".</p>
          <h3>Voice calls</h3>
          <p>Tap the phone icon in the chat composer for a hands-free voice conversation right inside the chat — you'll see a live transcript as you speak, and everything lands in the same thread. You can interrupt Sprout any time just by talking: it stops speaking and listens. Tap the red button to hang up. Works best in Chrome on Android.</p>
          <h3>Chats</h3>
          <p>The chat-bubbles icon in the header lets you keep separate conversation threads, rename them, or start a new one. New chats name themselves after your first message.</p>
          <h3>Garden</h3>
          <p>Track your plants: name, location, planting date, and a full care history. Take photos from a plant's page to build its timeline, tap any photo to view it full-screen, and use "Ask Sprout" to jump into chat about that specific plant.</p>
          <h3>Routines</h3>
          <p>Recurring care tasks with a "Due" badge when overdue (also shown on the bottom bar). Link a routine to a plant with a care action — marking "Water the ficus" done then updates the ficus's watering record automatically.</p>
          <h3>Inventory</h3>
          <p>Your tools and supplies as cards — tap one for details or to edit it. Telling Sprout what you bought or used up keeps this in sync too. The "To get" tab is your shopping checklist: add items there (or say "I need to buy…"), check them off when bought, and move them straight into your inventory. Open items show as a badge on the Inventory tab.</p>
          <h3>Tags</h3>
          <p>Plants, tools, and routines can all be tagged (e.g. "herb", "pesticide", "watering") — pick preset tags or type your own when adding/editing, and Sprout tags things it adds for you. Tap a tag in the bar above any grid to filter by it.</p>
          <h3>Codex</h3>
          <p>Your garden's knowledge library. Every plant or tool you add gets researched automatically in the background — scientific facts, care/usage guidance, and sources appear here on their own. You can also search anything, run the in-depth AI search, and save results. Item pages have a Codex button that jumps straight to their entry.</p>
          <h3>Settings</h3>
          <p>Set your backend URL and client secret (from your VPS), choose whether AI-suggested updates apply automatically or ask first, and clear local data if needed.</p>
          <h3>Your data</h3>
          <p>Everything (chats, plants, tools, routines, saved codex entries) is stored only in this browser — nothing is synced anywhere else.</p>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
