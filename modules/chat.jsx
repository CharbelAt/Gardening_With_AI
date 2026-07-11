// The typed Chat tab: text + photo messages, AI action confirmations
// (multi-action aware), and per-message regenerate/copy/read-aloud.

function ChatTab({ chatId, messages, setMessages, busy, setBusy, draft, onDraftConsumed, onFirstUserMessage }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [pendingPhoto, setPendingPhoto] = useState(null); // { dataUrl, base64, caption }
  const [regeneratingId, setRegeneratingId] = useState(null);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

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
  }, [messages, busy]);

  async function sendText() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    if (messages.length === 0) onFirstUserMessage(text);
    const userMsg = { chatId, role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setBusy(true);
    try {
      const data = await apiFetch("/api/chat", {
        messages: await buildContextMessages(nextHistory, "chat"),
      });
      const { cleanText, actions } = extractActions(data.reply || "");
      const aiMsg = { chatId, role: "assistant", kind: "text", text: cleanText, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      await handleAiActions(actions, setPendingActions);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function regenerateMessage(msg) {
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx <= 0) return;
    const historyUpTo = messages.slice(0, idx); // everything before this reply, ending in the user's message
    setRegeneratingId(msg.id);
    setError("");
    try {
      const data = await apiFetch("/api/chat", { messages: await buildContextMessages(historyUpTo, "chat") });
      const { cleanText, actions } = extractActions(data.reply || "");
      const updated = { ...msg, text: cleanText };
      await updateMessage(updated);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
      await handleAiActions(actions, setPendingActions);
    } catch (e) {
      setError(e.message);
    } finally {
      setRegeneratingId(null);
    }
  }

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
      const userMsg = {
        chatId,
        role: "user",
        kind: "image",
        text: caption || "What's going on with this plant?",
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
        prompt: await buildChatVisionPrompt(caption || "What's going on with this plant?"),
      });
      const { cleanText, actions } = extractActions(data.reply || "");
      const aiMsg = { chatId, role: "assistant", kind: "text", text: cleanText, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      await handleAiActions(actions, setPendingActions);
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
            <p>Ask a gardening question or snap a photo of a plant to get started.</p>
            <p className="empty-sub">Sprout knows your garden — try "what should I do today?"</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            msg={m}
            onRegenerate={m.role === "assistant" ? () => regenerateMessage(m) : undefined}
            regenerating={regeneratingId === m.id}
          />
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
          ref={inputRef}
          className="text-input"
          type="text"
          placeholder="Ask Sprout something…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendText()}
          disabled={busy}
        />
        <button className="btn btn-send" onClick={sendText} disabled={busy || !input.trim()} title="Send">
          <i className="bi bi-send-fill"></i>
        </button>
      </div>
    </div>
  );
}
