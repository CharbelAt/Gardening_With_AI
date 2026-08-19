// App-shell / reusable UI: confirm & prompt dialogs, settings, the chat
// switcher, message bubbles, the bottom navigation bar, the AI-action
// confirm banner, and the help manual.

// Shared by every modal/overlay in the app: Escape closes it. One hook
// instead of copy-pasting the same useEffect+keydown listener into a dozen
// components (this file loads before every module that needs it — see
// index.html's script order). Deliberately just Escape + nothing else: a
// full focus trap is a lot more code and easy to get subtly wrong, and
// Escape + labeled buttons + autofocus already cover the high-value case.
function useEscapeKey(onClose) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

// Generic replacements for window.confirm()/prompt() — styled to match the
// app instead of the browser's native dialog boxes.
function ConfirmModal({ title = "Are you sure?", message, confirmLabel = "Delete", danger = true, onConfirm, onCancel }) {
  useEscapeKey(onCancel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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
  useEscapeKey(onCancel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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
  useEscapeKey(onClose);
  return (
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" aria-label={caption || "Photo viewer"} onClick={onClose}>
      <img src={src} alt={caption || "Photo"} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption">{caption}</p>}
      <button className="icon-btn lightbox-close" onClick={onClose} title="Close" aria-label="Close">
        <i className="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </div>
  );
}

// FEATURE 2 (weather entry point): weather.jsx owns settings/UI/fetching —
// this is just the missing "way in" that file's own header comment calls
// out ("no other way in until the orchestrator wires a Settings entry").
// Kept deliberately tiny; WeatherSetupModal does the real work and hands
// back the settings it just saved via onSaved (same convention WeatherStrip
// uses), so there's no need to re-read localStorage here after a save.
function SettingsWeatherRow() {
  const [weather, setWeather] = useState(() =>
    typeof getWeatherSettings === "function" ? getWeatherSettings() : { enabled: false, place: "" }
  );
  const [showSetup, setShowSetup] = useState(false);
  const label = weather.enabled && weather.place ? weather.place : "Off";

  return (
    <React.Fragment>
      <hr />
      <p className="hint">Local weather: {label}</p>
      <button className="btn btn-ghost btn-block" onClick={() => setShowSetup(true)}>
        <i className="bi bi-cloud-sun" aria-hidden="true"></i> {weather.enabled ? "Change location" : "Set up local weather"}
      </button>
      {showSetup && typeof WeatherSetupModal === "function" && (
        <WeatherSetupModal
          onClose={() => setShowSetup(false)}
          onSaved={(saved) => {
            setWeather(saved);
            setShowSetup(false);
          }}
        />
      )}
    </React.Fragment>
  );
}

// FEATURE 1 (backup & restore UI). exportAllData()/importAllData(data, mode)
// live in idb.js (built alongside this file) and are guarded with typeof so
// a load-order hiccup shows a message instead of crashing the whole Settings
// modal. importAllData's returned shape and rejection behavior are documented
// right above it in idb.js: resolves { imported: {store: count}, skipped,
// mode }, rejects with a readable Error on a malformed file.
function SettingsBackupSection({ onCleared }) {
  const fileInputRef = useRef(null);

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [exportErr, setExportErr] = useState("");

  const [pendingData, setPendingData] = useState(null); // parsed backup JSON, held until the user picks a mode (or cancels)
  const [importStep, setImportStep] = useState(null); // null | "choose" | "confirmReplace"
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [importErr, setImportErr] = useState("");

  async function handleExport() {
    setExportErr("");
    setExportMsg("");
    if (typeof exportAllData !== "function") {
      setExportErr("Export isn't available yet — try again in a moment.");
      return;
    }
    setExporting(true); // exports include base64 photos and can run tens of MB, so this isn't instant
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `garden-companion-backup-${todayISO()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url); // release the blob now that the download has started
      setExportMsg(`Saved — ${(blob.size / (1024 * 1024)).toFixed(1)} MB.`);
    } catch (e) {
      setExportErr(e && e.message ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // reset so re-picking the same filename still fires onChange next time
    if (!file) return;
    setImportErr("");
    setImportMsg("");
    const reader = new FileReader();
    reader.onerror = () => setImportErr("Couldn't read that file.");
    reader.onload = () => {
      try {
        setPendingData(JSON.parse(reader.result));
        setImportStep("choose");
      } catch (_) {
        setImportErr("That doesn't look like a backup file (couldn't parse it as JSON).");
      }
    };
    reader.readAsText(file);
  }

  function cancelImport() {
    setImportStep(null);
    setPendingData(null);
  }

  async function runImport(mode) {
    const data = pendingData;
    setImportStep(null);
    setPendingData(null);
    if (!data) return;
    setImportErr("");
    setImportMsg("");
    if (typeof importAllData !== "function") {
      setImportErr("Restoring a backup isn't available yet — try again in a moment.");
      return;
    }
    setImporting(true);
    try {
      const result = (await importAllData(data, mode)) || {};
      const counts = Object.entries(result.imported || {})
        .map(([store, n]) => `${n} ${store}`)
        .join(", ");
      const skippedNote = (result.skipped || []).length ? ` Skipped: ${result.skipped.join(", ")}.` : "";
      setImportMsg(`Restored (${mode}): ${counts || "nothing new"}.${skippedNote}`);
      // The rest of the app (chats, messages, nav badges) was already loaded
      // from IndexedDB before this import ran, so that in-memory state is now
      // stale either way — Replace may have deleted what it pointed at, Merge
      // added things it doesn't know about. onCleared() is the same "re-read
      // everything and land on a fresh default chat" routine "Clear all data"
      // below already uses, which is exactly what's needed here too.
      onCleared();
    } catch (e) {
      setImportErr(e && e.message ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <React.Fragment>
      <hr />
      <h3 className="backup-section-title">Backup</h3>
      <p className="hint">
        Everything is stored only in this browser — a backup file you save yourself is the only
        protection against losing it (new device, cleared browser data, uninstalling the app, etc.).
      </p>

      <div className="backup-row">
        <button className="btn btn-ghost" onClick={handleExport} disabled={exporting}>
          <i className="bi bi-download" aria-hidden="true"></i> {exporting ? "Exporting…" : "Export backup"}
        </button>
        <button className="btn btn-ghost" onClick={() => fileInputRef.current.click()} disabled={importing}>
          <i className="bi bi-upload" aria-hidden="true"></i> {importing ? "Restoring…" : "Import backup"}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={onFileChosen}
      />

      {exportMsg && <p className="hint backup-status" role="status" aria-live="polite">{exportMsg}</p>}
      {exportErr && <p className="hint backup-status error" role="alert">{exportErr}</p>}
      {importMsg && <p className="hint backup-status" role="status" aria-live="polite">{importMsg}</p>}
      {importErr && <p className="hint backup-status error" role="alert">{importErr}</p>}

      {importStep === "choose" && (
        <div className="modal-backdrop" onClick={cancelImport}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-choose-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="import-choose-title">Restore this backup?</h2>
            <div className="backup-mode-option">
              <strong>Replace</strong>
              <p>Deletes everything currently on this device and restores the backup exactly.</p>
            </div>
            <div className="backup-mode-option">
              <strong>Merge</strong>
              <p>Keeps what you have and adds the backup's items alongside it.</p>
            </div>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={() => setImportStep("confirmReplace")}>Replace</button>
              <button className="btn" onClick={() => runImport("merge")}>Merge</button>
            </div>
            <button className="btn btn-ghost btn-block" onClick={cancelImport}>Cancel</button>
          </div>
        </div>
      )}

      {importStep === "confirmReplace" && (
        // Second confirmation for the destructive path, per spec — reusing
        // ConfirmModal (danger-styled) rather than hand-rolling another dialog.
        <ConfirmModal
          title="Replace everything on this device?"
          message="This deletes everything currently on this device — chats, plants, tools, routines, to-dos, and codex entries — and restores the backup exactly. This can't be undone."
          confirmLabel="Replace everything"
          danger
          onConfirm={() => runImport("replace")}
          onCancel={() => setImportStep("choose")}
        />
      )}
    </React.Fragment>
  );
}

// `onShowContext` and `onOpenCodex` are both optional and both additive — the
// modal renders without them. They exist because the header was down to two
// jobs (search, settings) and these two are the things that lost their icon:
// the AI-context peek is a verification tool, not a daily control (the snapshot
// is rebuilt on every request regardless), and Codex left the bottom bar and
// needs one entry point that isn't a search result.
function SettingsModal({ onClose, onCleared, onShowHelp, onShowGuide, onShowContext, onOpenCodex, theme, onThemeChange }) {
  const [apiBase, setApiBase] = useState(getSettings().apiBase);
  const [secret, setSecret] = useState(getSettings().secret);
  const [writeMode, setWriteMode] = useState(getAiWriteMode());
  const [defaultLocation, setDefaultLocation] = useState(getDefaultLocation());
  const [landingView, setLandingView] = useState(localStorage.getItem(LS_LANDING_VIEW) || "chat");
  const [confirmClear, setConfirmClear] = useState(false);

  function save() {
    localStorage.setItem(LS_API_BASE, apiBase.trim());
    localStorage.setItem(LS_SECRET, secret.trim());
    localStorage.setItem(LS_AI_WRITE_MODE, writeMode);
    localStorage.setItem(LS_DEFAULT_LOCATION, defaultLocation.trim());
    localStorage.setItem(LS_LANDING_VIEW, landingView);
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
    await clearAllTodos();
    setConfirmClear(false);
    onCleared();
  }

  useEscapeKey(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-modal-title">Settings</h2>
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
          Open the app on
          <select value={landingView} onChange={(e) => setLandingView(e.target.value)}>
            <option value="chat">Chat</option>
            <option value="today">Today</option>
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

        <SettingsWeatherRow />

        <SettingsBackupSection onCleared={onCleared} />

        {typeof NotifySettingsSection === "function" && <NotifySettingsSection />}

        <hr />
        {onOpenCodex && (
          <button className="btn btn-ghost btn-block" onClick={onOpenCodex}>
            <i className="bi bi-book" aria-hidden="true"></i> Knowledge library (Codex)
          </button>
        )}
        {onShowContext && (
          <button className="btn btn-ghost btn-block" onClick={onShowContext}>
            <i className="bi bi-arrow-repeat" aria-hidden="true"></i> What can Sprout see?
          </button>
        )}
        {/* Two different manuals: HelpModal covers getting around the app,
            GuideView covers talking to Sprout. Kept separate so neither
            becomes the long one nobody reads. */}
        {onShowGuide && (
          <button className="btn btn-ghost btn-block" onClick={onShowGuide}>
            <i className="bi bi-chat-heart" aria-hidden="true"></i> How to talk to Sprout
          </button>
        )}
        <button className="btn btn-ghost btn-block" onClick={onShowHelp}>
          <i className="bi bi-question-circle" aria-hidden="true"></i> How to use Garden Companion
        </button>
        <p className="hint">All app data is stored only in this browser.</p>
        <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>Clear all data</button>
      </div>

      {confirmClear && (
        <ConfirmModal
          title="Clear ALL data?"
          message="Deletes everything stored on this device: chats, messages, plants, tools, routines, to-dos, the to-get list, and saved codex entries. This can't be undone."
          confirmLabel="Delete everything"
          onConfirm={clearMemory}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

function ChatListModal({ chats, activeChatId, onSwitch, onNew, onRename, onDelete, onClose }) {
  useEscapeKey(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="chatlist-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="chatlist-modal-title">Chats</h2>
        <div className="chat-list" role="list">
          {chats.map((c) => (
            <div key={c.id} role="listitem" className={c.id === activeChatId ? "chat-row active" : "chat-row"}>
              <button className="chat-row-title" onClick={() => onSwitch(c.id)}>
                {c.title || "Untitled chat"}
              </button>
              <button className="icon-btn small" title="Rename" aria-label="Rename" onClick={() => onRename(c)}><i className="bi bi-pencil" aria-hidden="true"></i></button>
              <button className="icon-btn small" title="Delete" aria-label="Delete" onClick={() => onDelete(c)}><i className="bi bi-trash" aria-hidden="true"></i></button>
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
        <img className="bubble-img" src={msg.imageThumb} alt="Photo you sent" />
      )}
      {msg.text && (
        <div className="bubble-text" dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(msg.text) }} />
      )}
      {msg.text && msg.kind === "text" && (
        <div className="bubble-actions">
          <button className={speaking ? "active" : ""} title="Read aloud" aria-label="Read aloud" aria-pressed={speaking} onClick={toggleSpeak}>
            <i className={speaking ? "bi bi-volume-mute" : "bi bi-volume-up"} aria-hidden="true"></i>
          </button>
          <button className={copied ? "active" : ""} title="Copy" aria-label="Copy" onClick={copyText}>
            <i className={copied ? "bi bi-check2" : "bi bi-clipboard"} aria-hidden="true"></i>
          </button>
          {msg.role === "assistant" && onRegenerate && (
            <button title="Regenerate" aria-label="Regenerate" onClick={onRegenerate} disabled={regenerating}>
              <i className="bi bi-arrow-clockwise" aria-hidden="true"></i>
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
  // The queue lives in view state, so leaving the view drops it — clear the
  // AI-facing copy on the way out too, or Sprout keeps warning about pending
  // changes the user can no longer see or confirm anywhere.
  useEffect(() => () => setQueuedActions([]), []);

  if (!actions || actions.length === 0) return null;

  // Every way out of the queue goes through resolve(), so the AI's "NOT SAVED
  // YET" list (setQueuedActions in helpers.jsx) can never outlive the banner
  // the user just cleared and make it warn about changes that already applied.
  function resolve(next) {
    setQueuedActions(next);
    onResolve(next);
  }

  async function applyOne(index) {
    await applyResolvedAction(actions[index]);
    resolve(actions.filter((_, i) => i !== index));
  }
  function dismissOne(index) {
    resolve(actions.filter((_, i) => i !== index));
  }
  async function applyAll() {
    for (const a of actions) await applyResolvedAction(a);
    resolve([]);
  }

  return (
    <div className="confirm-banner">
      <div className="confirm-banner-title">
        <i className="bi bi-magic" aria-hidden="true"></i> Sprout suggests {actions.length === 1 ? "a change" : `${actions.length} changes`}:
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
          <button className="btn btn-ghost small" onClick={() => resolve([])}>Dismiss all</button>
        </div>
      )}
    </div>
  );
}

// "What can Sprout actually see?" — the user-facing half of the context fix.
// The counts come from a read of the database taken the moment the refresh
// button was tapped, so they are proof rather than reassurance.
function ContextPeekModal({ summary, revision, onClose }) {
  useEscapeKey(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="context-peek-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="context-peek-modal-title">Sprout can see</h2>
        <p className="context-peek">{summary}</p>
        <p className="hint">
          Re-read from this device just now (snapshot #{revision}). Sprout gets this same live list
          with every message you send, so it answers from your actual data — not from what it said
          earlier.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Got it</button>
        </div>
      </div>
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
            aria-pressed={tags.includes(t)}
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
          aria-label="Custom tag"
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
      <button className={!activeTag ? "tag-chip active" : "tag-chip"} aria-pressed={!activeTag} onClick={() => onSelect(null)}>
        All
      </button>
      {tags.map((t) => (
        <button
          key={t}
          className={activeTag === t ? "tag-chip active" : "tag-chip"}
          aria-pressed={activeTag === t}
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
          <i className="bi bi-tag" aria-hidden="true"></i> {t}
        </span>
      ))}
    </React.Fragment>
  );
}

// ---------- bottom navigation ----------

// Five tabs, in the order a gardener actually uses them: what needs doing
// (Today), what I grow (Garden), asking about it (Chat, centre — the app's
// most-used screen), the checklists (Tasks = routines + to-dos), what I own
// (Inventory).
//
// Codex is deliberately NOT here. It is a reference library you arrive at from
// something else — the header search indexes it, every plant/tool detail page
// has a Codex button, and Settings has a "Knowledge library" row — so a
// permanent tab spent screen width on a destination nobody opens cold.
const NAV_ITEMS = [
  { key: "today", label: "Today", icon: "bi-sun" },
  { key: "garden", label: "Garden", icon: "bi-flower3" },
  { key: "chat", label: "Chat", icon: "bi-chat-dots" },
  { key: "tasks", label: "Tasks", icon: "bi-check2-square" },
  { key: "inventory", label: "Inventory", icon: "bi-box-seam" },
];

// Routines and To-do merged into the Tasks tab, but half the app still links
// to them by their old view keys (garden.jsx's linked routines, today.jsx's
// rows, search.jsx's results). Those keys stay valid for ever: they resolve to
// the tab that now owns them plus the section to preselect. One map so the
// bar's highlight and app.jsx's router can't drift apart.
const LEGACY_VIEW_ALIASES = {
  routines: { view: "tasks", section: "routines" },
  todos: { view: "tasks", section: "todos" },
};

function resolveView(view) {
  return LEGACY_VIEW_ALIASES[view] || { view: view, section: null };
}

function BottomNav({ view, onNavigate, dueCount, togetCount, todoCount }) {
  const activeKey = resolveView(view).view;
  // Routines and to-dos are one destination now, so they get ONE badge —
  // overdue routines plus to-dos due today or already late. Today gets none on
  // purpose: it is the overview of exactly these same items, so a badge there
  // would count everything the bar already shows a second time.
  const taskCount = (dueCount || 0) + (todoCount || 0);
  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          className={activeKey === item.key ? "bottom-nav-item active" : "bottom-nav-item"}
          aria-current={activeKey === item.key ? "page" : undefined}
          onClick={() => onNavigate(item.key)}
        >
          <span className="bottom-nav-icon">
            <i className={`bi ${item.icon}`} aria-hidden="true"></i>
            {item.key === "tasks" && taskCount > 0 && (
              <span className="nav-badge">{taskCount > 9 ? "9+" : taskCount}</span>
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
  useEscapeKey(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="help-modal-title">How to use Garden Companion</h2>
        <div className="help-content">
          <h3>Getting around</h3>
          <p>The bar at the bottom switches between Today, Garden, Chat, Tasks, and Inventory. Tasks holds both your recurring Routines and your one-off To-do list — the switch at the top of that tab moves between them. In the header, the magnifier searches everything you've saved and the gear opens Settings.</p>
          <h3>Chat</h3>
          <p>Type gardening questions to Sprout. The camera button takes a new photo; the pictures button picks one from your gallery — either way it'll identify the plant and assess its health. Sprout knows your plants, tools, and routines, and can update them for you: just say things like "I watered the tomatoes" or "I bought neem oil". After a reply you'll often see a row of suggested follow-up questions — tap one to ask it straight away. Sprout is handed a fresh read of your plants, tools, routines and lists with every single message, so it answers from what's actually saved; Settings › "What can Sprout see?" shows you exactly what that is right now.</p>
          <h3>Talking instead of typing</h3>
          <p>Tap the microphone button in the composer and speak — it keeps listening, however long you take, until you tap it again (the button turns into a red stop button while it's on). Your words appear in the strip above the composer as you say them, so you can see it's hearing you; tap stop and they drop into the text box, added to anything already typed. Nothing is sent until you press Send, so you can fix a word first. If Sprout is reading a reply aloud, tapping the mic stops it. If you forget to turn it off it stops itself after 90 seconds and keeps what it heard.</p>
          <h3>Chats</h3>
          <p>The chat-bubbles icon in the header lets you keep separate conversation threads, rename them, or start a new one. New chats name themselves after your first message.</p>
          <h3>Today</h3>
          <p>The first tab: what actually needs you today — overdue routines, to-dos due now, and plants that look thirsty — each tickable straight from the list. "Summarize my day" asks Sprout for a short plan that takes the weather into account.</p>
          <h3>Garden</h3>
          <p>Track your plants: name, location, planting date, and a full care history. Take photos from a plant's page to build its timeline, tap any photo to view it full-screen, and use "Ask Sprout" to jump into chat about that specific plant.</p>
          <h3>Tasks › Routines</h3>
          <p>Recurring care tasks with a "Due" badge when overdue (they also count towards the badge on the Tasks tab). Link a routine to a plant with a care action — marking "Water the ficus" done then updates the ficus's watering record automatically.</p>
          <h3>Tasks › To-do</h3>
          <p>One-off tasks that aren't routines: "prune the roses", "repot the mint on Saturday". Type one in the box at the top (a due date is optional) and tap + or press Enter. Tick a task off when it's done and it drops to the bottom with a line through it — "Clear completed" tidies those away. Anything overdue or due today counts towards the badge on the Tasks tab. Sprout can add, update, tick off, and remove tasks for you: just say "remind me to prune the roses this weekend".</p>
          <h3>Inventory</h3>
          <p>Your tools and supplies as cards — tap one for details or to edit it. Photograph an item from its page and Sprout reads the label for you: product type, active ingredients, dosage and safety notes land in a "Product info" section (and the picture becomes the item's photo). Telling Sprout what you bought or used up keeps this in sync too. The "To get" tab is your shopping checklist: add items there (or say "I need to buy…"), check them off when bought, and move them straight into your inventory. Open items show as a badge on the Inventory tab.</p>
          <h3>Tags</h3>
          <p>Plants, tools, and routines can all be tagged (e.g. "herb", "pesticide", "watering") — pick preset tags or type your own when adding/editing, and Sprout tags things it adds for you. Tap a tag in the bar above any grid to filter by it.</p>
          <h3>Codex</h3>
          <p>Your garden's knowledge library. Every plant or tool you add gets researched automatically in the background — scientific facts, care/usage guidance, and sources appear here on their own. You can also search anything, run the in-depth AI search, and save results. It has no tab of its own — open it from any item page's Codex button, from a search result, or from Settings › Knowledge library.</p>
          <h3>Settings</h3>
          <p>Set your backend URL and client secret (from your VPS), choose whether AI-suggested updates apply automatically or ask first, and clear local data if needed.</p>
          <h3>Your data</h3>
          <p>Everything (chats, plants, tools, routines, to-dos, saved codex entries) is stored only in this browser — nothing is synced anywhere else.</p>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
