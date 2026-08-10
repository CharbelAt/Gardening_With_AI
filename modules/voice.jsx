// Tap-to-talk dictation, embedded in the chat composer. This REPLACES the old
// voice-call loop (call.jsx, deleted): there is no conversation mode, no TTS
// turn-taking, no barge-in problem to solve. One tap arms the mic, the next
// tap disarms it and drops everything heard into the chat input (appended,
// never sent) so the user always reviews before sending.
//
// Toggle, not press-and-hold (changed 2026-08-07): dictating a whole sentence
// with a thumb pinned to a 40px button is miserable, and sliding off it lost
// the take. The cost of the toggle is that the mic can now outlive the user's
// attention — so starting still cancels any TTS (the AI shuts up the moment
// you talk), read-aloud is never automatic, and a 90s auto-stop bounds how
// long an abandoned mic can sit open.
//
// Two transcription paths:
//   1. Browser SpeechRecognition (webkit-prefixed), continuous + interim,
//      auto-restarted for as long as the toggle is on. PRIMARY, because it
//      hands words back WHILE the user is still talking — the listening bar
//      echoes them in real time, the way the old call mode did. A
//      record-then-upload round trip structurally cannot do that.
//   2. MediaRecorder → base64 → POST /api/transcribe (Groq Whisper, server
//      side). FALLBACK, only for browsers with no SpeechRecognition at all
//      (Firefox, some in-app webviews): more accurate, but silent until the
//      second tap, so it is the only path that still shows "Transcribing…".
// Neither available → the button renders disabled with an explanatory title.

// Flips true the first time /api/transcribe 404s (route missing from an
// older, un-updated server.js). Only the fallback path reads it: once true
// there is no point recording audio the server will just 404 on again.
// Plain global — this file is a classic script, no module system to hold
// state in.
let transcribeUnavailable = false;

// Two taps closer together than this are a fumble on a small button, not a
// deliberate start-then-stop.
const VOICE_TAP_DEBOUNCE_MS = 300;
// Safety net for the toggle: nothing forces the user to come back and turn the
// mic off (pocket, distraction, a tab left open), so this does it for them and
// still delivers what was heard.
const VOICE_MAX_LISTEN_MS = 90000;
const VOICE_AUTO_STOP_HINT = "Auto-stopped after 90s";

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// ---------------------------------------------------------------------------
// Transcript assembly. Read this before "simplifying" anything below it.
//
// SpeechRecognition duplicates words in two independent ways, and the old
// `heardRef.final += …` per onresult walked into both of them:
//
//   1. WITHIN one recognition session, `event.results` is CUMULATIVE — every
//      onresult re-delivers the entries the previous ones already carried.
//      Appending each event's finals therefore counts them once per event,
//      which is where "water water water the the tomatoes" came from. Cure:
//      never +=; rebuild the whole session transcript from results[0] on
//      every event (see rec.onresult).
//   2. ACROSS the automatic restarts (rec.onend → start()), Chrome on Android
//      frequently REPLAYS the finished session's finals as the opening results
//      of the new one. Rebuilding does not help there — the replay arrives as
//      genuinely new results in a genuinely new session. Cure: trimOverlap(),
//      applied at every seam (bank-on-restart, banked→final, final→interim).
// ---------------------------------------------------------------------------

// Splits a transcript into display words plus the normalized keys the overlap
// test compares on: case and the punctuation a recognizer sprinkles in
// ("tomatoes." vs "tomatoes") must not make a replayed word look new. The two
// arrays stay index-aligned, so a match found on keys can be sliced off words.
function voiceWords(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return {
    words,
    keys: words.map((w) => w.toLowerCase().replace(/[.,!?;:'"“”‘’…]/g, "")),
  };
}

// Returns the part of `next` that is not already sitting at the end of `prev`:
// the longest run of words that is both a tail of `prev` and a head of `next`
// is dropped. "" means `next` was nothing but replay. This is what makes every
// seam idempotent — banking the same session twice, or Android replaying the
// last session verbatim, both collapse to nothing new.
// Deliberate trade-off: a user who genuinely repeats a phrase across a restart
// boundary loses the repeat. Duplicated words are the bug that was reported;
// this is the cheaper failure.
function trimOverlap(prev, next) {
  const b = voiceWords(next);
  if (b.words.length === 0) return "";
  const a = voiceWords(prev);
  if (a.words.length === 0) return b.words.join(" ");
  for (let n = Math.min(a.keys.length, b.keys.length); n > 0; n--) {
    let same = true;
    for (let i = 0; i < n; i++) {
      const key = a.keys[a.keys.length - n + i];
      // Empty keys (a token that was pure punctuation) never count as a match.
      if (!key || key !== b.keys[i]) {
        same = false;
        break;
      }
    }
    if (same) return b.words.slice(n).join(" ");
  }
  return b.words.join(" ");
}

// Everything heard so far as one line: the segments banked from earlier
// recognition sessions, then this session's finals, then its interim guess —
// with the overlap guard applied at both seams. The live echo in the bar and
// the text handed over on stop both come through here, so the two can never
// disagree and neither can stutter.
function joinHeard(segments, session) {
  const banked = (segments || []).join(" ");
  const final = session ? session.final : "";
  const interim = session ? session.interim : "";
  const withFinal = `${banked} ${trimOverlap(banked, final)}`;
  return `${withFinal} ${trimOverlap(withFinal, interim)}`.replace(/\s+/g, " ").trim();
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
// user can see what was heard before tapping stop. .listening-text already
// clips to one line with an ellipsis, so long dictations truncate.
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
            "Listening — tap the mic to stop"
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

// The composer's mic button. Tap to start talking, tap again to hand the text
// to the input. onStateChange reports { state, seconds, hint, live } upward so
// the chat page can render VoiceListeningBar above the composer (a button
// can't render there) — `live` is what carries the real-time transcript.
function VoiceButton({ onTranscript, onError, onStateChange, disabled }) {
  const [state, setState] = useState("idle"); // idle | listening | transcribing
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState("");
  const [live, setLive] = useState(""); // words heard so far, while listening

  const activeRef = useRef(false); // the toggle itself: true between the taps
  const startedAtRef = useRef(0);
  const lastTapRef = useRef(0);
  const modeRef = useRef(null); // "record" | "speech" | null
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const segmentsRef = useRef([]); // finals banked from earlier SR sessions
  const sessionRef = useRef({ final: "", interim: "" }); // the current session
  const tickRef = useRef(null);
  const maxTimerRef = useRef(null);
  const autoStoppedRef = useRef(false); // 90s stop, hinted after the upload
  const hintRef = useRef(null);

  const recordSupported = canRecordAudio();
  const supported = !!getSpeechRecognitionCtor() || recordSupported;

  useEffect(() => {
    if (onStateChange) onStateChange({ state, seconds, hint, live });
  }, [state, seconds, hint, live]);

  // Unmount (leaving the chat view, switching chats) kills the mic. activeRef
  // goes false FIRST so rec.onend can't restart recognition on the way out.
  useEffect(
    () => () => {
      activeRef.current = false;
      clearInterval(tickRef.current);
      clearTimeout(hintRef.current);
      clearTimeout(maxTimerRef.current);
      cancelCapture(modeRef.current);
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

  // Throws the capture away without transcribing (unmount).
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

  // Move the finished session's finals into segmentsRef, minus whatever is
  // just a replay of what is already banked, then clear the session so the
  // next onresult rebuild starts from nothing.
  function bankSession() {
    const fresh = trimOverlap(segmentsRef.current.join(" "), sessionRef.current.final);
    if (fresh) segmentsRef.current.push(fresh);
    // Anything still interim when a session ends is dropped: the audio behind
    // it is gone, and it is usually a half-guess at words the finals already
    // contain.
    sessionRef.current = { final: "", interim: "" };
  }

  function startSpeech() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return false;
    segmentsRef.current = [];
    sessionRef.current = { final: "", interim: "" };
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
      // Rebuild this session from index 0 — NEVER += across events. See the
      // block comment above trimOverlap: event.results is cumulative, so this
      // one event already contains everything the earlier ones delivered.
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const alt = event.results[i][0];
        const chunk = alt ? alt.transcript : "";
        if (event.results[i].isFinal) final += `${chunk} `;
        else interim += `${chunk} `;
      }
      sessionRef.current = { final, interim };
      // Pushed to state on every result, which is what makes the listening bar
      // update while the mic is still open.
      setLive(joinHeard(segmentsRef.current, sessionRef.current));
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      // A refused mic is permanent for this session: drop the restart hook
      // first, or onend below would loop start() — and this banner — until the
      // user taps stop.
      const blocked = e.error === "not-allowed" || e.error === "service-not-allowed";
      if (blocked) rec.onend = null;
      if (onError) {
        onError(
          blocked
            ? "Microphone blocked — allow mic access for this site, then tap the mic again."
            : `Microphone error: ${e.error}`
        );
      }
    };
    // Chrome stops recognition on its own after a pause — restart it until the
    // user taps stop. That is the "no silence timeout" rule. Banking BEFORE
    // the restart is what keeps the restart from re-counting words: the next
    // session starts its results over, and on Android it likes to open by
    // replaying what we just banked.
    rec.onend = () => {
      if (!activeRef.current) return;
      bankSession();
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

  // First tap.
  async function startListening() {
    if (disabled || !supported || activeRef.current || state === "transcribing") return;
    // The instant the user starts talking, the AI shuts up.
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (_) {}

    activeRef.current = true;
    autoStoppedRef.current = false;
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
    clearTimeout(maxTimerRef.current);
    maxTimerRef.current = setTimeout(() => stopListening(true), VOICE_MAX_LISTEN_MS);

    // PRIMARY. Synchronous, so unlike getUserMedia below there is no await
    // window where a stop tap could slip past us, and words start coming back
    // immediately instead of after the upload.
    if (startSpeech()) return;

    // FALLBACK: no SpeechRecognition in this browser. Record until the second
    // tap and let the server's Whisper read it. Once the server has proven it
    // has no /api/transcribe route, don't bother recording for it either.
    if (recordSupported && !transcribeUnavailable) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!activeRef.current) {
          // Stopped (or unmounted) while the permission prompt was still open.
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

    if (!activeRef.current) return;
    activeRef.current = false;
    clearInterval(tickRef.current);
    clearTimeout(maxTimerRef.current);
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

  // Second tap — or the 90s safety net, which passes auto=true so the bar can
  // explain why the mic closed on its own. Either way the text is delivered.
  function stopListening(auto) {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearInterval(tickRef.current);
    clearTimeout(maxTimerRef.current);
    setLive("");
    const mode = modeRef.current;
    modeRef.current = null;

    // Only the fallback waits: the recording still has to go to the server.
    if (mode === "record" && recorderRef.current) {
      autoStoppedRef.current = !!auto; // hinted once finishRecording resolves
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
      // Banked segments + this session's finals + the trailing interim, with
      // joinHeard's overlap guard on both seams (the interim is usually a
      // re-statement of the final tail, and would otherwise say it twice).
      const text = joinHeard(segmentsRef.current, sessionRef.current);
      killRecognition();
      segmentsRef.current = [];
      sessionRef.current = { final: "", interim: "" };
      setState("idle");
      if (text) onTranscript(text);
      if (auto) flashHint(VOICE_AUTO_STOP_HINT);
      else if (!text) flashHint("Didn't catch that");
      return;
    }

    // Nothing ever started (e.g. the permission prompt is still open).
    setState("idle");
    if (auto) flashHint(VOICE_AUTO_STOP_HINT);
  }

  // The one handler behind the button. The debounce is a fumble guard, not a
  // double-click guard: on a small button a fast second tap is usually a
  // mis-hit, and without this it would arm and disarm the mic in the same
  // gesture and deliver nothing.
  function toggleListening() {
    const now = Date.now();
    if (now - lastTapRef.current < VOICE_TAP_DEBOUNCE_MS) return;
    lastTapRef.current = now;
    if (activeRef.current) stopListening(false);
    else startListening();
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
      if (autoStoppedRef.current) {
        autoStoppedRef.current = false;
        flashHint(VOICE_AUTO_STOP_HINT);
      }
    }
  }

  const listening = state === "listening";
  const title = !supported
    ? "Voice input isn't available in this browser — type your message instead."
    : state === "transcribing"
    ? "Transcribing…"
    : listening
    ? "Stop and drop the text into the input"
    : "Tap to talk — tap again and the text lands in the input";
  // While listening the button stays tappable even if the composer goes busy
  // (a send can start mid-dictation) — otherwise there would be no way to stop
  // it, and the mic would run to the 90s cap.
  const buttonDisabled = (!!disabled && !listening) || !supported || state === "transcribing";

  return (
    <button
      type="button"
      className={`icon-btn mic-btn ${state}`}
      title={title}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      aria-pressed={listening}
      disabled={buttonDisabled}
      onClick={toggleListening}
    >
      <i
        className={
          state === "transcribing"
            ? "bi bi-hourglass-split"
            : listening
            ? "bi bi-stop-fill"
            : "bi bi-mic-fill"
        }
      ></i>
    </button>
  );
}
