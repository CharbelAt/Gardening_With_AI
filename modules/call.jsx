// Voice call, embedded in the Chat page as a bar above the composer. Mounting
// CallBar starts the call; unmounting (End button, leaving the chat view)
// stops it. Transcribed speech and AI replies land in the SAME chat thread as
// typed messages — the chat itself is the live transcript, and the interim
// (not-yet-final) recognition text is previewed in the bar.
//
// Keeps the battle-tested stale-closure guards: statusRef (not React state)
// checked in rec.onend, killRecognition() detaching onend before abort, and a
// 500ms pause after TTS before the mic reopens — this is what stops the mic
// from hearing the AI's own voice.

function CallBar({ chatId, messages, setMessages, onClose }) {
  const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const [status, setStatus] = useState("idle"); // listening | thinking | speaking
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const activeRef = useRef(false);
  const statusRef = useRef("idle");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  function updateStatus(next) {
    statusRef.current = next;
    setStatus(next);
  }

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
    if (!activeRef.current) return;
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
      // of React state avoids restarting the mic during "thinking"/"speaking"
      // and picking up the AI's own voice as new input.
      if (activeRef.current && statusRef.current === "listening") {
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
      const { cleanText, actions } = extractActions(data.reply || "");
      const reply = cleanText || "Sorry, I didn't catch that.";
      const aiMsg = { chatId, role: "assistant", kind: "text", text: reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      speak(reply);
      // Calls apply updates only in auto mode — no confirm UI mid-call
      // (handleAiActions skips writes in confirm mode when passed null).
      await handleAiActions(actions, null);
    } catch (e) {
      setError(e.message);
      if (activeRef.current) startListening();
      else updateStatus("idle");
    }
  }

  function speak(text) {
    killRecognition(); // guarantee the mic is off before we start talking
    updateStatus("speaking");
    const utter = new SpeechSynthesisUtterance(stripForSpeech(text));
    utter.rate = 1.0;
    utter.onend = () => {
      // Short pause lets the phone speaker's audio tail die out before the
      // mic reopens, so it doesn't hear its own reply as new input.
      setTimeout(() => {
        if (activeRef.current) startListening();
        else updateStatus("idle");
      }, 500);
    };
    utter.onerror = () => {
      if (activeRef.current) startListening();
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  // Mount = call starts; unmount = full cleanup (mic off, TTS cancelled).
  useEffect(() => {
    activeRef.current = true;
    startListening();
    return () => {
      activeRef.current = false;
      killRecognition();
      window.speechSynthesis.cancel();
    };
  }, []);

  const statusLabel = {
    idle: "Connecting…",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  }[status];

  return (
    <div className="call-bar">
      <div className={`call-orb mini ${status}`} />
      <div className="call-bar-text">
        <span className="call-bar-status">{statusLabel}</span>
        {liveTranscript && <span className="call-bar-transcript">"{liveTranscript}"</span>}
        {error && <span className="call-bar-error">{error}</span>}
      </div>
      <button className="btn btn-end-call small" onClick={onClose} title="End call">
        <i className="bi bi-telephone-x"></i> End
      </button>
    </div>
  );
}
