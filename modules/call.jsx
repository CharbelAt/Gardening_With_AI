// Voice call, embedded in the Chat page as a bar above the composer. Mounting
// CallBar starts the call; unmounting (End button, leaving the chat view)
// stops it. Transcribed speech and AI replies land in the SAME chat thread as
// typed messages — the chat itself is the live transcript, and the interim
// (not-yet-final) recognition text is previewed in the bar.
//
// BARGE-IN (user request): the mic now stays open WHILE Sprout is speaking.
// If the user starts talking mid-reply, TTS is cancelled and the call flips
// straight to listening. To keep the mic from hearing Sprout's own voice as
// "user speech" (the old feedback bug), everything heard during speaking —
// and within a 1s tail after it — is checked against the text currently being
// spoken (isLikelyEcho) and needs a minimum length before it counts as a real
// interruption. statusRef (not React state) still drives all handler logic.

function CallBar({ chatId, messages, setMessages, onClose }) {
  const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const [status, setStatus] = useState("idle"); // listening | thinking | speaking
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const activeRef = useRef(false);
  const statusRef = useRef("idle");
  const spokenRef = useRef({ text: "", endedAt: 0 }); // what TTS is/was saying (echo filter)
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

  function normalizeSpeech(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // True when what the mic heard is (probably) Sprout's own voice: we're
  // speaking (or just finished <1s ago) and the heard text appears inside the
  // text being spoken.
  function isLikelyEcho(heard) {
    const spoken = normalizeSpeech(spokenRef.current.text);
    if (!spoken) return false;
    const h = normalizeSpeech(heard);
    if (!h) return true;
    const inEchoWindow =
      statusRef.current === "speaking" || Date.now() - spokenRef.current.endedAt < 1000;
    return inEchoWindow && spoken.includes(h);
  }

  const startListening = useCallback((opts = {}) => {
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
      const heard = (interim || finalText).trim();
      if (!heard) return;

      if (statusRef.current === "speaking") {
        // Barge-in check: ignore our own echo and too-short noises; a real
        // interruption cancels TTS and flips to listening immediately.
        if (isLikelyEcho(heard) || normalizeSpeech(heard).length < 6) return;
        window.speechSynthesis.cancel();
        updateStatus("listening");
      } else if (isLikelyEcho(heard)) {
        return; // echo tail right after TTS finished
      }

      setLiveTranscript(heard);
      if (finalText.trim() && statusRef.current === "listening" && !isLikelyEcho(finalText)) {
        handleUserUtterance(finalText.trim());
      }
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(`Mic error: ${e.error}`);
    };

    rec.onend = () => {
      // Auto-restart whenever the call should still be hearing the user:
      // during listening (silence timeout) AND during speaking (barge-in
      // watch). Reading statusRef avoids the old stale-closure feedback bug.
      if (
        activeRef.current &&
        (statusRef.current === "listening" || statusRef.current === "speaking")
      ) {
        try {
          rec.start();
        } catch (_) {}
      }
    };

    recognitionRef.current = rec;
    if (!opts.keepStatus) updateStatus("listening");
    setLiveTranscript("");
    rec.start();
  }, []);

  async function handleUserUtterance(text) {
    killRecognition();
    window.speechSynthesis.cancel(); // in case we got here via barge-in
    updateStatus("thinking");
    setLiveTranscript("");
    setError("");

    const userMsg = { chatId, role: "user", kind: "text", text, createdAt: Date.now() };
    userMsg.id = await addMessage(userMsg);
    const nextHistory = [...messagesRef.current, userMsg];
    setMessages(nextHistory);

    try {
      const data = await apiFetch("/api/chat", {
        mode: "call",
        messages: await buildContextMessages(nextHistory, "call"),
      });
      const { cleanText, actions } = extractActions(data.reply || "");
      const reply = cleanText || "Sorry, I didn't catch that.";
      // Act FIRST (IndexedDB writes are instant), then speak — so by the time
      // Sprout says "done", it's actually done. Calls apply updates only in
      // auto mode (handleAiActions skips writes in confirm mode when passed null).
      await handleAiActions(actions, null);
      const aiMsg = { chatId, role: "assistant", kind: "text", text: reply, createdAt: Date.now() };
      aiMsg.id = await addMessage(aiMsg);
      setMessages((prev) => [...prev, aiMsg]);
      speak(reply);
    } catch (e) {
      setError(e.message);
      if (activeRef.current) startListening();
      else updateStatus("idle");
    }
  }

  function speak(text) {
    updateStatus("speaking");
    const speakable = stripForSpeech(text);
    spokenRef.current = { text: speakable, endedAt: 0 };
    const utter = new SpeechSynthesisUtterance(speakable);
    utter.rate = 1.0;
    utter.onend = () => {
      spokenRef.current.endedAt = Date.now();
      if (!activeRef.current) return updateStatus("idle");
      // No barge-in happened — flip to listening; the recognizer is already
      // running (echo filtering handles the 1s audio tail).
      if (statusRef.current === "speaking") updateStatus("listening");
    };
    utter.onerror = () => {
      spokenRef.current.endedAt = Date.now();
      if (activeRef.current && statusRef.current === "speaking") updateStatus("listening");
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    // Keep the mic open while talking so the user can interrupt.
    startListening({ keepStatus: true });
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
    speaking: "Speaking — talk to interrupt",
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
