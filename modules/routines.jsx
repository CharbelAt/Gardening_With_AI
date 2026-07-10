// Routines module: recurring care tasks as a card grid (due tasks badged),
// each with its own detail page.

function AddRoutineModal({ onClose, onAdded }) {
  const [task, setTask] = useState("");
  const [intervalDays, setIntervalDays] = useState(3);

  async function save() {
    if (!task.trim()) return;
    await addRoutine({ task: task.trim(), intervalDays: Number(intervalDays) || 1 });
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add routine</h2>
        <label>
          Task
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Water tomatoes" />
        </label>
        <label>
          Repeat every (days)
          <input type="number" min="1" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RoutineDetail({ routine, onBack, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    task: routine.task || "",
    intervalDays: routine.intervalDays || 1,
  });

  const due = isRoutineDue(routine);

  async function markDone() {
    await updateRoutine({ ...routine, lastDone: Date.now() });
    onChanged();
  }

  async function saveForm() {
    await updateRoutine({ ...routine, ...form, intervalDays: Number(form.intervalDays) || 1 });
    setEditing(false);
    onChanged();
  }

  async function remove() {
    await deleteRoutine(routine.id);
    setConfirmDelete(false);
    onBack();
    onChanged();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{routine.task || "Untitled routine"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)}><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        <div className="item-facts">
          <div><i className="bi bi-arrow-repeat"></i> every {routine.intervalDays} day{routine.intervalDays === 1 ? "" : "s"}</div>
          <div><i className="bi bi-check2-circle"></i> {routine.lastDone ? `last done ${new Date(routine.lastDone).toLocaleDateString()}` : "never done"}</div>
          {due && <div className="item-notes"><i className="bi bi-exclamation-circle"></i> Due now</div>}
        </div>

        <div className="item-quick-actions">
          <button className="btn small" onClick={markDone}>Mark done</button>
          <button className="btn btn-danger small" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete routine?"
          message={`Remove "${routine.task || "this routine"}"?`}
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit routine</h2>
            <label>
              Task
              <input value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })} />
            </label>
            <label>
              Repeat every (days)
              <input type="number" min="1" value={form.intervalDays} onChange={(e) => setForm({ ...form, intervalDays: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={saveForm}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoutinesView({ onBack }) {
  const [routines, setRoutines] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setRoutines(await getAllRoutines());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = routines.find((r) => r.id === selectedId) || null;

  if (selected) {
    return <RoutineDetail routine={selected} onBack={() => setSelectedId(null)} onChanged={refresh} />;
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Routines</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)}><i className="bi bi-plus-lg"></i></button>
      </div>
      <div className="item-grid">
        {routines.length === 0 && <p className="empty-hint">No routines yet — tap + to add a recurring task.</p>}
        {routines.map((r) => {
          const due = isRoutineDue(r);
          return (
            <button key={r.id} className={due ? "item-card due" : "item-card"} onClick={() => setSelectedId(r.id)}>
              <div className="item-card-placeholder"><i className="bi bi-arrow-repeat"></i></div>
              <span>{r.task || "Untitled routine"}</span>
              <span className="item-card-sub">every {r.intervalDays}d</span>
              {due && <span className="item-card-badge">Due</span>}
            </button>
          );
        })}
      </div>
      {showAdd && (
        <AddRoutineModal
          onClose={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
