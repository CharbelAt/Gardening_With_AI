// Weather module: a free, key-less local forecast (Open-Meteo) that feeds both
// the UI and the AI's context, so Sprout can say "skip watering, 12mm of rain
// tomorrow" instead of generic seasonal advice.
//
// Called with plain fetch, NOT apiFetch: apiFetch is the VPS proxy for the AI
// providers and needs the client secret, while Open-Meteo is CORS-enabled,
// free and unauthenticated — routing weather through the proxy would make it
// fail for every user who hasn't set a backend up yet.
//
// Nothing here may throw into a caller: chat builds its context on every
// request and the dashboard renders on every open, so a denied permission, a
// dead network or a malformed payload degrades to null / "" / an inline
// message instead of breaking the app.
//
// Like every other module this is a classic script sharing the page's global
// scope — no import/export (see idb.js's note).

const LS_WEATHER_ENABLED = "gc_weatherEnabled"; // "1" | ""
const LS_WEATHER_LAT = "gc_weatherLat";
const LS_WEATHER_LON = "gc_weatherLon";
const LS_WEATHER_PLACE = "gc_weatherPlace"; // display name, e.g. "Beirut, Lebanon"
const LS_WEATHER_CACHE = "gc_weatherCache";

const WEATHER_API = "https://api.open-meteo.com/v1/forecast";
const WEATHER_GEOCODE_API = "https://geocoding-api.open-meteo.com/v1/search";

const WEATHER_CACHE_MS = 60 * 60 * 1000; // upstream only recomputes hourly — asking more often is pure waste
const WEATHER_TIMEOUT_MS = 8000; // a hung request must not leave the strip spinning forever
const WEATHER_FORECAST_DAYS = 7;

// Thresholds that turn a forecast into advice the AI can act on. Deliberately
// conservative: a false "frost tonight" costs the user one wasted fleece, a
// missed one costs them the plant.
const WEATHER_HEAVY_RAIN_MM = 5; // more than this and watering can wait
const WEATHER_FROST_C = 2; // ground frost happens above 0°C air temperature
const WEATHER_HEAT_C = 35;
const WEATHER_WIND_KMH = 35; // spray drift / staking territory

// ---------- WMO weather codes ----------

// The API returns a bare WMO code; this is the standard range mapping, paired
// with the Bootstrap Icons the rest of the app uses.
const WEATHER_CODES = {
  0: { label: "clear", icon: "bi-sun" },
  1: { label: "mainly clear", icon: "bi-sun" },
  2: { label: "partly cloudy", icon: "bi-cloud-sun" },
  3: { label: "overcast", icon: "bi-clouds" },
  45: { label: "fog", icon: "bi-cloud-fog" },
  48: { label: "freezing fog", icon: "bi-cloud-fog" },
  51: { label: "light drizzle", icon: "bi-cloud-drizzle" },
  53: { label: "drizzle", icon: "bi-cloud-drizzle" },
  55: { label: "heavy drizzle", icon: "bi-cloud-drizzle" },
  56: { label: "freezing drizzle", icon: "bi-cloud-sleet" },
  57: { label: "freezing drizzle", icon: "bi-cloud-sleet" },
  61: { label: "light rain", icon: "bi-cloud-rain" },
  63: { label: "rain", icon: "bi-cloud-rain" },
  65: { label: "heavy rain", icon: "bi-cloud-rain-heavy" },
  66: { label: "freezing rain", icon: "bi-cloud-sleet" },
  67: { label: "freezing rain", icon: "bi-cloud-sleet" },
  71: { label: "light snow", icon: "bi-snow" },
  73: { label: "snow", icon: "bi-snow" },
  75: { label: "heavy snow", icon: "bi-snow" },
  77: { label: "snow grains", icon: "bi-snow" },
  80: { label: "rain showers", icon: "bi-cloud-rain" },
  81: { label: "rain showers", icon: "bi-cloud-rain-heavy" },
  82: { label: "violent rain showers", icon: "bi-cloud-rain-heavy" },
  85: { label: "snow showers", icon: "bi-snow" },
  86: { label: "heavy snow showers", icon: "bi-snow" },
  95: { label: "thunderstorm", icon: "bi-cloud-lightning" },
  96: { label: "thunderstorm with hail", icon: "bi-cloud-lightning-rain" },
  99: { label: "thunderstorm with hail", icon: "bi-cloud-lightning-rain" },
};

function describeWeatherCode(code) {
  const hit = WEATHER_CODES[Number(code)];
  // Unknown/absent code still gets a usable icon rather than an empty box.
  return hit || { label: "unknown", icon: "bi-cloud" };
}

// ---------- settings ----------

// Rejects blanks and out-of-range values: localStorage.getItem returns null for
// an unset key and Number(null) is 0, which would silently place the user in
// the Gulf of Guinea instead of showing the setup prompt.
function readWeatherCoord(key, max) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

// `enabled` means "switched on AND usable" — a stored flag with no coordinates
// can't fetch anything, and every caller would otherwise have to re-check that.
function getWeatherSettings() {
  const lat = readWeatherCoord(LS_WEATHER_LAT, 90);
  const lon = readWeatherCoord(LS_WEATHER_LON, 180);
  return {
    enabled: localStorage.getItem(LS_WEATHER_ENABLED) === "1" && lat !== null && lon !== null,
    lat,
    lon,
    place: localStorage.getItem(LS_WEATHER_PLACE) || "",
  };
}

// Merges over the current settings, so `setWeatherSettings({ enabled: false })`
// switches weather off without losing the location the user picked.
function setWeatherSettings(next) {
  const merged = { ...getWeatherSettings(), ...(next || {}) };
  const lat = merged.lat === null || merged.lat === "" ? null : Number(merged.lat);
  const lon = merged.lon === null || merged.lon === "" ? null : Number(merged.lon);
  const validLat = lat !== null && isFinite(lat) && Math.abs(lat) <= 90 ? lat : null;
  const validLon = lon !== null && isFinite(lon) && Math.abs(lon) <= 180 ? lon : null;

  const before = getWeatherSettings();
  localStorage.setItem(LS_WEATHER_ENABLED, merged.enabled ? "1" : "");
  if (validLat === null) localStorage.removeItem(LS_WEATHER_LAT);
  else localStorage.setItem(LS_WEATHER_LAT, String(validLat));
  if (validLon === null) localStorage.removeItem(LS_WEATHER_LON);
  else localStorage.setItem(LS_WEATHER_LON, String(validLon));
  localStorage.setItem(LS_WEATHER_PLACE, merged.place || "");

  // A cached forecast belongs to the coordinates it was fetched for; keeping it
  // after a move would show yesterday's other city as today's weather.
  if (before.lat !== validLat || before.lon !== validLon) localStorage.removeItem(LS_WEATHER_CACHE);
  return getWeatherSettings();
}

// ---------- fetching + caching ----------

// Shared by the forecast and the geocoder. Throws on timeout/HTTP error so the
// two callers can decide what to show; neither lets it escape further.
async function weatherFetchJson(url) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Open-Meteo pads its arrays with nulls when a value is missing; every reader
// below therefore has to cope with null, so normalize to it here.
function weatherNum(arr, i) {
  if (!Array.isArray(arr)) return null;
  const v = arr[i];
  return typeof v === "number" && isFinite(v) ? v : null;
}

// Flattens the API's parallel-arrays shape into the row-per-day form the UI and
// the context builder both want, and refuses anything that isn't a forecast
// (an HTML error page parsed as JSON, a rate-limit body, …).
function normalizeWeatherResponse(raw, settings) {
  if (!raw || typeof raw !== "object" || !raw.current || !raw.daily) {
    throw new Error("Malformed weather response");
  }
  const d = raw.daily;
  const times = Array.isArray(d.time) ? d.time : [];
  const days = times.map((date, i) => ({
    date,
    code: weatherNum(d.weather_code, i),
    tempMax: weatherNum(d.temperature_2m_max, i),
    tempMin: weatherNum(d.temperature_2m_min, i),
    rainMm: weatherNum(d.precipitation_sum, i),
    rainChance: weatherNum(d.precipitation_probability_max, i),
    windMax: weatherNum(d.wind_speed_10m_max, i),
  }));
  if (!days.length) throw new Error("Malformed weather response");
  const cu = raw.current_units || {};
  const du = raw.daily_units || {};
  return {
    fetchedAt: Date.now(),
    lat: settings.lat,
    lon: settings.lon,
    place: settings.place || "",
    current: {
      temp: typeof raw.current.temperature_2m === "number" ? raw.current.temperature_2m : null,
      humidity: typeof raw.current.relative_humidity_2m === "number" ? raw.current.relative_humidity_2m : null,
      rainNow: typeof raw.current.precipitation === "number" ? raw.current.precipitation : null,
      code: typeof raw.current.weather_code === "number" ? raw.current.weather_code : null,
    },
    days,
    units: {
      temp: cu.temperature_2m || "°C",
      rain: du.precipitation_sum || "mm",
      wind: du.wind_speed_10m_max || "km/h",
    },
  };
}

// Age is checked by getWeather, not here: a stale cache is still the best thing
// to show when the network is down (this is an offline-first PWA).
function readWeatherCache(settings) {
  try {
    const raw = localStorage.getItem(LS_WEATHER_CACHE);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !cached.fetchedAt || !Array.isArray(cached.days) || !cached.days.length) return null;
    // ~1km tolerance: a re-read of geolocation drifts a few metres and that
    // must not throw away a perfectly good forecast.
    if (Math.abs((cached.lat || 0) - settings.lat) > 0.01) return null;
    if (Math.abs((cached.lon || 0) - settings.lon) > 0.01) return null;
    return cached;
  } catch (_) {
    return null; // corrupt entry — treat as no cache
  }
}

async function requestWeatherForecast(settings) {
  try {
    const url =
      `${WEATHER_API}?latitude=${encodeURIComponent(settings.lat)}` +
      `&longitude=${encodeURIComponent(settings.lon)}` +
      "&current=temperature_2m,relative_humidity_2m,precipitation,weather_code" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum," +
      "precipitation_probability_max,wind_speed_10m_max" +
      `&timezone=auto&forecast_days=${WEATHER_FORECAST_DAYS}`;
    const data = normalizeWeatherResponse(await weatherFetchJson(url), settings);
    try {
      localStorage.setItem(LS_WEATHER_CACHE, JSON.stringify(data));
    } catch (_) {
      // Quota full / private mode: the forecast still works for this session.
    }
    return data;
  } catch (e) {
    console.error("weather fetch failed:", e && e.message);
    return null;
  }
}

// One in-flight request at a time: the Today dashboard renders the strip while
// chat is building its context, and both call this within the same tick.
let weatherFetchInFlight = null;

// The single entry point for forecast data. Returns null (never throws) when
// weather is off, unavailable and uncached. `force` skips the freshness check.
async function getWeather(force) {
  let settings;
  try {
    settings = getWeatherSettings();
  } catch (_) {
    return null; // localStorage unavailable (private mode) — weather is optional
  }
  if (!settings.enabled) return null;

  const cached = readWeatherCache(settings);
  if (!force && cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_MS) return cached;

  if (!weatherFetchInFlight) {
    weatherFetchInFlight = requestWeatherForecast(settings).finally(() => {
      weatherFetchInFlight = null;
    });
  }
  const fresh = await weatherFetchInFlight;
  // Offline or upstream down: an old forecast still beats nothing, flagged so
  // the UI can say where it came from.
  if (!fresh) return cached ? { ...cached, stale: true } : null;
  return fresh;
}

// ---------- derived guidance ----------

// 0 = today, so "in 2 days" reads the way a person would say it.
function weatherDayLabel(index) {
  if (index <= 0) return "today";
  if (index === 1) return "tomorrow";
  return `in ${index} days`;
}

function weatherShortDay(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00`);
  if (isNaN(t)) return dateStr || "";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
}

// The flags the AI (and the strip's warning chip) act on, taken from today plus
// the next three days — far enough ahead to change a watering decision, close
// enough that the forecast is still worth trusting.
function weatherAlerts(w) {
  const scan = (w && Array.isArray(w.days) ? w.days : []).slice(0, 4);
  const first = (test) => {
    for (let i = 0; i < scan.length; i++) {
      if (test(scan[i])) return i;
    }
    return -1;
  };
  const at = (i, value) => (i < 0 ? null : { dayIndex: i, when: weatherDayLabel(i), value });

  const rainIdx = first((d) => d.rainMm !== null && d.rainMm > WEATHER_HEAVY_RAIN_MM);
  const frostIdx = first((d) => d.tempMin !== null && d.tempMin <= WEATHER_FROST_C);
  const heatIdx = first((d) => d.tempMax !== null && d.tempMax >= WEATHER_HEAT_C);
  const windIdx = first((d) => d.windMax !== null && d.windMax >= WEATHER_WIND_KMH);

  // Total rain over the window answers the other half of "should I water?" —
  // three bone-dry days matter as much as one wet one. `dry` needs at least one
  // real number behind it: absent data must not become "it won't rain".
  const rainKnown = scan.some((d) => d.rainMm !== null);
  const rainTotal = scan.reduce((sum, d) => sum + (d.rainMm || 0), 0);

  return {
    heavyRain: at(rainIdx, rainIdx < 0 ? null : scan[rainIdx].rainMm),
    frost: at(frostIdx, frostIdx < 0 ? null : scan[frostIdx].tempMin),
    heat: at(heatIdx, heatIdx < 0 ? null : scan[heatIdx].tempMax),
    wind: at(windIdx, windIdx < 0 ? null : scan[windIdx].windMax),
    rainTotal,
    dry: rainKnown && rainTotal < 1,
  };
}

// timeAgo() (helpers.jsx) only resolves to whole days, but the whole point of
// a "saved copy" note is that the reading is hours old.
function weatherAgeLabel(ts) {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return timeAgo(ts);
}

function formatWeatherTemp(v, units) {
  return v === null || v === undefined ? "?" : `${Math.round(v)}${(units && units.temp) || "°C"}`;
}

// "33/24°C" — the unit is written once per pair, because this line ships to the
// model on every request and the second "°C" buys nothing.
function formatWeatherRange(max, min, units) {
  const f = (v) => (v === null || v === undefined ? "?" : String(Math.round(v)));
  return `${f(max)}/${f(min)}${(units && units.temp) || "°C"}`;
}

function formatWeatherRain(v, units) {
  if (v === null || v === undefined) return "?";
  const unit = (units && units.rain) || "mm";
  // Sub-millimetre drizzle rounds to "0mm", which reads as "dry" — keep one
  // decimal only where it changes the meaning.
  return `${v > 0 && v < 1 ? v.toFixed(1) : Math.round(v)}${unit}`;
}

// The block injected into the AI's system prompt (via weatherContextProvider in
// helpers.jsx). Kept SHORT on purpose — it ships with every single request, so
// every line here is paid for over and over.
async function buildWeatherContext() {
  try {
    const w = await getWeather(false);
    if (!w || !w.days || !w.days.length) return "";
    const units = w.units || {};
    const today = w.days[0];
    const cond = describeWeatherCode(w.current ? w.current.code : null);
    const alerts = weatherAlerts(w);
    const lines = [];

    const place = w.place ? ` (${w.place})` : "";
    lines.push(`=== LOCAL WEATHER${place} ===`);
    if (w.stale) lines.push(`(cached reading from ${weatherAgeLabel(w.fetchedAt)} — network unavailable)`);

    const nowBits = [];
    if (w.current && w.current.temp !== null) nowBits.push(formatWeatherTemp(w.current.temp, units));
    if (w.current && w.current.humidity !== null) nowBits.push(`${Math.round(w.current.humidity)}% humidity`);
    nowBits.push(cond.label);
    lines.push(`Now: ${nowBits.join(", ")}.`);

    lines.push(
      `Today: ${formatWeatherRange(today.tempMax, today.tempMin, units)}, ` +
        `${formatWeatherRain(today.rainMm, units)} rain` +
        (today.rainChance === null ? "" : ` (${Math.round(today.rainChance)}% chance)`) +
        (today.windMax === null ? "" : `, wind ${Math.round(today.windMax)}${units.wind || "km/h"}`) +
        "."
    );

    const ahead = w.days.slice(1, 4);
    if (ahead.length) {
      lines.push(
        "Next 3 days: " +
          ahead
            .map(
              (d) =>
                `${weatherShortDay(d.date)} ${formatWeatherRange(d.tempMax, d.tempMin, units)} ` +
                `${formatWeatherRain(d.rainMm, units)}` +
                (d.rainChance === null ? "" : ` (${Math.round(d.rainChance)}%)`) +
                ` ${describeWeatherCode(d.code).label}`
            )
            .join("; ") +
          "."
      );
    }

    // Compact machine-readable flags: a model skims these far more reliably
    // than it re-derives them from the numbers above.
    const flags = [];
    if (alerts.heavyRain) flags.push(`heavy-rain(${formatWeatherRain(alerts.heavyRain.value, units)} ${alerts.heavyRain.when})`);
    if (alerts.frost) flags.push(`frost-risk(${formatWeatherTemp(alerts.frost.value, units)} ${alerts.frost.when})`);
    if (alerts.heat) flags.push(`heat-stress(${formatWeatherTemp(alerts.heat.value, units)} ${alerts.heat.when})`);
    if (alerts.wind) flags.push(`high-wind(${Math.round(alerts.wind.value)}${units.wind || "km/h"} ${alerts.wind.when})`);
    if (flags.length) lines.push(`Flags: ${flags.join(", ")}.`);

    const guidance = [];
    if (alerts.heavyRain) {
      guidance.push(
        `significant rain expected ${alerts.heavyRain.when} (${formatWeatherRain(alerts.heavyRain.value, units)}) — hold off on deep watering until after it`
      );
    } else if (alerts.dry) {
      guidance.push("no meaningful rain in the next 3 days — keep to the normal watering schedule and check pots daily");
    }
    if (alerts.heat) {
      guidance.push(`heat stress ${alerts.heat.when} — water early morning or after sunset, mulch, shade seedlings`);
    }
    if (alerts.frost) {
      guidance.push(`frost risk ${alerts.frost.when} — cover tender plants and don't water in the evening`);
    }
    if (alerts.wind) {
      guidance.push(`strong wind ${alerts.wind.when} — skip foliar spraying and stake tall plants`);
    }
    if (guidance.length) lines.push(`Watering guidance: ${guidance.join("; ")}.`);

    lines.push("=== END LOCAL WEATHER ===");
    return `\n\n${lines.join("\n")}`;
  } catch (e) {
    console.error("buildWeatherContext failed:", e && e.message);
    return "";
  }
}

// Inverted dependency: helpers.jsx loads FIRST and so cannot call into this
// file, but it can hold a slot that this file fills. buildContextMessages()
// only reads the slot at request time, long after every script has run.
try {
  // `typeof` does NOT protect against a let's temporal dead zone, so the
  // try/catch is what keeps a misordered <script> tag from killing the page.
  if (typeof weatherContextProvider !== "undefined") weatherContextProvider = buildWeatherContext;
} catch (_) {
  console.error("weather context not registered — helpers.jsx must load before weather.jsx");
}

// ---------- UI ----------

function weatherPlaceLabel(result) {
  if (!result) return "";
  return [result.name, result.admin1, result.country].filter(Boolean).join(", ");
}

// Location setup: geolocation for one tap, place search for everyone who says
// no to that, and raw coordinates as the always-works fallback. Self-contained
// (this module owns the whole feature) so it can be opened from the strip, the
// Today dashboard, or Settings.
function WeatherSetupModal({ onClose, onSaved }) {
  const current = getWeatherSettings();
  const [query, setQuery] = useState(current.place || "");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");
  const [lat, setLat] = useState(current.lat === null ? "" : String(current.lat));
  const [lon, setLon] = useState(current.lon === null ? "" : String(current.lon));

  function finish(next) {
    const saved = setWeatherSettings(next);
    // Warm the cache for the strip that is about to re-render. Deliberately not
    // awaited, and failures are surfaced there rather than blocking this modal.
    getWeather(true).catch(() => {});
    if (onSaved) onSaved(saved);
    else onClose();
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setError("This device can't share its location — search for a place instead.");
      return;
    }
    setLocating(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const coords = (pos && pos.coords) || {};
        if (!isFinite(coords.latitude) || !isFinite(coords.longitude)) {
          setError("Your device returned an unusable position — search for a place instead.");
          return;
        }
        // Open-Meteo's geocoder is forward-only, so there's no name to show for
        // raw coordinates; the user can still search for one if they want.
        finish({ enabled: true, lat: coords.latitude, lon: coords.longitude, place: "My location" });
      },
      (err) => {
        setLocating(false);
        setError(
          err && err.code === 1
            ? "Location permission denied — search for a place, or enter coordinates below."
            : "Couldn't get your location — search for a place, or enter coordinates below."
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  }

  async function searchPlaces() {
    const term = query.trim();
    if (!term || searching) return;
    setSearching(true);
    setError("");
    setResults(null);
    try {
      const raw = await weatherFetchJson(
        `${WEATHER_GEOCODE_API}?name=${encodeURIComponent(term)}&count=5&language=en&format=json`
      );
      const list = Array.isArray(raw && raw.results) ? raw.results : [];
      setResults(list);
      if (!list.length) setError(`No place called "${term}" — try a larger town nearby, or enter coordinates.`);
    } catch (e) {
      setError("Place search failed — check your connection, or enter coordinates below.");
    } finally {
      setSearching(false);
    }
  }

  function saveManual() {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!lat.trim() || !lon.trim() || !isFinite(nLat) || !isFinite(nLon)) {
      setError("Enter both coordinates as numbers, e.g. 33.89 and 35.50.");
      return;
    }
    if (Math.abs(nLat) > 90 || Math.abs(nLon) > 180) {
      setError("Latitude must be between -90 and 90, longitude between -180 and 180.");
      return;
    }
    finish({ enabled: true, lat: nLat, lon: nLon, place: query.trim() || "Custom location" });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Local weather</h2>
        <p className="weather-setup-intro">
          Used for the forecast strip — and given to Sprout, so its watering and spraying advice
          follows your actual weather.
        </p>

        <button className="btn btn-block" onClick={locateMe} disabled={locating}>
          <i className="bi bi-crosshair"></i> {locating ? "Locating…" : "Use my location"}
        </button>

        <label>
          Or search for a place
          <div className="weather-search-row">
            <input
              value={query}
              placeholder="e.g. Beirut"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchPlaces()}
            />
            <button className="btn small" onClick={searchPlaces} disabled={!query.trim() || searching}>
              <i className={searching ? "bi bi-hourglass-split" : "bi bi-search"}></i>
            </button>
          </div>
        </label>

        {results && results.length > 0 && (
          <div className="weather-results">
            {results.map((r) => (
              <button
                key={`${r.id || r.name}-${r.latitude}-${r.longitude}`}
                className="weather-result"
                onClick={() =>
                  finish({ enabled: true, lat: r.latitude, lon: r.longitude, place: weatherPlaceLabel(r) })
                }
              >
                <i className="bi bi-geo-alt"></i>
                <span>{weatherPlaceLabel(r)}</span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <hr />

        <label>
          Latitude
          <input type="number" step="0.0001" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="33.8938" />
        </label>
        <label>
          Longitude
          <input type="number" step="0.0001" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="35.5018" />
        </label>

        <div className="modal-actions">
          <button className="btn" onClick={saveManual}>Save</button>
          {current.enabled && (
            <button className="btn btn-ghost" onClick={() => finish({ enabled: false })}>
              Turn off
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// The forecast card. `compact` is the Today-dashboard variant (one line, no
// location row). When weather is off this is a one-tap invitation instead —
// there is no other way in until the orchestrator wires a Settings entry.
function WeatherStrip({ compact }) {
  const [settings, setSettings] = useState(() => getWeatherSettings());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    if (!settings.enabled) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getWeather(false)
      .catch(() => null) // getWeather already swallows its own errors; belt and braces
      .then((w) => {
        if (cancelled) return;
        setData(w);
        setFailed(!w);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.enabled, settings.lat, settings.lon]);

  const setup = setupOpen && (
    <WeatherSetupModal
      onClose={() => setSetupOpen(false)}
      onSaved={(saved) => {
        setSettings(saved);
        setSetupOpen(false);
      }}
    />
  );

  if (!settings.enabled) {
    return (
      <React.Fragment>
        <button className={compact ? "weather-strip weather-prompt compact" : "weather-strip weather-prompt"} onClick={() => setSetupOpen(true)}>
          <i className="bi bi-cloud-sun weather-icon"></i>
          <span className="weather-prompt-text">
            <strong>Turn on local weather</strong>
            <em>Rain, frost and heat warnings — and Sprout's advice follows them.</em>
          </span>
          <i className="bi bi-chevron-right"></i>
        </button>
        {setup}
      </React.Fragment>
    );
  }

  if (loading && !data) {
    return (
      <div className={compact ? "weather-strip compact" : "weather-strip"}>
        <i className="bi bi-cloud weather-icon"></i>
        <div className="weather-main"><span className="weather-cond">Loading weather…</span></div>
      </div>
    );
  }

  if (failed || !data) {
    return (
      <React.Fragment>
        <div className={compact ? "weather-strip compact" : "weather-strip"}>
          <i className="bi bi-cloud-slash weather-icon"></i>
          <div className="weather-main">
            <span className="weather-cond">Weather unavailable offline</span>
          </div>
          <button className="icon-btn small" title="Weather location" onClick={() => setSetupOpen(true)}>
            <i className="bi bi-gear"></i>
          </button>
        </div>
        {setup}
      </React.Fragment>
    );
  }

  const units = data.units || {};
  const today = data.days[0];
  const cond = describeWeatherCode(data.current ? data.current.code : null);
  const alerts = weatherAlerts(data);
  const warning = alerts.heavyRain
    ? { icon: "bi-umbrella", text: `Rain ${alerts.heavyRain.when} (${formatWeatherRain(alerts.heavyRain.value, units)})` }
    : alerts.frost
    ? { icon: "bi-snow", text: `Frost ${alerts.frost.when}` }
    : alerts.heat
    ? { icon: "bi-thermometer-sun", text: `Heat ${alerts.heat.when}` }
    : alerts.wind
    ? { icon: "bi-wind", text: `Windy ${alerts.wind.when}` }
    : null;

  return (
    <React.Fragment>
      <div className={compact ? "weather-strip compact" : "weather-strip"}>
        <i className={`bi ${cond.icon} weather-icon`}></i>
        <div className="weather-main">
          <span className="weather-temp">
            {formatWeatherTemp(data.current ? data.current.temp : null, units)}
          </span>
          <span className="weather-cond">{cond.label}</span>
        </div>
        <div className="weather-meta">
          <span>
            <i className="bi bi-thermometer-half"></i> {formatWeatherTemp(today.tempMax, units)} /{" "}
            {formatWeatherTemp(today.tempMin, units)}
          </span>
          <span>
            <i className="bi bi-umbrella"></i>{" "}
            {today.rainChance === null ? formatWeatherRain(today.rainMm, units) : `${Math.round(today.rainChance)}%`}
          </span>
          {!compact && data.place && (
            <span className="weather-place">
              <i className="bi bi-geo-alt"></i> {data.place}
            </span>
          )}
        </div>
        {warning && (
          <span className="weather-warn">
            <i className={`bi ${warning.icon}`}></i> {warning.text}
          </span>
        )}
        {!compact && (
          <button className="icon-btn small" title="Weather location" onClick={() => setSetupOpen(true)}>
            <i className="bi bi-gear"></i>
          </button>
        )}
      </div>
      {data.stale && !compact && (
        <p className="weather-stale">
          Saved copy from {weatherAgeLabel(data.fetchedAt)} — couldn't reach the forecast.
        </p>
      )}
      {setup}
    </React.Fragment>
  );
}
