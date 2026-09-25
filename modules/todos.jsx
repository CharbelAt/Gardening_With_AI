// To-do module: one-off garden tasks ("prune the roses", "repot the mint on
// Saturday") as a flat checklist — deliberately NOT a card grid, and modelled
// on the Inventory "to get" panel. Three lists that look similar but mean
// different things: a ROUTINE recurs on an interval, a TO-GET item is
// something to BUY, a TO-DO is a single task to DO once and then tick off.
//
// Editable via chat too (ADD_TODO/UPDATE_TODO/COMPLETE_TODO/REMOVE_TODO in
// helpers.jsx). Like every other module this file is a classic script sharing
// the page's global scope — no import/export (see idb.js's note).

// `todayISO()` and `todoDueDelta()` (0 = today, negative = overdue) live in
// helpers.jsx — the AI's knowledge context needs them too and that file loads
// first. So do `normalizeDueTime()` and `todoDueAt()`, the only two places that
// know how to read the optional "HH:MM" dueTime.
//
// `dueTime` is optional and the SECOND argument, so every existing call site
// (today.jsx passes the date alone) keeps rendering exactly what it always did.
function todoDueLabel(dueDate, dueTime) {
  const delta = todoDueDelta(dueDate);
  if (delta === null) return "";
  const time = normalizeDueTime(dueTime); // "" for absent or unusable
  const at = time ? ` ${time}` : "";
  if (delta === 0) return `today${at}`;
  // No time on an overdue label: this branch only fires for a PREVIOUS
  // calendar day, where "overdue 3 d 14:30" would be noise, not information.
  if (delta < 0) return `overdue ${-delta} d`;
  if (delta === 1) return `tomorrow${at}`;
  return dueDate + at;
}

// The nav badge counts only what actually needs attention today: open items
// that are overdue or due today (not every open to-do).
//
// A to-do with a TIME is not urgent until that time arrives — a 14:30 reminder
// shouldn't be shouting at 09:00 — but everything else is judged exactly as
// before, by the calendar day alone. Dateless: never urgent; an earlier day:
// always urgent whatever the clock says; today with no time: urgent all day.
function isTodoUrgent(todo) {
  if (!todo || todo.done) return false;
  const delta = todoDueDelta(todo.dueDate);
  if (delta === null || delta > 0) return false;
  if (delta < 0) return true;
  const at = todoDueAt(todo); // null unless BOTH dueDate and a usable dueTime
  return at === null ? true : Date.now() >= at;
}

// Open items first (soonest due first, undated last, then id); done items
// sink to the bottom, most recently completed first.
function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done) return (b.completedAt || 0) - (a.completedAt || 0) || a.id - b.id;
    const ad = a.dueDate || "";
    const bd = b.dueDate || "";
    if (ad !== bd) {
      if (!ad) return 1;
      if (!bd) return -1;
      return ad < bd ? -1 : 1;
    }
    return a.id - b.id;
  });
}

function EditTodoModal({ todo, onSave, onCancel }) {
  const [text, setText] = useState(todo.text || "");
  const [dueDate, setDueDate] = useState(todo.dueDate || "");
  const [dueTime, setDueTime] = useState(todo.dueTime || "");
  const [notes, setNotes] = useState(todo.notes || "");
  useEscapeKey(onCancel);

  const save = () => onSave({ text: text.trim(), dueDate, dueTime, notes });

  // Clearing the date clears the time with it: a time with no date has no
  // moment to fire at, so leaving one behind would store a value that does
  // nothing now and quietly comes back to life if a date is added later.
  function changeDate(value) {
    setDueDate(value);
    if (!value) setDueTime("");
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-todo-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="edit-todo-modal-title">Edit to-do</h2>
        <label>
          Task
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && text.trim() && save()}
          />
        </label>
        <label>
          Due date (optional)
          <input type="date" value={dueDate} onChange={(e) => changeDate(e.target.value)} />
        </label>
        <label>
          Time (optional — sends a reminder at that moment)
          <input type="time" value={dueTime} disabled={!dueDate} onChange={(e) => setDueTime(e.target.value)} />
        </label>
        <label>
          Notes
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
        <div className="modal-actions">
          <button className="btn" disabled={!text.trim()} onClick={save}>
            Save
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// `renderHeader` (optional): same contract as RoutinesView — inside the Tasks
// tab the host renders one shared header and we hand it the action that
// belongs to this section ("Clear completed"). Absent, this view renders its
// own header and still works standalone.
function TodosView({ onNavigate, renderHeader }) {
  const [todos, setTodos] = useState([]);
  const [newText, setNewText] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newTime, setNewTime] = useState("");
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [confirmClearDone, setConfirmClearDone] = useState(false);

  async function refresh() {
    setTodos(await getAllTodos());
  }
  useEffect(() => {
    refresh();
  }, []);

  const doneCount = todos.filter((t) => t.done).length;

  async function addNew() {
    const text = newText.trim();
    if (!text) return;
    await addTodo({ text, dueDate: newDue, dueTime: newDue ? normalizeDueTime(newTime) : "" });
    setNewText("");
    setNewDue("");
    setNewTime("");
    refresh();
    if (typeof schedulePushSync === "function") schedulePushSync(); // due dates moved — refresh the server's alarm schedule
  }

  async function toggle(t) {
    const done = !t.done;
    await updateTodo({ ...t, done, completedAt: done ? Date.now() : null });
    refresh();
    if (typeof schedulePushSync === "function") schedulePushSync(); // due dates moved — refresh the server's alarm schedule
  }

  async function saveEdit(fields) {
    await updateTodo({ ...editTarget, ...fields });
    setEditTarget(null);
    refresh();
    if (typeof schedulePushSync === "function") schedulePushSync(); // due dates moved — refresh the server's alarm schedule
  }

  async function remove() {
    await deleteTodo(deleteTarget.id);
    setDeleteTarget(null);
    refresh();
    if (typeof schedulePushSync === "function") schedulePushSync(); // due dates moved — refresh the server's alarm schedule
  }

  // Only the completed ones — clearAllTodos() (Settings) is the nuclear option.
  async function clearCompleted() {
    for (const t of todos.filter((x) => x.done)) await deleteTodo(t.id);
    setConfirmClearDone(false);
    refresh();
    if (typeof schedulePushSync === "function") schedulePushSync(); // due dates moved — refresh the server's alarm schedule
  }

  const clearDoneButton =
    doneCount > 0 ? (
      <button className="btn btn-ghost small" onClick={() => setConfirmClearDone(true)}>
        <i className="bi bi-eraser" aria-hidden="true"></i> Clear completed
      </button>
    ) : null;

  return (
    <div className="tab-panel">
      {renderHeader ? (
        renderHeader(clearDoneButton)
      ) : (
        <div className="view-header">
          <h2><i className="bi bi-check2-square" aria-hidden="true"></i> To-do</h2>
          {clearDoneButton}
        </div>
      )}

      <div className="todo-panel" role="list">
        <div className="todo-add" role="listitem">
          <input
            className="text-input"
            placeholder="Add a task…"
            aria-label="Add a task"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addNew()}
          />
          <input
            className="todo-date"
            type="date"
            title="Due date (optional)"
            aria-label="Due date (optional)"
            value={newDue}
            onChange={(e) => {
              setNewDue(e.target.value);
              if (!e.target.value) setNewTime(""); // no date → a time has nothing to fire on
            }}
          />
          {newDue && (
            <input
              className="todo-date"
              type="time"
              title="Time (optional)"
              aria-label="Time (optional)"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
            />
          )}
          <button className="btn btn-send" onClick={addNew} disabled={!newText.trim()} title="Add" aria-label="Add">
            <i className="bi bi-plus-lg" aria-hidden="true"></i>
          </button>
        </div>

        {todos.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-check2-square" aria-hidden="true"></i>
            <p>Nothing to do — add a task, or ask Sprout to plan your week.</p>
            {/* No icon on purpose: .empty-state i is the big 2.6rem glyph. */}
            <button
              className="btn btn-ghost small"
              onClick={() => onNavigate("chat", { draft: "Help me plan my garden to-dos for this week." })}
            >
              Ask Sprout
            </button>
          </div>
        )}

        {sortTodos(todos).map((t) => {
          const urgent = isTodoUrgent(t);
          return (
            <div key={t.id} role="listitem" className={t.done ? "todo-row done" : "todo-row"}>
              <button
                className="todo-check"
                onClick={() => toggle(t)}
                title={t.done ? "Mark not done" : "Check off"}
                aria-label={t.done ? "Mark not done" : "Check off"}
                aria-pressed={t.done}
              >
                <i className={t.done ? "bi bi-check-square-fill" : "bi bi-square"} aria-hidden="true"></i>
              </button>
              <div className="todo-text">
                <span className="todo-title">
                  {t.text}
                  {t.dueDate && (
                    <span className={urgent ? "todo-due overdue" : "todo-due"}>
                      <i className="bi bi-calendar-event" aria-hidden="true"></i> {todoDueLabel(t.dueDate, t.dueTime)}
                    </span>
                  )}
                </span>
                {t.notes && <span className="todo-notes">{t.notes}</span>}
              </div>
              <button className="icon-btn small" onClick={() => setEditTarget(t)} title="Edit" aria-label="Edit">
                <i className="bi bi-pencil" aria-hidden="true"></i>
              </button>
              <button className="icon-btn small" onClick={() => setDeleteTarget(t)} title="Delete" aria-label="Delete">
                <i className="bi bi-trash" aria-hidden="true"></i>
              </button>
            </div>
          );
        })}
      </div>

      {editTarget && (
        <EditTodoModal todo={editTarget} onSave={saveEdit} onCancel={() => setEditTarget(null)} />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete to-do?"
          message={`Remove "${deleteTarget.text || "this task"}" from your to-do list?`}
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {confirmClearDone && (
        <ConfirmModal
          title="Clear completed?"
          message={`Delete ${doneCount} completed to-do${doneCount === 1 ? "" : "s"}. This can't be undone.`}
          confirmLabel="Clear"
          onConfirm={clearCompleted}
          onCancel={() => setConfirmClearDone(false)}
        />
      )}
    </div>
  );
}
