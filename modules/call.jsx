// The hands-free Call tab: browser speech recognition + speech synthesis,
// with the stale-closure guards that keep the mic from hearing the AI's own
// voice (see statusRef/killRecognition comments below).

function CallTab({ chatId, messages, setMessages }) {
  const SpeechRecognitionCtor =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SpeechRecognitionCtor && "speechSynthesis" in window;

  const [callActive, setCallActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | speaking
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const callActiveRef = useRef(false);
  const statusRef = useRef("idle");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  function updateStatus(next) {
    statusRef.current = next;
    setStatus(next);
  }

  // Kills whatever recognizer is currently running, detaching its onend first
  // so stopping it doesn't trigger the auto-restart logic below.
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
    if (!callActiveRef.current) return;
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
      // of the React state avoids a stale-closure bug where this handler
      // would restart the mic during "thinking"/"speaking" and pick up the
      // AI's own voice as new input.
      if (callActiveRef.current && statusRef.current === "listening") {
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
      // Voice calls apply updates only in auto mode — there's no good way to
      // show a confirm prompt mid-call, so confirm-mode just skips writing
      // (handleAiActions does exactly that when passed no pending-queue setter).
      await handleAiActions(actions, null);
    } catch (e) {
      setError(e.message);
      if (callActiveRef.current) startListening();
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
        if (callActiveRef.current) startListening();
        else updateStatus("idle");
      }, 500);
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
    updateStatus("idle");
    setLiveTranscript("");
    killRecognition();
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
