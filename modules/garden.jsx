// Garden module: plants as a card grid, each with its own detail page,
// photo-based AI analysis, and a chronological history log (photos,
// waterings, fertilizings, and AI-driven notes all share the same log).
// Cross-module links: "Ask Sprout" jumps to chat with a prefilled question,
// and routines linked to a plant are listed on its detail page.

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

function PlantDetail({ plant, onBack, onChanged, onNavigate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkedRoutines, setLinkedRoutines] = useState([]);
  const [lightbox, setLightbox] = useState(null); // { src, caption }
  const [form, setForm] = useState({
    name: plant.name || "",
    location: plant.location || "",
    plantingDate: plant.plantingDate || "",
    notes: plant.notes || "",
  });
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      const routines = await getAllRoutines();
      setLinkedRoutines(routines.filter((r) => r.plantId === plant.id));
    })();
  }, [plant.id]);

  const latestPhoto = (plant.photoHistory || []).filter((p) => p.imageThumb).slice(-1)[0];

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

  function askSprout() {
    onNavigate("chat", {
      draft: `About my plant "${plant.name}"${plant.location ? ` (${plant.location})` : ""}: `,
    });
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
        `current notes: ${plant.notes || "none"}). Today's date is ${new Date().toDateString()}. ` +
        `Identify visible health issues and give care advice. ` +
        `If this photo suggests an update to this plant's record, end your reply with a new line formatted ` +
        `EXACTLY as (JSON on a single line): UPDATE_PLANT: {"id": ${plant.id}, "fields": {"notes": "..."}} — only include fields that ` +
        `should change, and only add this line if genuinely warranted. Never mention this line in your visible reply.`;

      const data = await apiFetch("/api/vision", { imageBase64: base64, mimeType: "image/jpeg", prompt });
      const { cleanText, actions } = extractActions(data.reply || "");

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
      const updates = actions.filter((a) => a.type === "update");
      for (const action of updates) {
        const fields = action.fields || {};
        if (getAiWriteMode() === "confirm") {
          setPendingActions((prev) => [...prev, { type: "update_plant", plant: updatedPlant, fields }]);
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

  const facts = [
    { icon: "bi-geo-alt", label: plant.location || "no location set" },
    { icon: "bi-calendar3", label: `planted ${plant.plantingDate || "unknown"}` },
    { icon: "bi-droplet", label: `watered ${timeAgo(plant.lastWatered)}` },
    { icon: "bi-flower2", label: `fertilized ${timeAgo(plant.lastFertilized)}` },
  ];

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{plant.name || "Unnamed plant"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)} title="Edit"><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        {latestPhoto ? (
          <button className="detail-hero" onClick={() => setLightbox({ src: latestPhoto.imageThumb, caption: latestPhoto.analysis })}>
            <img src={latestPhoto.imageThumb} alt={plant.name} />
          </button>
        ) : (
          <div className="detail-hero placeholder"><i className="bi bi-flower3"></i></div>
        )}

        <div className="fact-chips">
          {facts.map((f, i) => (
            <span key={i} className="chip"><i className={`bi ${f.icon}`}></i> {f.label}</span>
          ))}
        </div>
        {plant.notes && <div className="item-notes"><i className="bi bi-journal-text"></i> {plant.notes}</div>}

        <div className="item-quick-actions">
          <button className="btn small" onClick={markWatered}><i className="bi bi-droplet"></i> Watered</button>
          <button className="btn small" onClick={markFertilized}><i className="bi bi-flower2"></i> Fertilized</button>
          <button className="btn small" onClick={() => fileInputRef.current.click()} disabled={busy}>
            <i className="bi bi-camera"></i> {busy ? "Analyzing…" : "Add photo"}
          </button>
          <button className="btn btn-ghost small" onClick={askSprout}><i className="bi bi-chat-dots"></i> Ask Sprout</button>
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
        <PendingActionsBanner
          actions={pendingActions}
          onResolve={(next) => {
            setPendingActions(next);
            onChanged();
          }}
        />

        {linkedRoutines.length > 0 && (
          <div className="linked-section">
            <h3>Care routines</h3>
            {linkedRoutines.map((r) => (
              <button key={r.id} className="linked-row" onClick={() => onNavigate("routines", { itemId: r.id })}>
                <i className="bi bi-arrow-repeat"></i>
                <span>{r.task}</span>
                <span className="linked-sub">every {r.intervalDays}d</span>
                {isRoutineDue(r) && <span className="item-card-badge inline">Due</span>}
                <i className="bi bi-chevron-right"></i>
              </button>
            ))}
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
                {p.imageThumb && (
                  <img
                    src={p.imageThumb}
                    alt=""
                    onClick={() => setLightbox({ src: p.imageThumb, caption: p.analysis })}
                  />
                )}
                <div>
                  <div className="log-date">
                    {new Date(p.date).toLocaleDateString()} <span className={`log-kind ${p.kind || "photo"}`}>{p.kind || "photo"}</span>
                  </div>
                  <div className="log-text">{p.analysis}</div>
                </div>
              </div>
            ))}
        </div>
      </div>

      {lightbox && (
        <ImageLightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}

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
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={saveForm}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            <hr />
            <button className="btn btn-danger" onClick={() => { setEditing(false); setConfirmDelete(true); }}>
              Delete plant
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GardenView({ initialId, onNavigate }) {
  const [plants, setPlants] = useState([]);
  const [selectedId, setSelectedId] = useState(initialId || null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setPlants(await getAllPlants());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = plants.find((p) => p.id === selectedId) || null;

  if (selected) {
    return (
      <PlantDetail
        plant={selected}
        onBack={() => setSelectedId(null)}
        onChanged={refresh}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <h2><i className="bi bi-flower3"></i> Garden</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add plant"><i className="bi bi-plus-lg"></i></button>
      </div>
      <div className="item-grid">
        {plants.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-flower3"></i>
            <p>No plants yet — tap + to add one, or just tell Sprout about a plant in chat.</p>
          </div>
        )}
        {plants.map((p) => {
          const lastImg = (p.photoHistory || []).filter((h) => h.imageThumb).slice(-1)[0];
          return (
            <button key={p.id} className="item-card" onClick={() => setSelectedId(p.id)}>
              {lastImg ? (
                <img src={lastImg.imageThumb} alt={p.name} />
              ) : (
                <div className="item-card-placeholder"><i className="bi bi-flower3"></i></div>
              )}
              <span className="item-card-title">{p.name || "Unnamed plant"}</span>
              <span className="item-card-sub">
                {p.location ? `${p.location} · ` : ""}
                <i className="bi bi-droplet"></i> {timeAgo(p.lastWatered)}
              </span>
            </button>
          );
        })}
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
