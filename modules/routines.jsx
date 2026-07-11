// Routines module: recurring care tasks as a card grid (due tasks badged),
// each with its own detail page. A routine can be linked to a plant with a
// care action ("water"/"fertilize") — marking it done then also stamps that
// plant's record and history log (see completeRoutine in helpers.jsx).

// Shared by the add + edit modals: pick a plant and what completing the
// routine does to it.
function RoutinePlantLink({ plants, plantId, careAction, onChange }) {
  return (
    <React.Fragment>
      <label>
        Linked plant (optional)
        <select
          value={plantId == null ? "" : String(plantId)}
          onChange={(e) => onChange({ plantId: e.target.value ? Number(e.target.value) : null, careAction })}
        >
          <option value="">None</option>
          {plants.map((p) => (
            <option key={p.id} value={String(p.id)}>{p.name || `Plant #${p.id}`}</option>
          ))}
        </select>
      </label>
      {plantId != null && (
        <label>
          When marked done
          <select value={careAction || ""} onChange={(e) => onChange({ plantId, careAction: e.target.value })}>
            <option value="">Just log the routine</option>
            <option value="water">Also mark plant watered</option>
            <option value="fertilize">Also mark plant fertilized</option>
          </select>
        </label>
      )}
    </React.Fragment>
  );
}

function AddRoutineModal({ onClose, onAdded }) {
  const [task, setTask] = useState("");
  const [intervalDays, setIntervalDays] = useState(3);
  const [plants, setPlants] = useState([]);
  const [link, setLink] = useState({ plantId: null, careAction: "" });
  const [tags, setTags] = useState([]);

  useEffect(() => {
    getAllPlants().then(setPlants);
  }, []);

  async function save() {
    if (!task.trim()) return;
    await addRoutine({
      task: task.trim(),
      intervalDays: Number(intervalDays) || 1,
      plantId: link.plantId,
      careAction: link.plantId != null ? link.careAction : "",
      tags: normTags(tags),
    });
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
        <RoutinePlantLink plants={plants} plantId={link.plantId} careAction={link.careAction} onChange={setLink} />
        <TagPicker presets={PRESET_TAGS.routines} tags={tags} onChange={setTags} />
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RoutineDetail({ routine, onBack, onChanged, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [plants, setPlants] = useState([]);
  const [form, setForm] = useState({
    task: routine.task || "",
    intervalDays: routine.intervalDays || 1,
    plantId: routine.plantId != null ? routine.plantId : null,
    careAction: routine.careAction || "",
    tags: routine.tags || [],
  });

  useEffect(() => {
    getAllPlants().then(setPlants);
  }, []);

  const due = isRoutineDue(routine);
  const linkedPlant = plants.find((p) => p.id === routine.plantId) || null;

  async function markDone() {
    await completeRoutine(routine);
    onChanged();
  }

  async function saveForm() {
    await updateRoutine({
      ...routine,
      task: form.task,
      intervalDays: Number(form.intervalDays) || 1,
      plantId: form.plantId,
      careAction: form.plantId != null ? form.careAction : "",
      tags: normTags(form.tags),
    });
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
        <button className="icon-btn" onClick={() => setEditing(true)} title="Edit"><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        <div className="fact-chips">
          <span className="chip"><i className="bi bi-arrow-repeat"></i> every {routine.intervalDays} day{routine.intervalDays === 1 ? "" : "s"}</span>
          <span className="chip"><i className="bi bi-check2-circle"></i> {routine.lastDone ? `done ${timeAgo(routine.lastDone)}` : "never done"}</span>
          {due && <span className="chip due"><i className="bi bi-exclamation-circle"></i> Due now</span>}
          <TagChips tags={routine.tags} />
        </div>

        {linkedPlant && (
          <div className="linked-section">
            <h3>Linked plant</h3>
            <button className="linked-row" onClick={() => onNavigate("garden", { itemId: linkedPlant.id })}>
              <i className="bi bi-flower3"></i>
              <span>{linkedPlant.name}</span>
              {routine.careAction && (
                <span className="linked-sub">
                  marks {routine.careAction === "water" ? "watered" : "fertilized"} when done
                </span>
              )}
              <i className="bi bi-chevron-right"></i>
            </button>
          </div>
        )}

        <div className="item-quick-actions">
          <button className="btn small" onClick={markDone}><i className="bi bi-check2"></i> Mark done</button>
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
            <RoutinePlantLink
              plants={plants}
              plantId={form.plantId}
              careAction={form.careAction}
              onChange={(link) => setForm({ ...form, ...link })}
            />
            <TagPicker
              presets={PRESET_TAGS.routines}
              tags={form.tags}
              onChange={(tags) => setForm({ ...form, tags })}
            />
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

function RoutinesView({ initialId, onNavigate }) {
  const [routines, setRoutines] = useState([]);
  const [selectedId, setSelectedId] = useState(initialId || null);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTag, setActiveTag] = useState(null);

  async function refresh() {
    setRoutines(await getAllRoutines());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = routines.find((r) => r.id === selectedId) || null;
  const visible = activeTag ? routines.filter((r) => (r.tags || []).includes(activeTag)) : routines;

  if (selected) {
    return (
      <RoutineDetail
        routine={selected}
        onBack={() => setSelectedId(null)}
        onChanged={refresh}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <h2><i className="bi bi-arrow-repeat"></i> Routines</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add routine"><i className="bi bi-plus-lg"></i></button>
      </div>
      <TagFilterBar items={routines} activeTag={activeTag} onSelect={setActiveTag} />
      <div className="item-grid">
        {routines.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-arrow-repeat"></i>
            <p>No routines yet — tap + to add a recurring task, or ask Sprout to set one up.</p>
          </div>
        )}
        {visible.length === 0 && routines.length > 0 && (
          <p className="empty-hint">No routines tagged "{activeTag}".</p>
        )}
        {visible.map((r) => {
          const due = isRoutineDue(r);
          return (
            <button key={r.id} className={due ? "item-card due" : "item-card"} onClick={() => setSelectedId(r.id)}>
              <div className="item-card-placeholder"><i className="bi bi-arrow-repeat"></i></div>
              <span className="item-card-title">{r.task || "Untitled routine"}</span>
              <span className="item-card-sub">
                every {r.intervalDays}d · {r.lastDone ? timeAgo(r.lastDone) : "never done"}
              </span>
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
