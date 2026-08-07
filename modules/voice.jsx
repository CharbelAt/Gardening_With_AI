// Hold-to-talk dictation, embedded in the chat composer. This REPLACES the old
// voice-call loop (call.jsx, deleted): there is no conversation mode, no TTS
// turn-taking, and no barge-in problem to solve — the mic is ONLY live while
// the user physically holds the button down, so it is structurally impossible
// for the app to hear itself. Releasing drops the transcript into the chat
// input (appended, never sent) so the user always reviews before sending.
//
// Two transcription paths:
//   1. Browser SpeechRecognition (webkit-prefixed), continuous + interim,
//      auto-restarted for as long as the button is held. PRIMARY, because it
//      hands words back WHILE the user is still holding — the listening bar
//      echoes them in real time, the way the old call mode did. A
//      record-then-upload round trip structurally cannot do that.
//   2. MediaRecorder → base64 → POST /api/transcribe (Groq Whisper, server
//      side). FALLBACK, only for browsers with no SpeechRecognition at all
//      (Firefox, some in-app webviews): more accurate, but silent until
//      release, so it is the only path that still shows "Transcribing…".
// Neither available → the button renders disabled with an explanatory title.

// Flips true the first time /api/transcribe 404s (route missing from an
// older, un-updated server.js). Only the fallback path reads it: once true
// there is no point recording audio the server will just 404 on again.
// Plain global — this file is a classic script, no module system to hold
// state in.
let transcribeUnavailable = false;

const VOICE_MIN_HOLD_MS = 300; // shorter than this is a tap, not a hold

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Everything heard so far as one line: the finals accumulated across the
// auto-restarts plus whatever the recognizer is still guessing at. Shared by
// the live echo in the bar and the text handed over on release, so the two can
// never disagree.
function joinHeard(heard) {
  return `${heard.final} ${heard.interim}`.replace(/\s+/g, " ").trim();
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
// counter, the "Transcribing…" wait, or a short transient hint. While the
// recognizer is feeding words back, `live` replaces the static label so the
// user can see what was heard before deciding to let go. .listening-text
// already clips to one line with an ellipsis, so long dictations truncate.
function VoiceListeningBar({ state, seconds, hint, live }) {
  const listening = state === "listening";
  const transcribing = state === "transcribing";
  if (!listening && !transcribing && !hint) return null;
  const kind = listening ? "listening" : transcribing ? "transcribing" : "hint";
  const liveText = listening ? String(live || "").trim() : "";
  return (
    <div className={`listening-bar ${kind}`}>
      <span className="listening-dot"></span>
      <span className="listening-text">
        {listening ? (
          liveText ? (
            <span className="voice-live-text">“{liveText}”</span>
          ) : (
            "Listening — release to send to the input"
          )
        ) : transcribing ? (
          "Transcribing…"
        ) : (
          hint
        )}
      </span>
      {listening && <span className="listening-time">{seconds}s</span>}
    </div>
  );
}

// The composer's mic button. Press and HOLD to talk; release to hand the text
// to the input. onStateChange reports { state, seconds, hint, live } upward so
// the chat page can render VoiceListeningBar above the composer (a button
// can't render there) — `live` is what carries the real-time transcript.
function VoiceHoldButton({ onTranscript, onError, onStateChange, disabled }) {
  const [state, setState] = useState("idle"); // idle | listening | transcribing
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState("");
  const [live, setLive] = useState(""); // words heard so far, while still held

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
  const supported = !!getSpeechRecognitionCtor() || recordSupported;

  useEffect(() => {
    if (onStateChange) onStateChange({ state, seconds, hint, live });
  }, [state, seconds, hint, live]);

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
      // The finals survive the restarts below, so this is the whole hold so
      // far — pushed to state on every result, which is what makes the
      // listening bar update while the button is still down.
      setLive(joinHeard(heardRef.current));
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      // A refused mic is permanent for this hold: drop the restart hook
      // first, or onend below would loop start() — and this banner — until
      // the finger lifts.
      const blocked = e.error === "not-allowed" || e.error === "service-not-allowed";
      if (blocked) rec.onend = null;
      if (onError) {
        onError(
          blocked
            ? "Microphone blocked — allow mic access for this site, then hold again."
            : `Microphone error: ${e.error}`
        );
      }
    };
    // Chrome stops recognition on its own after a pause — restart it for as
    // long as the button is held. That is the "no silence timeout" rule.
    // heardRef is NOT reset here, so finals accumulate across the restarts.
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
    setLive("");
    setSeconds(0);
    setState("listening");
    clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);

    // PRIMARY. Synchronous, so unlike getUserMedia below there is no await
    // window where a release could slip past us, and words start coming back
    // immediately instead of after the upload.
    if (startSpeech()) return;

    // FALLBACK: no SpeechRecognition in this browser. Record the hold and let
    // the server's Whisper read it on release. Once the server has proven it
    // has no /api/transcribe route, don't bother recording for it either.
    if (recordSupported && !transcribeUnavailable) {
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
        // Permission denied / no device / MediaRecorder unhappy. There is no
        // recognizer left to try — fall through to the error below.
        stopStream();
        recorderRef.current = null;
      }
    }

    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearInterval(tickRef.current);
    setState("idle");
    if (onError) {
      // Nothing started. If we already know the server lacks /api/transcribe,
      // say that instead of blaming the mic.
      onError(
        transcribeUnavailable
          ? "This browser has no on-device recognition and the server lacks the transcription endpoint (update server.js, pm2 restart)."
          : "Microphone unavailable — check this browser's mic permission."
      );
    }
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
    setLive("");
    const heldMs = Date.now() - startedAtRef.current;
    const mode = modeRef.current;
    modeRef.current = null;

    if (heldMs < VOICE_MIN_HOLD_MS) {
      cancelCapture(mode); // a tap: throw the audio away, don't transcribe
      setState("idle");
      flashHint("Hold to talk");
      return;
    }

    // Only the fallback waits: the recording still has to go to the server.
    if (mode === "record" && recorderRef.current) {
      setState("transcribing");
      try {
        recorderRef.current.stop(); // onstop → finishRecording
      } catch (_) {
        finishRecording("audio/webm");
      }
      return;
    }

    // The words are already here — nothing to wait for, so no "Transcribing…".
    if (mode === "speech") {
      const text = joinHeard(heardRef.current);
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
      // A 404 means this server.js predates /api/transcribe entirely — that's
      // not transient like a 503 or network blip, so remember it and stop
      // hitting the endpoint. We only ever get here in a browser with no
      // SpeechRecognition, so there is no other path to offer: voice is dead
      // until the VPS is updated, and this says so once.
      if (!transcribeUnavailable && /\(404\)/.test(err.message || "")) {
        transcribeUnavailable = true;
        if (onError) {
          onError(
            "This browser has no on-device recognition and the server lacks the transcription endpoint (update server.js, pm2 restart)."
          );
        }
      } else if (onError) {
        onError(err.message);
      }
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
