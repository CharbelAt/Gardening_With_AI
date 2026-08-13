// Tasks tab: one home for everything with a checkbox — recurring ROUTINES and
// one-off TO-DOS — behind a segmented control.
//
// Why they merged: six bottom-bar tabs is one more than a 360px phone can
// label comfortably, and "routine vs to-do" is a difference in HOW OFTEN a
// task repeats, not in where it lives. Splitting them across two tabs made the
// user ask two questions ("is this a routine or a to-do?", "which tab was it
// in?") to answer one ("what do I have to do?").
//
// This file deliberately owns almost no UI. RoutinesView (routines.jsx) and
// TodosView (todos.jsx) still render their own lists, add rows, modals and
// detail pages exactly as before — all this does is decide which one is on
// screen and hand it a header to render via the `renderHeader` render-prop.
// The header is rendered BY the section (not around it) for two reasons: the
// section stays a single .tab-panel scroll container, and a detail page like
// RoutineDetail returns before it ever calls renderHeader, so drilling into a
// routine still shows only its own back-arrow header instead of two stacked
// ones.
//
// Classic script sharing the page's global scope — no import/export. Loads
// after routines.jsx/todos.jsx and before app.jsx (see index.html).

// Which section the user was last on. Module-level rather than component state
// because TasksView unmounts every time another tab is opened, and coming back
// to where you were is the expected behaviour. Deliberately NOT persisted to
// localStorage: "where I was a minute ago" is session memory, not a setting.
let tasksLastSection = "routines";

const TASKS_SECTIONS = [
  { key: "routines", label: "Routines", icon: "bi-arrow-repeat" },
  { key: "todos", label: "To-do", icon: "bi-check2-square" },
];

function isTasksSection(key) {
  return key === "routines" || key === "todos";
}

function TasksView({ initialId, initialSection, onNavigate }) {
  const [section, setSection] = useState(() =>
    isTasksSection(initialSection) ? initialSection : tasksLastSection
  );

  // A deep link can arrive while Tasks is already the open tab — a search
  // result is the everyday case (you're reading To-do, you tap a routine) — so
  // an incoming section has to win on change, not only on mount.
  useEffect(() => {
    if (isTasksSection(initialSection)) setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    tasksLastSection = section;
  }, [section]);

  // Called by whichever section is mounted, from the top of its own .tab-panel.
  // `sectionActions` is that section's own header control (Add routine /
  // Clear completed), so the shared header shows the action that belongs to
  // what you are actually looking at.
  function renderHeader(sectionActions) {
    return (
      <React.Fragment>
        <div className="view-header">
          <h2><i className="bi bi-check2-square" aria-hidden="true"></i> Tasks</h2>
          {sectionActions}
        </div>
        <div className="segmented" role="group" aria-label="Task type">
          {TASKS_SECTIONS.map((s) => (
            <button
              type="button"
              key={s.key}
              className={section === s.key ? "segmented-option active" : "segmented-option"}
              aria-pressed={section === s.key}
              onClick={() => setSection(s.key)}
            >
              <i className={`bi ${s.icon}`} aria-hidden="true"></i> {s.label}
            </button>
          ))}
        </div>
      </React.Fragment>
    );
  }

  // initialId only ever addresses a routine (to-dos are edited in place, they
  // have no detail page), so it goes to RoutinesView alone.
  return section === "todos" ? (
    <TodosView onNavigate={onNavigate} renderHeader={renderHeader} />
  ) : (
    <RoutinesView initialId={initialId} onNavigate={onNavigate} renderHeader={renderHeader} />
  );
}
