// Planner module: the garden CALENDAR (a third section of the Tasks tab) and
// the WATERING overview (opened from the Garden tab header).
//
// Neither owns any data. The calendar is a projection of what already exists —
// routine intervals, dated to-dos, the 7-day forecast — onto a month grid, so
// there is nothing new to keep in sync and nothing new in backups. The
// watering overview reads the plant history log the "Watered" buttons and
// watering routines already write. Amounts (litres) are not tracked anywhere
// in the app, so this counts waterings; it never invents volumes.
//
// Classic script sharing the page's global scope — no import/export. Loads
// after todos.jsx and before tasks.jsx (see index.html). References to other
// modules (getWeather, weatherAlerts, todayWateringInterval) happen at render
// time and are typeof-guarded, so load order can't break them.

const PLANNER_DAY_MS = 24 * 60 * 60 * 1000;
const PLANNER_WATER_WINDOW_DAYS = 30;
// A routine every day for a month is 31 dots — plenty. The cap only guards a
// corrupt intervalDays (0.0001) from spinning the loop.
const PLANNER_MAX_OCCURRENCES = 400;

// Local-calendar "YYYY-MM-DD" (never toISOString, which is UTC).
function plannerISO(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function plannerStartOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Day arithmetic through the Date constructor, not +N*24h: a DST change would
// otherwise shift every later occurrence by an hour and, near midnight, a day.
function plannerAddDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// Every date a routine falls due in [from, to] (both Date at local midnight).
// Mirrors isRoutineDue: never done → due today; past due → due TODAY (flagged
// overdue), and the rhythm restarts from there, because that is what happens
// when the user ticks it off today.
function plannerRoutineDates(routine, from, to, now = Date.now()) {
  const interval = Number(routine && routine.intervalDays);
  if (!isFinite(interval) || interval <= 0) return [];
  const step = Math.max(1, Math.round(interval));
  const today = plannerStartOfDay(now);
  let first = routine.lastDone ? plannerAddDays(plannerStartOfDay(routine.lastDone), step) : today;
  let overdue = false;
  if (first < today) {
    first = today;
    overdue = true;
  } else if (!routine.lastDone) {
    overdue = true; // never done counts as due now, same as the badge
  }
  const out = [];
  let d = first;
  for (let i = 0; i < PLANNER_MAX_OCCURRENCES && d <= to; i++) {
    if (d >= from) out.push({ iso: plannerISO(d), overdue: overdue && i === 0 });
    d = plannerAddDays(d, step);
  }
  return out;
}

// Forecast days → the same four flags weatherAlerts() uses, but for EVERY day
// of the forecast rather than the first match in the next four.
function plannerWeatherFlags(weather) {
  const out = {};
  const days = weather && Array.isArray(weather.days) ? weather.days : [];
  const units = (weather && weather.units) || {};
  // Thresholds live in weather.jsx; fall back to the same numbers if that
  // script isn't loaded so this never throws.
  const frostC = typeof WEATHER_FROST_C === "number" ? WEATHER_FROST_C : 2;
  const heatC = typeof WEATHER_HEAT_C === "number" ? WEATHER_HEAT_C : 35;
  const rainMm = typeof WEATHER_HEAVY_RAIN_MM === "number" ? WEATHER_HEAVY_RAIN_MM : 5;
  const windKmh = typeof WEATHER_WIND_KMH === "number" ? WEATHER_WIND_KMH : 35;
  for (const d of days) {
    if (!d || !d.date) continue;
    const flags = [];
    if (d.tempMin !== null && d.tempMin <= frostC)
      flags.push({ kind: "frost", icon: "bi-snow", label: `Frost risk — low of ${Math.round(d.tempMin)}${units.temp || "°C"}` });
    if (d.tempMax !== null && d.tempMax >= heatC)
      flags.push({ kind: "heat", icon: "bi-thermometer-sun", label: `Heat — high of ${Math.round(d.tempMax)}${units.temp || "°C"}` });
    if (d.rainMm !== null && d.rainMm > rainMm)
      flags.push({ kind: "rain", icon: "bi-cloud-rain-heavy", label: `Heavy rain — ${Math.round(d.rainMm)} ${units.rain || "mm"}` });
    if (d.windMax !== null && d.windMax >= windKmh)
      flags.push({ kind: "wind", icon: "bi-wind", label: `Strong wind — ${Math.round(d.windMax)} ${units.wind || "km/h"}` });
    if (flags.length) out[d.date] = flags;
  }
  return out;
}

// { "YYYY-MM-DD": { items: [...], weather: [...] } } for every day in range
// that has something on it.
function buildPlannerEvents({ routines, todos, weather, from, to, now = Date.now() }) {
  const map = {};
  const slot = (iso) => (map[iso] = map[iso] || { items: [], weather: [] });
  const todayIso = plannerISO(plannerStartOfDay(now));
  const fromIso = plannerISO(from);
  const toIso = plannerISO(to);

  for (const r of routines || []) {
    for (const occ of plannerRoutineDates(r, from, to, now)) {
      slot(occ.iso).items.push({
        type: "routine",
        id: r.id,
        text: r.task || "Untitled routine",
        sub: `every ${r.intervalDays}d`,
        overdue: occ.overdue,
      });
    }
  }

  for (const t of todos || []) {
    if (!t || t.done || !t.dueDate) continue;
    // An open to-do from a past day lands on TODAY, flagged — the calendar
    // answers "what do I have to do on this day", and the answer includes it.
    const overdue = t.dueDate < todayIso;
    const iso = overdue ? todayIso : t.dueDate;
    if (iso < fromIso || iso > toIso) continue;
    const time = typeof normalizeDueTime === "function" ? normalizeDueTime(t.dueTime) : "";
    slot(iso).items.push({
      type: "todo",
      id: t.id,
      text: t.text || "Untitled to-do",
      sub: overdue ? `overdue since ${t.dueDate}` : time ? `at ${time}` : "",
      overdue,
      time,
    });
  }

  const flags = plannerWeatherFlags(weather);
  for (const iso of Object.keys(flags)) {
    if (iso < fromIso || iso > toIso) continue;
    slot(iso).weather = flags[iso];
  }

  // Overdue first, then timed to-dos by time, then the rest by name.
  for (const iso of Object.keys(map)) {
    map[iso].items.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if ((a.time || "") !== (b.time || "")) return (a.time || "~").localeCompare(b.time || "~");
      return a.text.localeCompare(b.text);
    });
  }
  return map;
}

// Monday-first 6×7 grid of Dates covering the given month.
function plannerMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const start = plannerAddDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => plannerAddDays(start, i));
}

let plannerLastMonth = null; // { year, month } — session memory, like tasksLastSection

function CalendarView({ onNavigate, renderHeader }) {
  const now = new Date();
  const [cursor, setCursor] = useState(
    () => plannerLastMonth || { year: now.getFullYear(), month: now.getMonth() }
  );
  const [selected, setSelected] = useState(() => plannerISO(now));
  const [routines, setRoutines] = useState([]);
  const [todos, setTodos] = useState([]);
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getAllRoutines(), getAllTodos()]).then(([r, t]) => {
      if (!alive) return;
      setRoutines(r);
      setTodos(t);
    });
    if (typeof getWeather === "function") {
      getWeather(false)
        .then((w) => alive && setWeather(w))
        .catch((e) => console.error("calendar weather failed:", e && e.message));
    }
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    plannerLastMonth = cursor;
  }, [cursor]);

  const grid = plannerMonthGrid(cursor.year, cursor.month);
  const events = buildPlannerEvents({ routines, todos, weather, from: grid[0], to: grid[grid.length - 1] });
  const todayIso = plannerISO(now);
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const weekdays = grid.slice(0, 7).map((d) => d.toLocaleDateString(undefined, { weekday: "narrow" }));

  function shiftMonth(delta) {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function goToday() {
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(todayIso);
  }

  const day = events[selected] || { items: [], weather: [] };
  const selectedDate = new Date(`${selected}T00:00:00`);
  const selectedLabel = selectedDate.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const monthName = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: "long" });

  function askSeasonal() {
    let place = "";
    try {
      place = typeof getWeatherSettings === "function" ? getWeatherSettings().place || "" : "";
    } catch (_) {
      place = "";
    }
    onNavigate("chat", {
      draft: `What should I sow, plant, prune or protect in my garden in ${monthName}${place ? ` — I'm in ${place}` : ""}? Keep it to my plants where you can.`,
    });
  }

  const todayButton = (
    <button className="btn btn-ghost small" onClick={goToday}>
      <i className="bi bi-calendar-check" aria-hidden="true"></i> Today
    </button>
  );

  return (
    <div className="tab-panel">
      {renderHeader ? (
        renderHeader(todayButton)
      ) : (
        <div className="view-header">
          <h2><i className="bi bi-calendar3" aria-hidden="true"></i> Calendar</h2>
          {todayButton}
        </div>
      )}

      <div className="cal-panel">
        <div className="cal-nav">
          <button className="icon-btn" onClick={() => shiftMonth(-1)} title="Previous month" aria-label="Previous month">
            <i className="bi bi-chevron-left" aria-hidden="true"></i>
          </button>
          <h3 className="cal-month" aria-live="polite">{monthLabel}</h3>
          <button className="icon-btn" onClick={() => shiftMonth(1)} title="Next month" aria-label="Next month">
            <i className="bi bi-chevron-right" aria-hidden="true"></i>
          </button>
        </div>

        <div className="cal-grid" role="group" aria-label={monthLabel}>
          {weekdays.map((w, i) => (
            <div key={`h${i}`} className="cal-weekday" aria-hidden="true">{w}</div>
          ))}
          {grid.map((d) => {
            const iso = plannerISO(d);
            const ev = events[iso];
            const inMonth = d.getMonth() === cursor.month;
            const routinesN = ev ? ev.items.filter((x) => x.type === "routine").length : 0;
            const todosN = ev ? ev.items.filter((x) => x.type === "todo").length : 0;
            const overdue = ev ? ev.items.some((x) => x.overdue) : false;
            const flag = ev && ev.weather.length ? ev.weather[0] : null;
            const cls = ["cal-day"];
            if (!inMonth) cls.push("out");
            if (iso === todayIso) cls.push("today");
            if (iso === selected) cls.push("selected");
            const parts = [d.toLocaleDateString(undefined, { day: "numeric", month: "long" })];
            if (routinesN) parts.push(`${routinesN} routine${routinesN === 1 ? "" : "s"}`);
            if (todosN) parts.push(`${todosN} to-do${todosN === 1 ? "" : "s"}`);
            if (ev) ev.weather.forEach((f) => parts.push(f.label));
            return (
              <button
                key={iso}
                type="button"
                className={cls.join(" ")}
                aria-pressed={iso === selected}
                aria-label={parts.join(", ")}
                onClick={() => {
                  setSelected(iso);
                  if (!inMonth) setCursor({ year: d.getFullYear(), month: d.getMonth() });
                }}
              >
                <span className="cal-num">{d.getDate()}</span>
                {flag && <i className={`bi ${flag.icon} cal-wx ${flag.kind}`} aria-hidden="true"></i>}
                <span className="cal-dots" aria-hidden="true">
                  {routinesN > 0 && <span className={overdue ? "cal-dot routine overdue" : "cal-dot routine"}></span>}
                  {todosN > 0 && <span className={overdue ? "cal-dot todo overdue" : "cal-dot todo"}></span>}
                </span>
              </button>
            );
          })}
        </div>

        <div className="cal-legend" aria-hidden="true">
          <span><span className="cal-dot routine"></span> routine</span>
          <span><span className="cal-dot todo"></span> to-do</span>
          <span><span className="cal-dot overdue"></span> overdue</span>
          {weather && <span><i className="bi bi-cloud-sun"></i> 7-day forecast</span>}
        </div>

        <section className="cal-agenda" aria-label={`Plan for ${selectedLabel}`}>
          <h3 className="today-section-title">
            <i className="bi bi-calendar-event" aria-hidden="true"></i> {selected === todayIso ? `Today — ${selectedLabel}` : selectedLabel}
          </h3>

          {day.weather.map((f) => (
            <div key={f.kind} className={`cal-wx-row ${f.kind}`}>
              <i className={`bi ${f.icon}`} aria-hidden="true"></i> {f.label}
            </div>
          ))}

          {day.items.length === 0 && day.weather.length === 0 && (
            <p className="empty-hint">Nothing planned for this day.</p>
          )}

          <div role="list">
            {day.items.map((it) => (
              <div key={`${it.type}${it.id}`} role="listitem" className="today-row">
                <button
                  className="today-row-main"
                  onClick={() =>
                    it.type === "routine" ? onNavigate("routines", { itemId: it.id }) : onNavigate("todos")
                  }
                >
                  <i className={it.type === "routine" ? "bi bi-arrow-repeat" : "bi bi-check2-square"} aria-hidden="true"></i>
                  <span className="today-row-text">
                    <span className="today-row-title">{it.text}</span>
                    <span className="today-row-sub">
                      {it.overdue ? <span className="todo-due overdue">{it.type === "routine" ? "overdue" : it.sub}</span> : it.sub}
                      {it.overdue && it.type === "routine" ? ` · ${it.sub}` : ""}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>

        <div className="today-actions">
          <button className="btn btn-ghost" onClick={askSeasonal}>
            <i className="bi bi-flower1" aria-hidden="true"></i> What to do in {monthName}?
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- watering overview ----------

// Local "YYYY-MM-DD" days on which a plant was watered, newest window only.
// Reads both the history log (Watered button, routines) and lastWatered (the AI
// can set that without writing a "water" log row), so neither path is missed.
function plannerWateringDays(plant, windowDays = PLANNER_WATER_WINDOW_DAYS, now = Date.now()) {
  const since = plannerAddDays(plannerStartOfDay(now), -(windowDays - 1)).getTime();
  const days = new Set();
  for (const h of (plant && plant.photoHistory) || []) {
    if (h && h.kind === "water" && typeof h.date === "number" && h.date >= since && h.date <= now) {
      days.add(plannerISO(new Date(h.date)));
    }
  }
  if (plant && typeof plant.lastWatered === "number" && plant.lastWatered >= since && plant.lastWatered <= now) {
    days.add(plannerISO(new Date(plant.lastWatered)));
  }
  return days;
}

// Per-plant stats for the window: count, average days between waterings
// (null with fewer than two), and the day-by-day strip oldest → newest.
function plannerWateringStats(plant, windowDays = PLANNER_WATER_WINDOW_DAYS, now = Date.now()) {
  const days = plannerWateringDays(plant, windowDays, now);
  const today = plannerStartOfDay(now);
  const strip = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const iso = plannerISO(plannerAddDays(today, -i));
    strip.push({ iso, watered: days.has(iso) });
  }
  const sorted = [...days].sort();
  let avgGap = null;
  if (sorted.length >= 2) {
    const first = new Date(`${sorted[0]}T00:00:00`);
    const last = new Date(`${sorted[sorted.length - 1]}T00:00:00`);
    const span = Math.round((last - first) / PLANNER_DAY_MS);
    avgGap = Math.round((span / (sorted.length - 1)) * 10) / 10;
  }
  return { count: days.size, avgGap, strip };
}

// Plain-language forecast note for watering, or "" with no weather. Says
// "outdoor" on purpose: rain does nothing for a pot on a windowsill.
function plannerRainNote(weather) {
  if (!weather || typeof weatherAlerts !== "function") return "";
  const a = weatherAlerts(weather);
  const unit = (weather.units && weather.units.rain) || "mm";
  const lines = [];
  if (a.heavyRain) lines.push(`Heavy rain ${a.heavyRain.when} — outdoor plants can probably skip a watering.`);
  else if (a.dry) lines.push("No rain in the next 4 days — outdoor pots will dry out faster.");
  else lines.push(`About ${Math.round(a.rainTotal)} ${unit} of rain expected over the next 4 days.`);
  if (a.heat) lines.push(`Heat ${a.heat.when} — check pots and new plantings daily.`);
  return lines.join(" ");
}

function WateringOverviewModal({ onClose, onNavigate }) {
  const [plants, setPlants] = useState(null);
  const [routines, setRoutines] = useState([]);
  const [weather, setWeather] = useState(null);
  useEscapeKey(onClose);

  useEffect(() => {
    let alive = true;
    Promise.all([getAllPlants(), getAllRoutines()]).then(([p, r]) => {
      if (!alive) return;
      setPlants(p);
      setRoutines(r);
    });
    if (typeof getWeather === "function") {
      getWeather(false)
        .then((w) => alive && setWeather(w))
        .catch((e) => console.error("watering weather failed:", e && e.message));
    }
    return () => {
      alive = false;
    };
  }, []);

  const rows = (plants || [])
    .map((p) => ({
      plant: p,
      stats: plannerWateringStats(p),
      target: typeof todayWateringInterval === "function" ? todayWateringInterval(p, routines) : null,
    }))
    .sort((a, b) => b.stats.count - a.stats.count || (a.plant.name || "").localeCompare(b.plant.name || ""));
  const total = rows.reduce((s, r) => s + r.stats.count, 0);
  const rainNote = plannerRainNote(weather);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watering-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="watering-modal-title"><i className="bi bi-droplet-half" aria-hidden="true"></i> Watering — last 30 days</h2>
        {plants === null ? (
          <p className="empty-hint">Loading…</p>
        ) : plants.length === 0 ? (
          <p className="empty-hint">No plants yet — add one in the Garden tab.</p>
        ) : (
          <React.Fragment>
            <p className="water-summary">
              {total} watering{total === 1 ? "" : "s"} across {plants.length} plant{plants.length === 1 ? "" : "s"}.
              {" "}Counts come from the Watered button and watering routines — amounts aren't tracked.
            </p>
            {rainNote && (
              <div className="cal-wx-row rain"><i className="bi bi-cloud-drizzle" aria-hidden="true"></i> {rainNote}</div>
            )}
            <div className="water-list" role="list">
              {rows.map(({ plant, stats, target }) => (
                <div key={plant.id} role="listitem">
                <button
                  className="water-row"
                  onClick={() => {
                    onClose();
                    onNavigate("garden", { itemId: plant.id });
                  }}
                >
                  <span className="water-row-head">
                    <span className="today-row-title">{plant.name || `Plant #${plant.id}`}</span>
                    <span className="today-row-sub">
                      {stats.count}× · {stats.avgGap !== null ? `every ~${stats.avgGap}d` : "no rhythm yet"}
                      {target ? ` · aim every ${target}d` : ""} · last {timeAgo(plant.lastWatered)}
                    </span>
                  </span>
                  <span className="water-strip" aria-label={`${stats.count} waterings in the last 30 days`}>
                    {stats.strip.map((s) => (
                      <span key={s.iso} className={s.watered ? "water-cell on" : "water-cell"} title={s.iso}></span>
                    ))}
                  </span>
                </button>
                </div>
              ))}
            </div>
          </React.Fragment>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
