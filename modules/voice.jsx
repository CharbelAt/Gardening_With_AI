// Hold-to-talk dictation, embedded in the chat composer. This REPLACES the old
// voice-call loop (call.jsx, deleted): there is no conversation mode, no TTS
// turn-taking, and no barge-in problem to solve — the mic is ONLY live while
// the user physically holds the button down, so it is structurally impossible
// for the app to hear itself. Releasing drops the transcript into the chat
// input (appended, never sent) so the user always reviews before sending.
//
// Two transcription paths:
//   1. MediaRecorder → base64 → POST /api/transcribe (Groq Whisper, server
//      side). Preferred: much better accuracy, works in any browser that has
//      getUserMedia, and handles long holds.
//   2. Browser SpeechRecognition (webkit-prefixed), continuous + interim,
//      auto-restarted for as long as the button is held. Used when
//      getUserMedia is missing or the mic permission is refused.
// Neither available → the button renders disabled with an explanatory title.

const VOICE_MIN_HOLD_MS = 300; // shorter than this is a tap, not a hold

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function canRecordAudio() {
  return !!(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    window.MediaRecorder
  );
}

// Opus in WebM is what Whisper likes best and what Chrome/Android produce
// natively; anything else falls back to the browser's own default container.
function pickAudioMimeType() {
  const preferred = "audio/webm;codecs=opus";
  try {
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === "function") {
      if (MediaRecorder.isTypeSupported(preferred)) return preferred;
      if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
    }
  } catch (_) {}
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read the recording."));
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

// The strip above the composer: live "Listening" state with an elapsed-seconds
// counter, the "Transcribing…" wait, or a short transient hint.
function VoiceListeningBar({ state, seconds, hint }) {
  const listening = state === "listening";
  const transcribing = state === "transcribing";
  if (!listening && !transcribing && !hint) return null;
  const kind = listening ? "listening" : transcribing ? "transcribing" : "hint";
  return (
    <div className={`listening-bar ${kind}`}>
      <span className="listening-dot"></span>
      <span className="listening-text">
        {listening
          ? "Listening — release to send to the input"
          : transcribing
          ? "Transcribing…"
          : hint}
      </span>
      {listening && <span className="listening-time">{seconds}s</span>}
    </div>
  );
}

// The composer's mic button. Press and HOLD to record; release to transcribe.
// onStateChange reports { state, seconds, hint } upward so the chat page can
// render VoiceListeningBar above the composer (a button can't render there).
function VoiceHoldButton({ onTranscript, onError, onStateChange, disabled }) {
  const [state, setState] = useState("idle"); // idle | listening | transcribing
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState("");

  const holdingRef = useRef(false);
  const startedAtRef = useRef(0);
  const modeRef = useRef(null); // "record" | "speech" | null
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const heardRef = useRef({ final: "", interim: "" });
  const tickRef = useRef(null);
  const hintRef = useRef(null);
  const buttonRef = useRef(null);

  const recordSupported = canRecordAudio();
  const supported = recordSupported || !!getSpeechRecognitionCtor();

  useEffect(() => {
    if (onStateChange) onStateChange({ state, seconds, hint });
  }, [state, seconds, hint]);

  useEffect(
    () => () => {
      clearInterval(tickRef.current);
      clearTimeout(hintRef.current);
      cancelCapture(modeRef.current);
      holdingRef.current = false;
    },
    []
  );

  function flashHint(text) {
    setHint(text);
    clearTimeout(hintRef.current);
    hintRef.current = setTimeout(() => setHint(""), 1800);
  }

  function stopStream() {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      streamRef.current = null;
    }
  }

  function killRecognition() {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null; // detach before aborting, or it restarts
      try {
        recognitionRef.current.abort();
      } catch (_) {}
      recognitionRef.current = null;
    }
  }

  // Throws the capture away without transcribing (too-short hold, unmount).
  function cancelCapture(mode) {
    if (mode === "record" && recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      try {
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
      } catch (_) {}
      recorderRef.current = null;
    }
    killRecognition();
    chunksRef.current = [];
    stopStream();
  }

  function startSpeech() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return false;
    heardRef.current = { final: "", interim: "" };
    let rec;
    try {
      rec = new Ctor();
    } catch (_) {
      return false;
    }
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) heardRef.current.final += `${event.results[i][0].transcript} `;
        else interim += event.results[i][0].transcript;
      }
      heardRef.current.interim = interim;
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (onError) onError(`Microphone error: ${e.error}`);
    };
    // Chrome stops recognition on its own after a pause — restart it for as
    // long as the button is held. That is the "no silence timeout" rule.
    rec.onend = () => {
      if (!holdingRef.current) return;
      try {
        rec.start();
      } catch (_) {}
    };
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (_) {
      recognitionRef.current = null;
      return false;
    }
    modeRef.current = "speech";
    return true;
  }

  async function beginHold(e) {
    if (disabled || !supported || holdingRef.current || state === "transcribing") return;
    if (e && e.pointerId != null && buttonRef.current && buttonRef.current.setPointerCapture) {
      // Capture means we still get pointerup if the finger slides off the button.
      try {
        buttonRef.current.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    // The instant the user starts talking, the AI shuts up.
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (_) {}

    holdingRef.current = true;
    startedAtRef.current = Date.now();
    modeRef.current = null;
    setHint("");
    setSeconds(0);
    setState("listening");
    clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);

    if (recordSupported) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!holdingRef.current) {
          // Released while the permission prompt was still open.
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch (_) {}
          return;
        }
        streamRef.current = stream;
        const mimeType = pickAudioMimeType();
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        rec.onstop = () => finishRecording(rec.mimeType || mimeType || "audio/webm");
        recorderRef.current = rec;
        modeRef.current = "record";
        rec.start();
        return;
      } catch (_) {
        // Permission denied / no device / MediaRecorder unhappy — try the
        // browser's own recognizer before giving up.
        stopStream();
        recorderRef.current = null;
      }
    }

    if (holdingRef.current && startSpeech()) return;
    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearInterval(tickRef.current);
    setState("idle");
    if (onError) onError("Microphone unavailable — check this browser's mic permission.");
  }

  function endHold(e) {
    if (e && e.pointerId != null && buttonRef.current && buttonRef.current.releasePointerCapture) {
      try {
        buttonRef.current.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearInterval(tickRef.current);
    const heldMs = Date.now() - startedAtRef.current;
    const mode = modeRef.current;
    modeRef.current = null;

    if (heldMs < VOICE_MIN_HOLD_MS) {
      cancelCapture(mode); // a tap: throw the audio away, don't transcribe
      setState("idle");
      flashHint("Hold to talk");
      return;
    }

    if (mode === "record" && recorderRef.current) {
      setState("transcribing");
      try {
        recorderRef.current.stop(); // onstop → finishRecording
      } catch (_) {
        finishRecording("audio/webm");
      }
      return;
    }

    if (mode === "speech") {
      const text = `${heardRef.current.final} ${heardRef.current.interim}`.replace(/\s+/g, " ").trim();
      killRecognition();
      setState("idle");
      if (text) onTranscript(text);
      else flashHint("Didn't catch that");
      return;
    }

    // Nothing ever started (e.g. the permission prompt is still open).
    setState("idle");
  }

  async function finishRecording(mimeType) {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    recorderRef.current = null;
    stopStream();
    try {
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (!blob.size) {
        flashHint("Didn't catch that");
        return;
      }
      const audioBase64 = await blobToBase64(blob);
      if (!audioBase64) {
        flashHint("Didn't catch that");
        return;
      }
      const data = await apiFetch("/api/transcribe", {
        audioBase64,
        mimeType: blob.type || mimeType || "audio/webm",
      });
      const text = (data && data.text ? String(data.text) : "").trim();
      if (text) onTranscript(text);
      else flashHint("Didn't catch that");
    } catch (err) {
      if (onError) onError(err.message);
    } finally {
      setState("idle");
    }
  }

  const title = !supported
    ? "Voice input isn't available in this browser — type your message instead."
    : state === "transcribing"
    ? "Transcribing…"
    : "Hold to talk — release and the text lands in the input";

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`icon-btn mic-btn ${state}`}
      title={title}
      aria-label="Hold to talk"
      disabled={!!disabled || !supported || state === "transcribing"}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        beginHold(e);
      }}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onBlur={endHold}
      onTouchStart={(e) => {
        // Only for browsers without Pointer Events — otherwise this would
        // double-fire alongside onPointerDown.
        if (window.PointerEvent) return;
        e.preventDefault();
        beginHold(e);
      }}
      onTouchEnd={(e) => {
        if (window.PointerEvent) return;
        e.preventDefault();
        endHold(e);
      }}
    >
      <i className={state === "transcribing" ? "bi bi-hourglass-split" : "bi bi-mic-fill"}></i>
    </button>
  );
}
