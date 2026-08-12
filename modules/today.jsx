// Today dashboard: the "what do I actually do in the garden today" screen —
// overdue routines, urgent to-dos and thirsty plants gathered from the three
// modules that own them, each actionable INLINE so the common case (tick it
// off) never costs a trip into another tab.
//
// Reads only; every write goes through the same helpers the owning module uses
// (completeRoutine, updateTodo, withCareLogEntry + updatePlant), so a routine
// completed here stamps its linked plant exactly like Routines does.
//
// The bottom nav is full at six items, so this renders standalone inside
// <main className="app-main"> using the app's usual .tab-panel/.view-header
// shell. Classic script sharing the page's global scope — no import/export.

// A plant with no watering routine still needs an "is it thirsty?" answer;
// four days is the compromise between a windowsill basil and a garden shrub.
const TODAY_THIRSTY_DEFAULT_DAYS = 4;

const TODAY_SUMMARY_SYSTEM =
  "You are Sprout, the user's gardening companion. From the due tasks and local weather below, " +
  "write a SHORT plan for today: 3-5 bullet points, under 120 words, most important first. " +
  "Let the weather change the advice (don't water before heavy rain, protect from frost, water " +
  "early in heat). No preamble, no sign-off, no questions, and no action lines — just the plan.";

function todayGreeting(date) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function todayDateLine(date) {
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

// A linked watering routine knows this plant better than any default does, so
// its interval wins; several linked routines means the tightest one wins.
function todayWateringInterval(plant, routines) {
  const linked = (routines || []).filter(
    (r) => r.plantId === plant.id && r.careAction === "water" && Number(r.intervalDays) > 0
  );
  if (!linked.length) return TODAY_THIRSTY_DEFAULT_DAYS;
  return Math.min(...linked.map((r) => Math.max(1, Number(r.intervalDays))));
}

// Never-watered first (they have no baseline at all), then whatever is furthest
// past its own interval.
function todayThirstyPlants(plants, routines) {
  return (plants || [])
    .map((p) => ({ plant: p, interval: todayWateringInterval(p, routines), days: daysSince(p.lastWatered) }))
    .filter((x) => x.days === null || x.days >= x.interval)
    .sort((a, b) => {
      if ((a.days === null) !== (b.days === null)) return a.days === null ? -1 : 1;
      if (a.days === null) return (a.plant.name || "").localeCompare(b.plant.name || "");
      return b.days - b.interval - (a.days - a.interval); // days PAST its own interval
    });
}

function TodayView({ onNavigate }) {
  const [plants, setPlants] = useState([]);
  const [routines, setRoutines] = useState([]);
  const [todos, setTodos] = useState([]);
  const [busyKey, setBusyKey] = useState(""); // the one row currently being written
  const [summary, setSummary] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const now = new Date();

  async function refresh() {
    const [p, r, t] = await Promise.all([getAllPlants(), getAllRoutines(), getAllTodos()]);
    setPlants(p);
    setRoutines(r);
    setTodos(t);
  }
  useEffect(() => {
    refresh();
  }, []);

  const dueRoutines = routines.filter(isRoutineDue);
  const urgentTodos = todos.filter(isTodoUrgent).sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const thirsty = todayThirstyPlants(plants, routines);
  const attentionCount = dueRoutines.length + urgentTodos.length;
  const nothingToDo = attentionCount === 0 && thirsty.length === 0;

  // One shared guard for the inline actions: a double-tap on a slow device
  // would otherwise complete the same routine twice.
  async function runAction(key, fn) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      console.error("today action failed:", e && e.message);
    } finally {
      setBusyKey("");
    }
  }

  const doRoutine = (r) => runAction(`r${r.id}`, () => completeRoutine(r));
  const doTodo = (t) => runAction(`t${t.id}`, () => updateTodo({ ...t, done: true, completedAt: Date.now() }));
  // Same shape as garden.jsx's markWatered: withCareLogEntry keeps repeat taps
  // from piling duplicate "Watered" rows into the plant's history.
  const doWater = (p) =>
    runAction(`p${p.id}`, () =>
      updatePlant(withCareLogEntry({ ...p, lastWatered: Date.now() }, "Watered", "water"))
    );

  async function summarizeDay() {
    if (summarizing) return;
    setSummarizing(true);
    setSummaryError("");
    setSummary("");
    try {
      const lines = [`Right now: ${deviceNow()}.`];
      if (dueRoutines.length) {
        lines.push(
          "Overdue routines: " +
            dueRoutines
              .map((r) => `"${r.task}" (every ${r.intervalDays}d, last done ${r.lastDone ? timeAgo(r.lastDone) : "never"})`)
              .join("; ")
        );
      }
      if (urgentTodos.length) {
        lines.push(
          "To-dos due or overdue: " +
            urgentTodos.map((t) => `"${t.text}"${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("; ")
        );
      }
      if (thirsty.length) {
        lines.push(
          "Plants needing water: " +
            thirsty
              .map((x) => `"${x.plant.name}" (${x.days === null ? "never watered" : `${x.days}d ago`}, wants every ${x.interval}d)`)
              .join("; ")
        );
      }
      if (nothingToDo) lines.push("Nothing is overdue — suggest what's worth doing anyway.");
      // The same block the chat gets, when the user has weather switched on.
      const weather = typeof buildWeatherContext === "function" ? await buildWeatherContext() : "";
      if (weather) lines.push(weather);

      const data = await apiFetch("/api/chat", {
        mode: "act", // short, factual, no thinking needed — the fast chain
        messages: [
          { role: "system", content: TODAY_SUMMARY_SYSTEM },
          { role: "user", content: lines.join("\n") },
        ],
      });
      // Small models still tag replies with the STATUS line from their own
      // system prompt; strip it rather than rendering it.
      const { cleanText } = extractStatus(data.reply || "");
      setSummary(cleanText || "No summary came back — try again in a moment.");
    } catch (e) {
      // The app is fully usable offline; a missing/unreachable backend is a
      // note in the panel, never a crash.
      setSummaryError(e.message || "Couldn't reach Sprout.");
    } finally {
      setSummarizing(false);
    }
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <h2><i className="bi bi-sunrise" aria-hidden="true"></i> Today</h2>
        <button className="icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
          <i className="bi bi-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>

      <div className="today-panel">
        <div className="today-greeting">
          <h3>{todayGreeting(now)}</h3>
          <p>{todayDateLine(now)}</p>
        </div>

        {/* Guarded: weather.jsx is a separate script and may not be wired in yet. */}
        {typeof WeatherStrip === "function" && <WeatherStrip compact />}

        {nothingToDo && (
          <div className="empty-state">
            <i className="bi bi-emoji-smile" aria-hidden="true"></i>
            <p>Nothing needs you today — no routines due, no to-dos, every plant recently watered.</p>
            <span className="empty-sub">Good day to just look at it all.</span>
          </div>
        )}

        {attentionCount > 0 && (
          <section className="today-section" role="list">
            <h3 className="today-section-title">
              <i className="bi bi-exclamation-circle" aria-hidden="true"></i> Needs attention
              <span className="today-count">{attentionCount}</span>
            </h3>

            {dueRoutines.map((r) => (
              <div key={`r${r.id}`} role="listitem" className="today-row">
                <button className="today-row-main" onClick={() => onNavigate("routines", { itemId: r.id })}>
                  <i className="bi bi-arrow-repeat" aria-hidden="true"></i>
                  <span className="today-row-text">
                    <span className="today-row-title">{r.task || "Untitled routine"}</span>
                    <span className="today-row-sub">
                      every {r.intervalDays}d · {r.lastDone ? `done ${timeAgo(r.lastDone)}` : "never done"}
                    </span>
                  </span>
                </button>
                <button
                  className="today-do"
                  title="Mark done"
                  aria-label="Mark done"
                  disabled={busyKey === `r${r.id}`}
                  onClick={() => doRoutine(r)}
                >
                  <i className="bi bi-check2-circle" aria-hidden="true"></i>
                </button>
              </div>
            ))}

            {urgentTodos.map((t) => (
              <div key={`t${t.id}`} role="listitem" className="today-row">
                <button className="today-row-main" onClick={() => onNavigate("todos")}>
                  <i className="bi bi-check2-square" aria-hidden="true"></i>
                  <span className="today-row-text">
                    <span className="today-row-title">{t.text}</span>
                    <span className="today-row-sub">
                      <span className="todo-due overdue">
                        <i className="bi bi-calendar-event" aria-hidden="true"></i> {todoDueLabel(t.dueDate)}
                      </span>
                    </span>
                  </span>
                </button>
                <button
                  className="today-do"
                  title="Check off"
                  aria-label="Check off"
                  disabled={busyKey === `t${t.id}`}
                  onClick={() => doTodo(t)}
                >
                  <i className="bi bi-check2-square" aria-hidden="true"></i>
                </button>
              </div>
            ))}
          </section>
        )}

        {thirsty.length > 0 && (
          <section className="today-section" role="list">
            <h3 className="today-section-title">
              <i className="bi bi-droplet" aria-hidden="true"></i> Thirsty plants
              <span className="today-count">{thirsty.length}</span>
            </h3>
            {thirsty.map(({ plant, interval, days }) => (
              <div key={`p${plant.id}`} role="listitem" className="today-row">
                <button className="today-row-main" onClick={() => onNavigate("garden", { itemId: plant.id })}>
                  {plant.coverThumb ? (
                    <img className="today-thumb" src={plant.coverThumb} alt={plant.name} />
                  ) : (
                    <i className="bi bi-flower3" aria-hidden="true"></i>
                  )}
                  <span className="today-row-text">
                    <span className="today-row-title">{plant.name || `Plant #${plant.id}`}</span>
                    <span className="today-row-sub">
                      {days === null ? "never watered" : `watered ${timeAgo(plant.lastWatered)}`} · every {interval}d
                      {plant.location ? ` · ${plant.location}` : ""}
                    </span>
                  </span>
                </button>
                <button
                  className="today-do"
                  title="Mark watered"
                  aria-label="Mark watered"
                  disabled={busyKey === `p${plant.id}`}
                  onClick={() => doWater(plant)}
                >
                  <i className="bi bi-droplet-fill" aria-hidden="true"></i>
                </button>
              </div>
            ))}
          </section>
        )}

        <div className="today-actions">
          <button
            className="btn btn-ghost"
            onClick={() => onNavigate("chat", { draft: "What should I prioritize in the garden today?" })}
          >
            <i className="bi bi-chat-dots" aria-hidden="true"></i> Ask Sprout about today
          </button>
          <button className="btn btn-ghost" onClick={summarizeDay} disabled={summarizing}>
            <i className={summarizing ? "bi bi-hourglass-split" : "bi bi-stars"} aria-hidden="true"></i>{" "}
            {summarizing ? "Thinking…" : "Summarize my day"}
          </button>
        </div>

        {summaryError && <div className="error-banner" role="alert">{summaryError}</div>}
        {summary && (
          <div className="today-summary" role="status" aria-live="polite">
            <h3 className="today-section-title"><i className="bi bi-stars" aria-hidden="true"></i> Sprout's plan</h3>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(summary) }} />
          </div>
        )}
      </div>
    </div>
  );
}
