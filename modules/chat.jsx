// The Chat page: typed messages, photos (camera or gallery), AI action
// confirmations (multi-action aware), per-message regenerate/copy/read-aloud,
// tap-to-ask follow-up chips under the newest reply, and tap-to-talk
// dictation (VoiceButton in voice.jsx — tap to open the mic, tap again to
// close it, and the transcript lands in the input instead of being sent).

// ---------------------------------------------------------------------------
// Density primitives (Gc* prefix) — progressive disclosure, shared by every
// view module.
//
// They would normally belong in shared-ui.jsx, but that file is owned by
// another pass right now. chat.jsx is the FIRST view module index.html loads,
// so defining them here means garden/inventory/codex/today can use them as
// plain globals (all uses are at render time, long after every script has run).
// ---------------------------------------------------------------------------

// A labelled show/hide section. The control ALWAYS says what it opens
// ("History (12)") — a bare chevron gives a thumb nothing to aim at and a
// screen reader nothing to announce.
//
// Uncontrolled by default (`defaultOpen`); pass `open` + `onToggle` when the
// parent has to open it itself — ToolDetail pops "Product info" open the
// moment a fresh label scan lands.
function GcDisclosure({ id, label, count, icon, defaultOpen, open, onToggle, children }) {
  const [selfOpen, setSelfOpen] = useState(!!defaultOpen);
  const controlled = typeof open === "boolean";
  const isOpen = controlled ? open : selfOpen;

  function toggle() {
    if (controlled) onToggle(!isOpen);
    else setSelfOpen(!isOpen);
  }

  return (
    <div className="gc-disclosure">
      <button className="gc-disclosure-toggle" onClick={toggle} aria-expanded={isOpen} aria-controls={id}>
        {icon && <i className={`bi ${icon}`} aria-hidden="true"></i>}
        <span className="gc-disclosure-label">
          {label}
          {count == null ? "" : ` (${count})`}
        </span>
        <i className={isOpen ? "bi bi-chevron-up" : "bi bi-chevron-down"} aria-hidden="true"></i>
      </button>
      {/* The body element exists whether or not it's open, so aria-controls
          always points at something real — but its CONTENT is conditional, so a
          collapsed 50-entry history with 50 thumbnails costs nothing to keep. */}
      <div className="gc-disclosure-body" id={id}>{isOpen ? children : null}</div>
    </div>
  );
}

// "⋯ More" — the tertiary-action bucket, and the two-way photo picker. One
// component covers both so there is only one set of dismiss rules to get
// right: tap outside, press Escape, or pick an item.
//
// No focus trap, on purpose — same call shared-ui.jsx's useEscapeKey comment
// makes. This is a menu you dip into, not a task you're locked inside.
//
// `items`: [{ key, icon, label, onClick, disabled, danger }]. Falsy entries are
// dropped, so a caller can inline a condition (`hasPhoto && {…}`).
function GcOverflowMenu({ id, title, label, icon, items, disabled, className }) {
  const [open, setOpen] = useState(false);
  // Unconditional (rules of hooks); only closes something while open.
  useEscapeKey(() => open && setOpen(false));
  const entries = (items || []).filter(Boolean);
  const name = label || title || "More actions";

  function pick(item) {
    // Fire FIRST, close second: an item that opens a file picker has to run
    // inside the user's own click for the browser to allow it at all.
    if (item.onClick) item.onClick();
    setOpen(false);
  }

  return (
    <React.Fragment>
      <button
        className={className || "btn btn-ghost small"}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={name}
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
      >
        <i className={`bi ${icon || "bi-three-dots"}`} aria-hidden="true"></i>
        {label ? " " : null}
        {label}
      </button>
      {open && (
        <div className="gc-sheet-backdrop" onClick={() => setOpen(false)}>
          <div
            className="gc-sheet"
            id={id}
            role="dialog"
            aria-label={title || name}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="gc-sheet-title">{title || name}</p>
            {entries.map((item) => (
              <button
                key={item.key}
                className={item.danger ? "gc-sheet-item danger" : "gc-sheet-item"}
                disabled={item.disabled}
                onClick={() => pick(item)}
              >
                <i className={`bi ${item.icon}`} aria-hidden="true"></i>
                <span>{item.label}</span>
              </button>
            ))}
            <button className="gc-sheet-item gc-sheet-cancel" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </React.Fragment>
  );
}

// The follow-up questions the model proposed on its last reply (FOLLOWUP line,
// parsed by extractFollowups). Tapping one asks it immediately.
function FollowupChips({ suggestions, onPick, disabled }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="followup-chips">
      {suggestions.map((s, i) => (
        <button key={i} className="followup-chip" onClick={() => onPick(s)} disabled={disabled}>
          <i className="bi bi-arrow-return-right" aria-hidden="true"></i> {s}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized thread children — the fix for typing lag.
//
// The composer is a fully controlled input (it has to be: characters must
// appear the instant they're typed), so every keystroke sets ChatTab state and
// re-renders its whole subtree. Each MessageBubble runs marked.parse +
// DOMPurify.sanitize over its text on every render, so a 60-message thread was
// doing 60 markdown parses PER CHARACTER — measured at ~217ms/keystroke on a
// desktop, and far worse through Babel-standalone's output on a phone. That is
// the "delay between pressing a key and seeing the letter" users reported.
//
// React.memo skips those renders: a bubble's props only change when its own
// message does. It only works while the props stay referentially stable, which
// is why onRegenerate/onPick below come from caches and useCallback instead of
// inline arrows — a fresh arrow every render fails memo's shallow compare and
// puts the whole cost straight back.
//
// Wrapped HERE rather than at the definition sites: MessageBubble belongs to
// shared-ui.jsx, and FollowupChips is a plain global other passes may render —
// React.memo returns an object, not a function, so rebinding those names would
// change what every other caller sees. (shared-ui.jsx loads before chat.jsx in
// index.html, so MessageBubble is already defined at this point.)
const MemoMessageBubble = React.memo(MessageBubble);
const MemoFollowupChips = React.memo(FollowupChips);

function ChatTab({ chatId, messages, setMessages, busy, setBusy, draft, onDraftConsumed, onFirstUserMessage }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [pendingPhoto, setPendingPhoto] = useState(null); // { dataUrl, base64, caption }
  const [regeneratingId, setRegeneratingId] = useState(null);
  const [voice, setVoice] = useState({ state: "idle", seconds: 0, hint: "", live: "" });
  const [appliedNote, setAppliedNote] = useState(null); // { text, ok } — "✓ what actually got saved" toast
  const appliedTimer = useRef(null);
  const fileInputRef = useRef(null); // gallery / files
  const cameraInputRef = useRef(null); // forces the camera (capture attr)
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Chips hang off the NEWEST assistant reply only, so old suggestions can't
  // pile up down the thread.
  let lastAssistantId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantId = messages[i].id;
      break;
    }
  }

  // "Ask Sprout" buttons elsewhere in the app land here with a prefilled
  // question about a specific plant/tool/topic.
  useEffect(() => {
    if (draft) {
      setInput(draft);
      onDraftConsumed();
      inputRef.current?.focus();
    }
  }, [draft]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, voice.state]);

  useEffect(() => () => clearTimeout(appliedTimer.current), []);

  // Visible proof of writes: shows exactly what was saved (from the app's own
  // apply pipeline, not the AI's claims), then fades.
  function flashApplied(res) {
    if (!res) return;
    const applied = (res.applied || []).join(" · ");
    // `skipped` is being added to handleAiActions by a parallel pass — read it
    // optionally so this keeps working whether or not it lands, and so a
    // silently-dropped action still shows up somewhere the user can see it.
    const skipped = res.skipped && res.skipped.length ? `skipped: ${res.skipped.join(" · ")}` : "";
    const text = [applied, skipped].filter(Boolean).join(" — ");
    if (!text) return;
    setAppliedNote({ text, ok: !!applied });
    clearTimeout(appliedTimer.current);
    appliedTimer.current = setTimeout(() => setAppliedNote(null), 6000);
  }

  // Dictation result: appended to whatever is already typed (never sent for
  // the user), so dictation can extend a half-typed message.
  function appendTranscript(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
    inputRef.current?.focus();
  }

  // Send path shared by the send button, the Enter key, and follow-up chips.
  // fromComposer=true means the text came out of the input, so clear it.
  async function sendMessage(rawText, fromComposer) {
    const text = (rawText || "").trim();
    if (!text || busy) return;
    if (fromComposer) setInput("");
    setError("");
    if (messages.length === 0) onFirstUserMessage(text);
    const userMsg = { chatId, role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setBusy(true);
    try {
      // Completion loop: every reply carries a hidden STATUS flag. On
      // "continue" (couldn't finish — long task, ran out of space) the app
      // IMMEDIATELY re-prompts, escalating to the smart chain, until
      // STATUS: done — capped at 3 rounds so it can never spin forever.
      let history = nextHistory;
      for (let round = 0; round < 3; round++) {
        // Rebuilt INSIDE the loop on purpose: the garden-data snapshot must be
        // read after the previous round's handleAiActions writes were awaited,
        // or round 2+ reasons about pre-action data. Never hoist this out.
        const msgs = await buildContextMessages(history, "chat");
        if (round > 0) msgs.push({ role: "system", content: CONTINUE_NUDGE });
        const data = await apiFetch("/api/chat", {
          // Router: commands take the fast "act" chain, questions the smart
          // one; continuation rounds always use the smart chain.
          mode: round === 0 ? detectChatMode(text) : "chat",
          messages: msgs,
        });
        const { cleanText, actions } = extractActions(data.reply || "");
        const { cleanText: afterStatus, status } = extractStatus(cleanText);
        // Follow-up questions are stripped here too, so they never reach the
        // bubble text (and therefore never get read aloud).
        const { cleanText: shownText, followups } = extractFollowups(afterStatus);
        // Apply the AI's changes FIRST, then show its reply — by the time the
        // user reads "added!", the item is already in the module.
        const res = await handleAiActions(actions, setPendingActions, { chatId });
        flashApplied(res);
        const aiMsg = {
          chatId,
          role: "assistant",
          kind: "text",
          text: shownText || "Working on it…",
          createdAt: Date.now(),
          ...(followups.length ? { suggestions: followups } : {}),
        };
        aiMsg.id = await addMessage(aiMsg);
        history = [...history, aiMsg];
        setMessages((prev) => [...prev, aiMsg]);
        if (status !== "continue") break;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ONE send path for the composer. A photo attached to it rides along with
  // whatever was typed, so there is no separate "photo send" the user has to
  // find — the composer they were already typing in is the composer.
  function sendText() {
    if (pendingPhoto) {
      sendPendingPhoto(input);
      return;
    }
    sendMessage(input, true);
  }

  // Takes an id, not the message object: the handler that calls this is cached
  // for the life of the message (see regenerateHandlerFor), so a captured
  // object would be the version from whichever render created the closure —
  // stale text after an earlier regenerate. The id never goes stale.
  async function regenerateMessage(id) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx <= 0) return;
    const msg = messages[idx];
    const historyUpTo = messages.slice(0, idx); // everything before this reply, ending in the user's message
    setRegeneratingId(msg.id);
    setError("");
    try {
      const data = await apiFetch("/api/chat", { mode: "chat", messages: await buildContextMessages(historyUpTo, "chat") });
      const { cleanText, actions } = extractActions(data.reply || "");
      const { cleanText: afterStatus } = extractStatus(cleanText);
      const { cleanText: shownText, followups } = extractFollowups(afterStatus);
      const res = await handleAiActions(actions, setPendingActions, { chatId }); // act first
      flashApplied(res);
      // A reply that was ONLY action lines leaves nothing to show — keep the
      // previous text rather than blanking the bubble.
      const updated = {
        ...msg,
        text: shownText || msg.text || "(no visible reply — try regenerating again)",
        suggestions: followups.length ? followups : undefined,
      };
      await updateMessage(updated);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
    } catch (e) {
      setError(e.message);
    } finally {
      setRegeneratingId(null);
    }
  }

  // No `capture` attribute on the file input — Android/iOS then offer the
  // full chooser (camera OR gallery/files), so existing photos can be sent.
  function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    setError("");
    resizeImageToDataUrl(file).then((dataUrl) => {
      const [, base64] = dataUrl.split(",");
      // Empty caption on purpose. This used to prefill "What's going on with
      // this plant?", which put a question the user never asked into their own
      // transcript and told the model the subject was a plant — wrong for the
      // equipment, product labels and packaging people actually photograph.
      // The textarea below is an optional note; the vision prompt handles a
      // missing caption on its own.
      setPendingPhoto({ dataUrl, base64, caption: "" });
    });
  }

  // The caption now comes from the ONE composer input the user already types
  // in — an attached photo does not get a second text box of its own. Called by
  // the normal send button / Enter, exactly like a text message.
  async function sendPendingPhoto(rawCaption) {
    if (!pendingPhoto || busy) return;
    const { dataUrl, base64 } = pendingPhoto;
    setPendingPhoto(null);
    setInput(""); // the composer carried the caption; clear it like any send
    setError("");
    setBusy(true);
    try {
      // Whatever the user actually wrote, and nothing else — an empty string is
      // a valid caption. buildChatVisionPrompt handles a missing one without
      // assuming the photo is of a plant.
      const text = (rawCaption || "").trim();
      // The auto-title falls back to a neutral word rather than the caption:
      // titling a chat "" (autoTitleFromText of an empty string) would leave
      // the chat list with a blank row.
      if (messages.length === 0) onFirstUserMessage(text || "Photo");
      const userMsg = {
        chatId,
        role: "user",
        kind: "image",
        text,
        imageThumb: dataUrl,
        createdAt: Date.now(),
      };
      userMsg.id = await addMessage(userMsg);
      setMessages((prev) => [...prev, userMsg]);

      // The vision prompt includes the user's plant list + write-back
      // conventions, so a photo can update a plant's record just like text can.
      // `messages` is this render's value — the thread as it stood BEFORE this
      // photo — which is exactly the context the reply has to continue from,
      // so a photo sent mid-conversation no longer answers as if from nowhere.
      const data = await apiFetch("/api/vision", {
        imageBase64: base64,
        mimeType: "image/jpeg",
        prompt: await buildChatVisionPrompt(text, messages),
      });
      const { cleanText, actions } = extractActions(data.reply || "");
      const { cleanText: afterStatus } = extractStatus(cleanText);
      const { cleanText: shownText, followups } = extractFollowups(afterStatus);
      // photoMsg: lets a plant/tool ADDED from this photo keep the photo.
      const res = await handleAiActions(actions, setPendingActions, { chatId, photoMsg: userMsg }); // act first
      flashApplied(res);
      const aiMsg = {
        chatId,
        role: "assistant",
        kind: "text",
        text: shownText,
        createdAt: Date.now(),
        ...(followups.length ? { suggestions: followups } : {}),
      };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ---- stable handlers for the memoized children --------------------------
  // Everything below exists so React.memo can actually bail out. The handlers
  // a bubble or a chip receives must keep the same identity from render to
  // render (memo compares props with ===), yet still act on THIS render's
  // messages/busy/chatId. Reassigning the current closures onto a ref and
  // calling through it gives both: frozen identity, live behaviour.
  const latest = useRef({});
  latest.current.sendMessage = sendMessage;
  latest.current.regenerateMessage = regenerateMessage;

  // One cached handler per message id. MessageBubble wires onRegenerate
  // straight to onClick, so it's called with the click event — the message has
  // to be bound here rather than passed as an argument by the bubble.
  const regenHandlers = useRef(new Map());
  function regenerateHandlerFor(id) {
    let fn = regenHandlers.current.get(id);
    if (!fn) {
      fn = () => latest.current.regenerateMessage(id);
      regenHandlers.current.set(id, fn);
    }
    return fn;
  }

  // Bounds the cache: drop handlers for messages that are no longer in the
  // thread (switching chats swaps the whole list), so a long session can't leak
  // one closure per message ever seen. Keyed on `messages`, which changes only
  // when the thread does — never on a keystroke.
  useEffect(() => {
    const live = new Set(messages.map((m) => m.id));
    regenHandlers.current.forEach((_, id) => {
      if (!live.has(id)) regenHandlers.current.delete(id);
    });
  }, [messages]);

  // `latest`, setInput and inputRef are all stable for the component's
  // lifetime, so [] deps are correct: neither handler ever changes identity,
  // which is what keeps MemoFollowupChips from re-rendering as you type.
  const handleFollowupPick = useCallback((q) => latest.current.sendMessage(q), []);
  // Starter phrases PREFILL rather than send: the first thing a new user taps
  // shouldn't fire off a request they didn't get to read, and focusing the
  // composer puts the caret (and the phone keyboard) where they can edit it.
  const handleStarterPick = useCallback((text) => {
    setInput(text);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="tab-panel chat-tab">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-flower1" aria-hidden="true"></i>
            <p>Ask a gardening question or send a photo to get started.</p>
            <p className="empty-sub">Sprout knows your garden — tap one to try it:</p>
            {/* guide.jsx is optional (it may not be loaded yet, or at all), so
                the app must render an empty chat fine without it. */}
            {typeof GuideEmptyChatHints === "function" && <GuideEmptyChatHints onPick={handleStarterPick} />}
            {/* The guide also lives in Settings, but nobody opens Settings to
                learn how to talk to a chat box — the empty chat is where that
                question is actually being asked, so it gets a real entry point
                here too. Dispatched on window so chat.jsx doesn't need a new
                prop threaded through app.jsx for one link. */}
            {typeof GuideView === "function" && (
              <button
                className="btn btn-ghost small guide-open"
                onClick={() => window.dispatchEvent(new CustomEvent("gc:open-guide"))}
              >
                <i className="bi bi-chat-heart" aria-hidden="true"></i> How to talk to Sprout
              </button>
            )}
          </div>
        )}
        {messages.map((m) => (
          <React.Fragment key={m.id}>
            <MemoMessageBubble
              msg={m}
              onRegenerate={m.role === "assistant" ? regenerateHandlerFor(m.id) : undefined}
              regenerating={regeneratingId === m.id}
            />
            {m.id === lastAssistantId && !busy && (
              <MemoFollowupChips
                suggestions={m.suggestions}
                onPick={handleFollowupPick}
                disabled={busy}
              />
            )}
          </React.Fragment>
        ))}
        {busy && (
          <div className="bubble assistant typing">
            <span className="typing-dot"></span>
            <span className="typing-dot"></span>
            <span className="typing-dot"></span>
          </div>
        )}
        <div ref={scrollRef} />
      </div>
      {/* One capped, scrollable strip instead of a growing wall between the
          thread and the composer. Error and "applied" are mutually exclusive
          (an error means nothing was applied), and the confirm queue scrolls
          inside the strip rather than pushing the composer off the screen.
          The wrapper collapses via .gc-banner-stack:empty when all three are
          quiet — PendingActionsBanner stays MOUNTED so its unmount cleanup
          (which clears the AI-facing queue) still fires only on view exit. */}
      <div className="gc-banner-stack">
        {error ? (
          <div className="error-banner" role="alert">{error}</div>
        ) : appliedNote ? (
          <div className="applied-banner" role="status" aria-live="polite">
            {/* A note that is ONLY skipped actions isn't a success — don't
                greet it with a tick. */}
            <i className={appliedNote.ok ? "bi bi-check2-circle" : "bi bi-info-circle"} aria-hidden="true"></i>{" "}
            {appliedNote.text}
          </div>
        ) : null}
        <PendingActionsBanner actions={pendingActions} onResolve={setPendingActions} />
      </div>
      {/* An attached photo is a CHIP on the composer, not a second form: the
          user types the caption in the same box they always type in, and the
          same send button sends both. A photo-specific textarea + Send + Cancel
          used to appear here, which meant two text boxes on screen at once and
          two different ways to send. */}
      {pendingPhoto && (
        <div className="photo-chip" role="group" aria-label="Photo attached to your next message">
          <img src={pendingPhoto.dataUrl} alt="Attached photo" />
          <span className="photo-chip-label">Photo attached — add a note below, or just send.</span>
          <button
            className="icon-btn small"
            onClick={() => setPendingPhoto(null)}
            title="Remove photo"
            aria-label="Remove attached photo"
          >
            <i className="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </div>
      )}
      <VoiceListeningBar state={voice.state} seconds={voice.seconds} hint={voice.hint} live={voice.live} />
      <div className="composer">
        {/* Camera and gallery were two separate buttons because they need two
            different <input capture> attributes. They still are — the sheet
            just picks which hidden input to click, so the row is
            attach · text · mic · send instead of five controls deep. */}
        <GcOverflowMenu
          id="chat-attach-sheet"
          className="icon-btn"
          title="Add a photo"
          icon="bi-paperclip"
          disabled={busy}
          items={[
            { key: "camera", icon: "bi-camera", label: "Take a photo", onClick: () => cameraInputRef.current.click() },
            { key: "gallery", icon: "bi-images", label: "Choose from gallery", onClick: () => fileInputRef.current.click() },
          ]}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />
        <input
          ref={inputRef}
          className="text-input"
          type="text"
          placeholder={pendingPhoto ? "Add a note about the photo (optional)…" : "Ask Sprout something…"}
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendText()}
          disabled={busy}
        />
        <VoiceButton
          onTranscript={appendTranscript}
          onError={setError}
          onStateChange={setVoice}
          disabled={busy}
        />
        {/* A photo on its own is a valid message — an empty caption is fine, so
            the button must not stay disabled just because nothing was typed. */}
        <button
          className="btn btn-send"
          onClick={sendText}
          disabled={busy || (!input.trim() && !pendingPhoto)}
          title="Send"
          aria-label="Send"
        >
          <i className="bi bi-send-fill" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  );
}
