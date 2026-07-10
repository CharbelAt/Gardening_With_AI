// Garden module: plants as a card grid, each with its own detail page,
// photo-based AI analysis, and a chronological history log (photos,
// waterings, fertilizings, and AI-driven notes all share the same log).

function AddPlantModal({ onClose, onAdded }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [plantingDate, setPlantingDate] = useState("");
  const [notes, setNotes] = useState("");

  async function save() {
    if (!name.trim()) return;
    await addPlant({ name: name.trim(), location, plantingDate, notes });
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add plant</h2>
        <label>
          Name / species
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tomato #1" />
        </label>
        <label>
          Location
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. backyard bed" />
        </label>
        <label>
          Planting date
          <input type="date" value={plantingDate} onChange={(e) => setPlantingDate(e.target.value)} />
        </label>
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PlantDetail({ plant, onBack, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    name: plant.name || "",
    location: plant.location || "",
    plantingDate: plant.plantingDate || "",
    notes: plant.notes || "",
  });
  const fileInputRef = useRef(null);

  async function saveForm() {
    await updatePlant({ ...plant, ...form });
    setEditing(false);
    onChanged();
  }

  async function markWatered() {
    await updatePlant(withLogEntry({ ...plant, lastWatered: Date.now() }, "Watered", "water"));
    onChanged();
  }
  async function markFertilized() {
    await updatePlant(withLogEntry({ ...plant, lastFertilized: Date.now() }, "Fertilized", "fertilize"));
    onChanged();
  }

  async function removePlant() {
    await deletePlant(plant.id);
    setConfirmDelete(false);
    onBack();
    onChanged();
  }

  async function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    setError("");
    setBusy(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const [, base64] = dataUrl.split(",");
      const prompt =
        `You are analyzing a photo of the user's plant "${plant.name}" ` +
        `(location: ${plant.location || "unknown"}, planted: ${plant.plantingDate || "unknown"}, ` +
        `current notes: ${plant.notes || "none"}). Identify visible health issues and give care advice. ` +
        `If this photo suggests an update to this plant's record, end your reply with a new line formatted ` +
        `EXACTLY as: UPDATE_PLANT: {"id": ${plant.id}, "fields": {"notes": "..."}} — only include fields that ` +
        `should change, and only add this line if genuinely warranted. Never mention this line in your visible reply.`;

      const data = await apiFetch("/api/vision", { imageBase64: base64, mimeType: "image/jpeg", prompt });
      const { cleanText, action } = extractPlantUpdate(data.reply || "");

      const updatedPlant = {
        ...plant,
        photoHistory: [
          ...(plant.photoHistory || []),
          { imageThumb: dataUrl, analysis: cleanText, date: Date.now(), kind: "photo" },
        ],
      };
      await updatePlant(updatedPlant);
      onChanged();

      // Photo analysis for an existing plant should only ever propose an
      // update to THIS plant, not add a new one — force id-based targeting.
      if (action && action.type === "update") {
        const fields = action.fields || {};
        if (getAiWriteMode() === "confirm") {
          setPendingUpdate({ plant: updatedPlant, fields });
        } else {
          await applyPlantUpdate(updatedPlant, fields);
          onChanged();
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPendingUpdate() {
    if (!pendingUpdate) return;
    await applyPlantUpdate(pendingUpdate.plant, pendingUpdate.fields);
    setPendingUpdate(null);
    onChanged();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{plant.name || "Unnamed plant"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)}><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        <div className="item-facts">
          <div><i className="bi bi-geo-alt"></i> {plant.location || "no location set"}</div>
          <div><i className="bi bi-calendar3"></i> planted {plant.plantingDate || "unknown"}</div>
          <div><i className="bi bi-droplet"></i> watered {plant.lastWatered ? new Date(plant.lastWatered).toLocaleDateString() : "never"}</div>
          <div><i className="bi bi-flower2"></i> fertilized {plant.lastFertilized ? new Date(plant.lastFertilized).toLocaleDateString() : "never"}</div>
          {plant.notes && <div className="item-notes"><i className="bi bi-journal-text"></i> {plant.notes}</div>}
        </div>

        <div className="item-quick-actions">
          <button className="btn small" onClick={markWatered}>Mark watered</button>
          <button className="btn small" onClick={markFertilized}>Mark fertilized</button>
          <button className="btn small" onClick={() => fileInputRef.current.click()} disabled={busy}>
            <i className="bi bi-camera"></i> {busy ? "Analyzing…" : "Add photo"}
          </button>
          <button className="btn btn-danger small" onClick={() => setConfirmDelete(true)}>Delete plant</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />

        {error && <div className="error-banner">{error}</div>}
        {pendingUpdate && (
          <div className="confirm-banner">
            <span>
              Update record: {Object.entries(pendingUpdate.fields).map(([k, v]) => `${k} → ${v}`).join(", ")}?
            </span>
            <div className="confirm-actions">
              <button className="btn small" onClick={confirmPendingUpdate}>Apply</button>
              <button className="btn btn-ghost small" onClick={() => setPendingUpdate(null)}>Dismiss</button>
            </div>
          </div>
        )}

        <h3>History</h3>
        {(!plant.photoHistory || plant.photoHistory.length === 0) && (
          <p className="empty-hint">No log entries yet — tap "Add photo" above to start one.</p>
        )}
        <div className="log-list">
          {(plant.photoHistory || [])
            .slice()
            .reverse()
            .map((p, i) => (
              <div key={i} className="log-item">
                {p.imageThumb && <img src={p.imageThumb} alt="" />}
                <div>
                  <div className="log-date">
                    {new Date(p.date).toLocaleDateString()} <span className="log-kind">{p.kind || "photo"}</span>
                  </div>
                  <div className="log-text">{p.analysis}</div>
                </div>
              </div>
            ))}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete plant?"
          message={`Delete "${plant.name || "this plant"}" and its full history? This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={removePlant}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit plant</h2>
            <label>
              Name / species
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Location
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </label>
            <label>
              Planting date
              <input
                type="date"
                value={form.plantingDate}
                onChange={(e) => setForm({ ...form, plantingDate: e.target.value })}
              />
            </label>
            <label>
              Notes
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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

function GardenView({ onBack }) {
  const [plants, setPlants] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setPlants(await getAllPlants());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = plants.find((p) => p.id === selectedId) || null;

  if (selected) {
    return <PlantDetail plant={selected} onBack={() => setSelectedId(null)} onChanged={refresh} />;
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Garden</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)}><i className="bi bi-plus-lg"></i></button>
      </div>
      <div className="item-grid">
        {plants.length === 0 && <p className="empty-hint">No plants yet — tap + to add one.</p>}
        {plants.map((p) => (
          <button key={p.id} className="item-card" onClick={() => setSelectedId(p.id)}>
            {p.photoHistory && p.photoHistory.length > 0 ? (
              <img src={p.photoHistory[p.photoHistory.length - 1].imageThumb} alt={p.name} />
            ) : (
              <div className="item-card-placeholder"><i className="bi bi-flower3"></i></div>
            )}
            <span>{p.name || "Unnamed plant"}</span>
            {p.location && <span className="item-card-sub">{p.location}</span>}
          </button>
        ))}
      </div>
      {showAdd && (
        <AddPlantModal
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
