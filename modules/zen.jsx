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

// True when a cut for the CURRENT photo was already attempted (successful or
// not) — the queue skips those.
function cutoutUpToDate(plant) {
  const src = plantPhotoSource(plant);
  return !src || plant.cutoutFrom === cutoutSourceKey(src);
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
async function makePlantCutout(plant) {
  const src = plantPhotoSource(plant);
  if (!src) return "no-photo";
  const key = cutoutSourceKey(src);
  const jpeg = await zenShrinkToJpeg(src, CUTOUT_SOURCE_MAX_DIM);
  const data = await apiFetch("/api/cutout", { imageBase64: jpeg.split(",")[1], mimeType: "image/jpeg" });
  if (!data || typeof data.png !== "string" || !data.png) throw new Error("The background remover sent back nothing.");

  const img = await zenLoadImage(`data:image/png;base64,${data.png}`);
  const full = document.createElement("canvas");
  full.width = img.width;
  full.height = img.height;
  const fctx = full.getContext("2d");
  fctx.drawImage(img, 0, 0);
  const stats = analyzeCutoutAlpha(fctx.getImageData(0, 0, full.width, full.height));

  let cutoutThumb = null;
  if (cutoutLooksUsable(stats)) {
    // Trim the empty margin (plus a little air) so every plant sits on its
    // pot at the same visual scale, whatever the framing of the photo was.
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
    cutoutThumb = out.toDataURL("image/png");
  }

  // Re-read before writing: the user may have watered or edited the plant
  // while the server was working, and that change must not be overwritten.
  const current = (await getAllPlants()).find((p) => p.id === plant.id);
  if (!current) return "no-photo"; // deleted meanwhile
  await updatePlant({ ...current, cutoutThumb, cutoutFrom: key });
  return cutoutThumb ? "ok" : "unusable";
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
        {/* A cutout keeps the plant's REAL pot, so it stands on the shelf on
            its own (plus a shadow); a framed photo or the placeholder glyph
            gets a drawn pot instead. */}
        <span className={plant.cutoutThumb ? "zen-foliage cut" : "zen-foliage"}>
          {plant.cutoutThumb ? (
            <img className="zen-cutout" src={plant.cutoutThumb} alt="" />
          ) : photo ? (
            <img className="zen-photo" src={photo} alt="" />
          ) : (
            <i className="bi bi-flower3 zen-glyph" aria-hidden="true"></i>
          )}
        </span>
        {plant.cutoutThumb ? <span className="zen-shadow" aria-hidden="true"></span> : <ZenPot glaze={glaze} />}
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

  const photosKey = plants.map((p) => `${p.id}:${p.cutoutFrom || ""}:${(plantPhotoSource(p) || "").length}`).join(",");
  useEffect(() => {
    if (plants.some((p) => !cutoutUpToDate(p))) runCutoutQueue();
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
      {cutStatus === "off" && (
        <p className="zen-note">Photo cutouts aren't set up on the server, so photos are shown in frames.</p>
      )}
      {cutStatus === "error" && (
        <p className="zen-note">Couldn't reach the background remover — photos are shown in frames for now.</p>
      )}
    </div>
  );
}
