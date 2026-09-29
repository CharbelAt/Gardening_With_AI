// Garden view: the Garden tab's second look — every plant standing in a pot on
// a shelf, one shelf per location, drawn from the SAME records as the grid.
// It is a status board with a little play in it, not a game: a thirsty plant
// droops and shows a water drop (tap it = the "Watered" button), a plant with
// a feeding routine due shows a small badge, and tapping the plant opens its
// page. No coins, no streaks, no stored positions (the grouping is the
// plant's own location field, so nothing new has to be kept in sync).
//
// Cutouts: a plant with a photo gets a transparent PNG of itself, made once
// by the server's background remover (POST /api/cutout → rembg) and stored on
// the plant as `cutoutThumb`, together with `cutoutFrom` — a fingerprint of the
// photo it was cut from, so a new cover photo is re-cut automatically and a
// failed/unusable cut is not retried forever. No server, or a bad cut → the
// photo is shown in a round frame instead.
//
// Classic script sharing the page's global scope — no import/export. Loads
// after garden.jsx (see index.html); GardenView renders it at render time.

const LS_GARDEN_VIEW = "gc_gardenView"; // "grid" | "garden"
const CUTOUT_SOURCE_MAX_DIM = 512; // what is sent to the server
const CUTOUT_STORE_MAX_DIM = 320; // what is kept on the plant
// Below this share of opaque pixels the model found (nearly) nothing; above
// the upper bound it removed (nearly) nothing. Either way a frame looks better.
const CUTOUT_MIN_COVERAGE = 0.04;
const CUTOUT_MAX_COVERAGE = 0.96;

function getGardenViewMode() {
  try {
    return localStorage.getItem(LS_GARDEN_VIEW) === "garden" ? "garden" : "grid";
  } catch (_) {
    return "grid";
  }
}

function setGardenViewMode(mode) {
  try {
    localStorage.setItem(LS_GARDEN_VIEW, mode === "garden" ? "garden" : "grid");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
}

// Same rule as the plant page's hero image: the cover wins, else the newest
// gallery photo.
function plantPhotoSource(plant) {
  if (!plant) return null;
  if (plant.coverThumb) return plant.coverThumb;
  const latest = (plant.photoHistory || []).filter((p) => p && p.imageThumb).slice(-1)[0];
  return latest ? latest.imageThumb : null;
}

// Cheap fingerprint of a data URL (djb2 over the string + its length). Only
// used to notice "the photo changed since the last cut", never for security.
function cutoutSourceKey(dataUrl) {
  const s = String(dataUrl || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

// The model the server cuts with right now (GET /health → cutout.model), read
// once per session. When it differs from the model a plant was cut with, that
// plant is re-cut — so changing REMBG_MODEL on the VPS redoes the whole garden
// by itself (user report: the old model kept only the fruit).
let zenServerCutoutModel = null;
async function zenLoadServerCutoutModel() {
  if (zenServerCutoutModel) return zenServerCutoutModel;
  try {
    const { apiBase } = getSettings();
    if (!apiBase) return null;
    const r = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(8000) });
    const h = await r.json();
    zenServerCutoutModel = (h && h.cutout && h.cutout.enabled && h.cutout.model) || null;
  } catch (e) {
    console.error("garden view: couldn't read the cutout model:", e && e.message);
  }
  return zenServerCutoutModel;
}

// True when nothing needs cutting: no photo, the user chose the photo over a
// cutout, or a cut for the CURRENT photo with the CURRENT model was already
// attempted (successful or not).
function cutoutUpToDate(plant, model = zenServerCutoutModel) {
  if (plant.cutoutOff) return true;
  const src = plantPhotoSource(plant);
  if (!src) return true;
  if (plant.cutoutFrom !== cutoutSourceKey(src)) return false;
  // A cut the user made by pointing at the plant is kept until the photo
  // itself changes — a server model switch never overwrites it.
  if (plant.cutoutManual) return true;
  return !model || plant.cutoutModel === model;
}

// Alpha statistics over an ImageData-shaped { data, width, height }: share of
// opaque pixels and their bounding box (null when there are none).
function analyzeCutoutAlpha(img, threshold = 24) {
  const { data, width, height } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = width * height || 1;
  return {
    coverage: opaque / total,
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// Did the cutout keep a POT? The background remover sometimes treats the pot
// as background and returns the plant alone (user report, 2026-09-29: "it is
// removing the pot"). A pot is a solid, wide block along the bottom of the
// cutout; stems and foliage there are sparse. So: the average share of opaque
// pixels across the bottom 15% of the plant's bounding box.
const CUTOUT_POT_MIN_BOTTOM_FILL = 0.35;
function cutoutBottomFill(img, bbox, threshold = 24) {
  if (!bbox) return 0;
  const { data, width } = img;
  const rows = Math.max(1, Math.round(bbox.h * 0.15));
  let opaque = 0;
  for (let y = bbox.y + bbox.h - rows; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) opaque++;
    }
  }
  return opaque / (rows * bbox.w);
}

function cutoutLooksUsable(stats) {
  return !!(stats && stats.bbox && stats.coverage >= CUTOUT_MIN_COVERAGE && stats.coverage <= CUTOUT_MAX_COVERAGE);
}

function zenLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read the image"));
    img.src = src;
  });
}

async function zenShrinkToJpeg(dataUrl, maxDim) {
  const img = await zenLoadImage(dataUrl);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Makes (or re-makes) one plant's cutout and writes it to the plant record.
// Returns "ok" | "unusable" | "no-photo". Throws on server/network errors so
// the caller can tell "feature off" from "try again later".
// Turns the server's PNG into what the plant stores: trimmed to the plant
// (plus a little air), scaled down, and checked for a kept pot. `allowAny`
// (the manual editor): keep whatever came back as long as SOMETHING did — the
// user pointed at it and judges the preview themselves.
async function zenFinishCutout(pngBase64, allowAny = false) {
  const img = await zenLoadImage(`data:image/png;base64,${pngBase64}`);
  const full = document.createElement("canvas");
  full.width = img.width;
  full.height = img.height;
  const fctx = full.getContext("2d");
  fctx.drawImage(img, 0, 0);
  const pixels = fctx.getImageData(0, 0, full.width, full.height);
  const stats = analyzeCutoutAlpha(pixels);
  if (!(allowAny ? !!stats.bbox : cutoutLooksUsable(stats))) return { cutoutThumb: null, cutoutHasPot: false };
  // Trim the empty margin so every plant sits on the shelf at the same
  // visual scale, whatever the framing of the photo was.
  const pad = Math.round(Math.max(stats.bbox.w, stats.bbox.h) * 0.04);
  const sx = Math.max(0, stats.bbox.x - pad);
  const sy = Math.max(0, stats.bbox.y - pad);
  const sw = Math.min(full.width - sx, stats.bbox.w + pad * 2);
  const sh = Math.min(full.height - sy, stats.bbox.h + pad * 2);
  const scale = Math.min(1, CUTOUT_STORE_MAX_DIM / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  out.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return {
    cutoutThumb: out.toDataURL("image/png"),
    cutoutHasPot: cutoutBottomFill(pixels, stats.bbox) >= CUTOUT_POT_MIN_BOTTOM_FILL,
  };
}

// Writes a cutout onto the plant. Re-reads first: the user may have watered
// or edited the plant while the server was working.
async function zenSaveCutout(plantId, fields) {
  const current = (await getAllPlants()).find((p) => p.id === plantId);
  if (!current) return false; // deleted meanwhile
  await updatePlant({ ...current, ...fields });
  return true;
}

// Automatic cut (the background queue): no prompt, the server's model guesses
// the subject. Returns "ok" | "unusable" | "no-photo"; throws on server or
// network errors so the caller can tell "feature off" from "try later".
async function makePlantCutout(plant) {
  const src = plantPhotoSource(plant);
  if (!src) return "no-photo";
  const key = cutoutSourceKey(src);
  const jpeg = await zenShrinkToJpeg(src, CUTOUT_SOURCE_MAX_DIM);
  const data = await apiFetch("/api/cutout", { imageBase64: jpeg.split(",")[1], mimeType: "image/jpeg" });
  if (!data || typeof data.png !== "string" || !data.png) throw new Error("The background remover sent back nothing.");
  const { cutoutThumb, cutoutHasPot } = await zenFinishCutout(data.png);
  const saved = await zenSaveCutout(plant.id, {
    cutoutThumb,
    cutoutFrom: key,
    cutoutHasPot,
    cutoutModel: data.model || null,
    cutoutManual: false,
  });
  if (!saved) return "no-photo";
  return cutoutThumb ? "ok" : "unusable";
}

// ---------- the cut-out editor: point at the plant (like a phone's "extract object") ----------
//
// The automatic models decide for themselves what the subject is, and on a
// fruiting plant they picked the fruit (user report, 2026-09-29). Here the
// user SAYS what the subject is — a box around plant + pot, plus taps on any
// part it missed (or, in "remove" mode, on background it wrongly kept) — and
// the server runs Segment Anything on exactly that. The result is previewed
// before it replaces anything.
const CUTTER_EDIT_MAX_DIM = 768; // sent to the server; SAM works at ~1024 internally
const CUTTER_DRAG_PX = 8; // movement below this is a tap, above it a box

function CutoutEditor({ plant, onClose, onSaved }) {
  const src = plantPhotoSource(plant);
  const [jpeg, setJpeg] = useState(null);
  const [size, setSize] = useState(null); // natural size of the sent image
  const [box, setBox] = useState(null); // [x1, y1, x2, y2] in image pixels
  const [points, setPoints] = useState([]); // [{x, y, label}]
  const [tapLabel, setTapLabel] = useState(1); // 1 = adds, 0 = removes
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { cutoutThumb, cutoutHasPot }
  const imgRef = useRef(null);
  const drag = useRef(null);
  useEscapeKey(onClose);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const small = await zenShrinkToJpeg(src, CUTTER_EDIT_MAX_DIM);
        const img = await zenLoadImage(small);
        if (!alive) return;
        setJpeg(small);
        setSize({ w: img.width, h: img.height });
      } catch (e) {
        if (alive) setError(e.message || "Couldn't open the photo.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [src]);

  // Screen position → image pixels (the photo is shown scaled to fit).
  function toImage(e) {
    const r = imgRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * size.w;
    const y = ((e.clientY - r.top) / r.height) * size.h;
    return { x: Math.max(0, Math.min(size.w, x)), y: Math.max(0, Math.min(size.h, y)) };
  }

  function onPointerDown(e) {
    if (!size || busy || result) return;
    e.preventDefault();
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: toImage(e), sx: e.clientX, sy: e.clientY, moved: false };
  }
  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < CUTTER_DRAG_PX) return;
    d.moved = true;
    const p = toImage(e);
    setBox([d.start.x, d.start.y, p.x, p.y]);
  }
  function onPointerUp(e) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setPoints((prev) => [...prev, { x: d.start.x, y: d.start.y, label: tapLabel }].slice(-10));
      return;
    }
    const p = toImage(e);
    const b = [Math.min(d.start.x, p.x), Math.min(d.start.y, p.y), Math.max(d.start.x, p.x), Math.max(d.start.y, p.y)];
    // A sliver isn't a box anyone meant to draw.
    setBox(b[2] - b[0] > 12 && b[3] - b[1] > 12 ? b : null);
  }

  const marks = [
    ...(box ? [{ type: "rectangle", data: box.map((v) => Math.round(v)) }] : []),
    ...points.map((p) => ({ type: "point", data: [Math.round(p.x), Math.round(p.y)], label: p.label })),
  ];
  // SAM needs something that says "this" — a box or at least one adding tap.
  const canCut = !!box || points.some((p) => p.label === 1);

  async function cut() {
    if (!canCut || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch("/api/cutout", { imageBase64: jpeg.split(",")[1], mimeType: "image/jpeg", prompt: marks });
      if (!data || !data.png) throw new Error("The cutter sent back nothing.");
      const r = await zenFinishCutout(data.png, true);
      if (!r.cutoutThumb) throw new Error("Nothing was cut out — try a box around the whole plant.");
      setResult(r);
    } catch (e) {
      setError(e.message || "Couldn't cut it out.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    await zenSaveCutout(plant.id, {
      cutoutThumb: result.cutoutThumb,
      cutoutHasPot: result.cutoutHasPot,
      cutoutFrom: cutoutSourceKey(src),
      cutoutModel: "sam",
      cutoutManual: true, // never replaced by the automatic queue for this photo
      cutoutOff: false,
    });
    onSaved();
  }

  const pct = (v, total) => `${(v / total) * 100}%`;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide cutter" role="dialog" aria-modal="true" aria-labelledby="cutter-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="cutter-title"><i className="bi bi-scissors" aria-hidden="true"></i> Cut out {plant.name || "the plant"}</h2>
        {!result ? (
          <React.Fragment>
            <p className="cutter-hint">
              Drag a box around the whole plant <strong>and its pot</strong>, then tap any part it should keep.
              Switch to <em>Tap removes</em> to drop bits of background.
            </p>
            <div
              className="cutter-stage"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (drag.current = null)}
            >
              {jpeg ? (
                <img ref={imgRef} src={jpeg} alt={`Photo of ${plant.name || "the plant"}`} draggable={false} />
              ) : (
                <p className="empty-hint">{error ? "" : "Loading the photo…"}</p>
              )}
              {size && box && (
                <span
                  className="cutter-box"
                  style={{
                    left: pct(box[0], size.w),
                    top: pct(box[1], size.h),
                    width: pct(Math.abs(box[2] - box[0]), size.w),
                    height: pct(Math.abs(box[3] - box[1]), size.h),
                  }}
                ></span>
              )}
              {size &&
                points.map((p, i) => (
                  <span
                    key={i}
                    className={p.label ? "cutter-dot add" : "cutter-dot remove"}
                    style={{ left: pct(p.x, size.w), top: pct(p.y, size.h) }}
                  ></span>
                ))}
              {busy && (
                <div className="cutter-busy" role="status">
                  <i className="bi bi-hourglass-split" aria-hidden="true"></i> Cutting it out… the first time can take a minute
                </div>
              )}
            </div>
            <div className="segmented cutter-modes" role="group" aria-label="What a tap does">
              {[
                { v: 1, label: "Tap adds", icon: "bi-plus-circle" },
                { v: 0, label: "Tap removes", icon: "bi-dash-circle" },
              ].map((o) => (
                <button
                  type="button"
                  key={o.v}
                  className={tapLabel === o.v ? "segmented-option active" : "segmented-option"}
                  aria-pressed={tapLabel === o.v}
                  onClick={() => setTapLabel(o.v)}
                >
                  <i className={`bi ${o.icon}`} aria-hidden="true"></i> {o.label}
                </button>
              ))}
            </div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="btn" disabled={!canCut || busy || !jpeg} onClick={cut}>
                <i className="bi bi-scissors" aria-hidden="true"></i> Cut out
              </button>
              <button className="btn btn-ghost" disabled={busy || (!box && !points.length)} onClick={() => { setBox(null); setPoints([]); }}>
                Clear
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            </div>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div className="cutter-result">
              <img src={result.cutoutThumb} alt={`Cut-out of ${plant.name || "the plant"}`} />
            </div>
            <p className="cutter-hint">
              {result.cutoutHasPot ? "Pot included — it will stand on the shelf as it is." : "No pot detected — it will sit in a drawn pot on the shelf."}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={save}><i className="bi bi-check2" aria-hidden="true"></i> Use this</button>
              <button className="btn btn-ghost" onClick={() => setResult(null)}>Adjust</button>
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            </div>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

// Session memory for the queue: once the server says the feature is off, stop
// asking until the app is reopened.
let zenCutoutsDisabled = false;

function zenIsDisabledError(e) {
  return /not set up|cutout_disabled|REMBG_URL/i.test((e && e.message) || "");
}

function zenGroupByLocation(plants) {
  const groups = new Map();
  for (const p of plants) {
    const raw = (p.location || "").trim();
    const key = raw.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: raw || "No location set", plants: [] });
    groups.get(key).plants.push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([, g]) => ({ ...g, plants: g.plants.sort((x, y) => (x.name || "").localeCompare(y.name || "")) }));
}

// A few pot glazes, picked per plant id so a shelf isn't a row of clones.
const ZEN_POT_GLAZES = ["terracotta", "sage", "cream", "slate", "clay"];

function ZenPot({ glaze }) {
  return (
    <svg className={`zen-pot ${glaze}`} viewBox="0 0 64 40" aria-hidden="true">
      <rect className="zen-pot-rim" x="4" y="0" width="56" height="9" rx="2" />
      <path className="zen-pot-body" d="M9 9 H55 L49 38 Q48.5 40 46.5 40 H17.5 Q15.5 40 15 38 Z" />
      <path className="zen-pot-shine" d="M14 12 L17 34" />
    </svg>
  );
}

function ZenPlant({ plant, thirsty, feedDue, justWatered, onOpen, onWater }) {
  const photo = plantPhotoSource(plant);
  const glaze = ZEN_POT_GLAZES[Math.abs(Number(plant.id) || 0) % ZEN_POT_GLAZES.length];
  const name = plant.name || `Plant #${plant.id}`;
  // Only a cutout that KEPT its real pot stands on the shelf by itself; a bare
  // plant (or a cutout made before this check existed) goes in a drawn pot.
  const cutout = plant.cutoutOff ? null : plant.cutoutThumb; // the user can prefer the photo
  const standsAlone = !!cutout && plant.cutoutHasPot === true;
  const cls = ["zen-plant"];
  if (thirsty) cls.push("thirsty");
  if (justWatered) cls.push("watered");
  return (
    <div className={cls.join(" ")}>
      <button
        type="button"
        className="zen-plant-main"
        onClick={() => onOpen(plant)}
        aria-label={`${name}${thirsty ? ", needs water" : ""}${feedDue ? ", feeding due" : ""}`}
      >
        {/* A cutout that kept its real pot stands on the shelf on its own
            (plus a shadow); everything else sits in a drawn pot. */}
        <span className={standsAlone ? "zen-foliage cut" : cutout ? "zen-foliage cutpot" : "zen-foliage"}>
          {cutout ? (
            <img className="zen-cutout" src={cutout} alt="" />
          ) : photo ? (
            <img className="zen-photo" src={photo} alt="" />
          ) : (
            <i className="bi bi-flower3 zen-glyph" aria-hidden="true"></i>
          )}
        </span>
        {standsAlone ? <span className="zen-shadow" aria-hidden="true"></span> : <ZenPot glaze={glaze} />}
      </button>
      {thirsty && (
        <button type="button" className="zen-drop" onClick={() => onWater(plant)} title={`Water ${name}`} aria-label={`Mark ${name} watered`}>
          <i className="bi bi-droplet-fill" aria-hidden="true"></i>
        </button>
      )}
      {feedDue && (
        <span className="zen-feed" title="Feeding due">
          <i className="bi bi-flower2" aria-hidden="true"></i>
        </span>
      )}
      {justWatered && (
        <span className="zen-splash" aria-hidden="true">
          <i className="bi bi-droplet-fill"></i>
          <i className="bi bi-droplet-fill"></i>
          <i className="bi bi-droplet-fill"></i>
        </span>
      )}
      <span className="zen-name">{name}</span>
    </div>
  );
}

// `plants` is whatever the Garden tab is showing (tag filter already applied).
function ZenGardenView({ plants, onOpen, onChanged }) {
  const [routines, setRoutines] = useState([]);
  const [wateredId, setWateredId] = useState(null);
  const [cutStatus, setCutStatus] = useState(zenCutoutsDisabled ? "off" : ""); // "" | "working" | "off" | "error"
  const [cutLeft, setCutLeft] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    getAllRoutines()
      .then((r) => alive && setRoutines(r))
      .catch((e) => console.error("garden view: routines failed:", e && e.message));
    return () => {
      alive = false;
    };
  }, []);

  // Background cutout queue: one plant at a time, only for photos not yet cut.
  // Each round re-reads the database (not a snapshot), so it survives the
  // re-render every finished cutout causes, and picks up photos added while
  // it runs. It stops when the view closes, when nothing is left, or on the
  // first error (a "feature off" error also stops it for the session).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function runCutoutQueue() {
    if (zenCutoutsDisabled || busyRef.current) return;
    busyRef.current = true;
    try {
      await zenLoadServerCutoutModel();
      while (aliveRef.current) {
        const pending = (await getAllPlants()).filter((p) => !cutoutUpToDate(p));
        if (!pending.length) break;
        setCutStatus("working");
        setCutLeft(pending.length);
        await makePlantCutout(pending[0]);
        onChanged(); // show each finished cutout as it lands
      }
      if (aliveRef.current) setCutStatus("");
    } catch (e) {
      if (zenIsDisabledError(e)) {
        zenCutoutsDisabled = true;
        setCutStatus("off");
      } else {
        console.error("garden view: cutout failed:", e && e.message);
        setCutStatus("error"); // transient (network/server) — retried next time the view opens
      }
    } finally {
      busyRef.current = false;
    }
  }

  const photosKey = plants
    .map((p) => `${p.id}:${p.cutoutFrom || ""}:${p.cutoutModel || ""}:${p.cutoutOff ? 1 : 0}:${(plantPhotoSource(p) || "").length}`)
    .join(",");
  useEffect(() => {
    let alive = true;
    // The model check needs /health first; then anything cut with another
    // model (or never cut) goes into the queue.
    zenLoadServerCutoutModel().then(() => {
      if (alive && plants.some((p) => !cutoutUpToDate(p))) runCutoutQueue();
    });
    return () => {
      alive = false;
    };
  }, [photosKey]);

  async function water(plant) {
    await updatePlant(withCareLogEntry({ ...plant, lastWatered: Date.now() }, "Watered", "water"));
    setWateredId(plant.id);
    setTimeout(() => setWateredId((id) => (id === plant.id ? null : id)), 1400);
    onChanged();
  }

  const intervalFor = (p) =>
    typeof todayWateringInterval === "function" ? todayWateringInterval(p, routines) : 7;
  const isThirsty = (p) => {
    const days = daysSince(p.lastWatered);
    return days === null || days >= intervalFor(p);
  };
  const feedDueFor = (p) =>
    routines.some((r) => r.plantId === p.id && r.careAction === "fertilize" && isRoutineDue(r));

  const groups = zenGroupByLocation(plants);
  const thirstyCount = plants.filter(isThirsty).length;

  return (
    <div className="zen-garden">
      <p className="zen-summary" role="status">
        {plants.length === 0
          ? "No plants to show."
          : thirstyCount
            ? `${thirstyCount} thirsty — tap the drop when you've watered.`
            : "Everyone's watered."}
      </p>
      {groups.map((g) => (
        <section key={g.label} className="zen-shelf" aria-label={g.label}>
          <h3 className="zen-shelf-title">
            <i className="bi bi-geo-alt" aria-hidden="true"></i> {g.label}
            <span className="zen-shelf-count">{g.plants.length}</span>
          </h3>
          <div className="zen-row">
            {g.plants.map((p) => (
              <ZenPlant
                key={p.id}
                plant={p}
                thirsty={isThirsty(p)}
                feedDue={feedDueFor(p)}
                justWatered={wateredId === p.id}
                onOpen={onOpen}
                onWater={water}
              />
            ))}
          </div>
          <div className="zen-plank" aria-hidden="true"></div>
        </section>
      ))}
      {cutStatus === "working" && (
        <p className="zen-note"><i className="bi bi-scissors" aria-hidden="true"></i> Cutting plants out of their photos… {cutLeft} left</p>
      )}
      {plants.some((p) => plantPhotoSource(p)) && cutStatus !== "off" && (
        <p className="zen-note">
          <i className="bi bi-scissors" aria-hidden="true"></i> A cutout came out wrong? Open the plant › ⋯ › Cut out plant… and point at it.
        </p>
      )}
      {cutStatus === "off" && (
        <p className="zen-note">Photo cutouts aren't set up on the server, so photos are shown in frames.</p>
      )}
      {cutStatus === "error" && (
        <p className="zen-note">Couldn't reach the background remover — photos are shown in frames for now.</p>
      )}
    </div>
  );
}
