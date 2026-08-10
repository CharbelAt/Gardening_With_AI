// The Chat page: typed messages, photos (camera or gallery), AI action
// confirmations (multi-action aware), per-message regenerate/copy/read-aloud,
// tap-to-ask follow-up chips under the newest reply, and tap-to-talk
// dictation (VoiceButton in voice.jsx — tap to open the mic, tap again to
// close it, and the transcript lands in the input instead of being sent).

// The follow-up questions the model proposed on its last reply (FOLLOWUP line,
// parsed by extractFollowups). Tapping one asks it immediately.
function FollowupChips({ suggestions, onPick, disabled }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="followup-chips">
      {suggestions.map((s, i) => (
        <button key={i} className="followup-chip" onClick={() => onPick(s)} disabled={disabled}>
          <i className="bi bi-arrow-return-right"></i> {s}
        </button>
      ))}
    </div>
  );
}

function ChatTab({ chatId, messages, setMessages, busy, setBusy, draft, onDraftConsumed, onFirstUserMessage }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [pendingPhoto, setPendingPhoto] = useState(null); // { dataUrl, base64, caption }
  const [regeneratingId, setRegeneratingId] = useState(null);
  const [voice, setVoice] = useState({ state: "idle", seconds: 0, hint: "", live: "" });
  const [appliedNote, setAppliedNote] = useState(""); // "✓ what actually got saved" toast
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
    if (!res || !res.applied || res.applied.length === 0) return;
    setAppliedNote(res.applied.join(" · "));
    clearTimeout(appliedTimer.current);
    appliedTimer.current = setTimeout(() => setAppliedNote(""), 6000);
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

  function sendText() {
    sendMessage(input, true);
  }

  async function regenerateMessage(msg) {
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx <= 0) return;
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
      setPendingPhoto({ dataUrl, base64, caption: "What's going on with this plant?" });
    });
  }

  async function sendPendingPhoto() {
    if (!pendingPhoto || busy) return;
    const { dataUrl, base64, caption } = pendingPhoto;
    setPendingPhoto(null);
    setError("");
    setBusy(true);
    try {
      const text = caption || "What's going on with this plant?";
      if (messages.length === 0) onFirstUserMessage(text);
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
      const data = await apiFetch("/api/vision", {
        imageBase64: base64,
        mimeType: "image/jpeg",
        prompt: await buildChatVisionPrompt(text),
      });
      const { cleanText, actions } = extractActions(data.reply || "");
      const { cleanText: afterStatus } = extractStatus(cleanText);
      const { cleanText: shownText, followups } = extractFollowups(afterStatus);
      const res = await handleAiActions(actions, setPendingActions, { chatId }); // act first
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

  return (
    <div className="tab-panel chat-tab">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-flower1"></i>
            <p>Ask a gardening question or send a photo of a plant to get started.</p>
            <p className="empty-sub">Sprout knows your garden — try "what should I do today?"</p>
          </div>
        )}
        {messages.map((m) => (
          <React.Fragment key={m.id}>
            <MessageBubble
              msg={m}
              onRegenerate={m.role === "assistant" ? () => regenerateMessage(m) : undefined}
              regenerating={regeneratingId === m.id}
            />
            {m.id === lastAssistantId && !busy && (
              <FollowupChips
                suggestions={m.suggestions}
                onPick={(q) => sendMessage(q)}
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
      {error && <div className="error-banner">{error}</div>}
      {appliedNote && (
        <div className="applied-banner">
          <i className="bi bi-check2-circle"></i> {appliedNote}
        </div>
      )}
      <PendingActionsBanner actions={pendingActions} onResolve={setPendingActions} />
      {pendingPhoto && (
        <div className="photo-preview">
          <img src={pendingPhoto.dataUrl} alt="" />
          <textarea
            rows={2}
            value={pendingPhoto.caption}
            onChange={(e) => setPendingPhoto({ ...pendingPhoto, caption: e.target.value })}
            placeholder="Ask something about this photo…"
          />
          <div className="photo-preview-actions">
            <button className="btn" onClick={sendPendingPhoto} disabled={busy}>Send</button>
            <button className="btn btn-ghost" onClick={() => setPendingPhoto(null)}>Cancel</button>
          </div>
        </div>
      )}
      <VoiceListeningBar state={voice.state} seconds={voice.seconds} hint={voice.hint} live={voice.live} />
      <div className="composer">
        <button
          className="icon-btn"
          title="Take a photo"
          onClick={() => cameraInputRef.current.click()}
          disabled={busy}
        >
          <i className="bi bi-camera"></i>
        </button>
        <button
          className="icon-btn"
          title="Photo from gallery"
          onClick={() => fileInputRef.current.click()}
          disabled={busy}
        >
          <i className="bi bi-images"></i>
        </button>
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
          placeholder="Ask Sprout something…"
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
        <button className="btn btn-send" onClick={sendText} disabled={busy || !input.trim()} title="Send">
          <i className="bi bi-send-fill"></i>
        </button>
      </div>
    </div>
  );
}
