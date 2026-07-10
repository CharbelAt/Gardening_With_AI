// The typed Chat tab: text + photo messages, plant/inventory action
// confirmations, and per-message regenerate/copy/read-aloud.

function ChatTab({ chatId, messages, setMessages, busy, setBusy }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [pendingPhoto, setPendingPhoto] = useState(null); // { dataUrl, base64, caption }
  const [regeneratingId, setRegeneratingId] = useState(null);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);

  async function confirmPendingUpdate() {
    if (!pendingUpdate) return;
    if (pendingUpdate.type === "add") await applyPlantAdd(pendingUpdate.fields);
    else if (pendingUpdate.type === "add_tool") await applyToolAdd(pendingUpdate.fields);
    else if (pendingUpdate.type === "remove_tool") await applyToolRemove(pendingUpdate.tool);
    else await applyPlantUpdate(pendingUpdate.plant, pendingUpdate.fields);
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
      const { cleanText, action } = extractPlantUpdate(data.reply || "");
      const aiMsg = { chatId, role: "assistant", kind: "text", text: cleanText, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      if (action) await handlePlantAction(action, setPendingUpdate);
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
      const { cleanText, action } = extractPlantUpdate(data.reply || "");
      const updated = { ...msg, text: cleanText };
      await updateMessage(updated);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
      if (action) await handlePlantAction(action, setPendingUpdate);
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

      const data = await apiFetch("/api/vision", {
        imageBase64: base64,
        mimeType: "image/jpeg",
        prompt: caption || "Identify this plant, assess its health from the photo, and give concrete gardening care advice.",
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
          <MessageBubble
            key={m.id}
            msg={m}
            onRegenerate={m.role === "assistant" ? () => regenerateMessage(m) : undefined}
            regenerating={regeneratingId === m.id}
          />
        ))}
        {busy && <div className="bubble assistant typing">…</div>}
        <div ref={scrollRef} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {pendingUpdate && (
        <div className="confirm-banner">
          <span>
            {pendingUpdate.type === "add" &&
              `Add plant "${pendingUpdate.fields.name || "New plant"}"?`}
            {pendingUpdate.type === "add_tool" &&
              `Add "${pendingUpdate.fields.name || "New item"}" (x${pendingUpdate.fields.quantity || 1}) to inventory?`}
            {pendingUpdate.type === "remove_tool" &&
              `Remove "${pendingUpdate.tool.name}" from inventory?`}
            {pendingUpdate.type === "update" &&
              `Update "${pendingUpdate.plant.name}": ${Object.entries(pendingUpdate.fields).map(([k, v]) => `${k} → ${v}`).join(", ")}?`}
          </span>
          <div className="confirm-actions">
            <button className="btn small" onClick={confirmPendingUpdate}>Apply</button>
            <button className="btn btn-ghost small" onClick={() => setPendingUpdate(null)}>Dismiss</button>
          </div>
        </div>
      )}
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
