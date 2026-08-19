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
  const [tags, setTags] = useState([]);
  useEscapeKey(onClose);

  async function save() {
    if (!name.trim()) return;
    await addPlant({ name: name.trim(), location, plantingDate, notes, tags: normTags(tags) });
    ensureCodexResearch("plant", name.trim()); // background codex entry with sources
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-plant-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-plant-modal-title">Add plant</h2>
        <label>
          Name / species
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tomato #1" />
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
        <TagPicker presets={PRESET_TAGS.plants} tags={tags} onChange={setTags} />
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Edit-form seed. Re-run when the edit modal OPENS so AI updates / care marks
// made after mount don't show up stale in the form.
function plantFormFrom(plant) {
  return {
    name: plant.name || "",
    location: plant.location || "",
    plantingDate: plant.plantingDate || "",
    notes: plant.notes || "",
    tags: plant.tags || [],
  };
}

// Photo timeline compare: pick any two entries from the plant's photo history
// and wipe between them. Additive — the history log itself is untouched.
//
// The two images are stacked in the same fixed box and the top one is revealed
// with clip-path rather than by resizing it. That's what keeps the wipe honest:
// both photos stay at identical size and position, so the divider lands on the
// same point of the plant in each, with no width measuring and no ref.
function PhotoCompareOverlay({ plant, photos, onClose }) {
  const [beforeIdx, setBeforeIdx] = useState(0);
  const [afterIdx, setAfterIdx] = useState(photos.length - 1);
  const [reveal, setReveal] = useState(50); // % of the frame showing the "before" photo
  const [lightbox, setLightbox] = useState(null); // { src, caption }
  useEscapeKey(onClose);

  if (!photos || photos.length < 2) return null; // nothing to compare against

  const before = photos[beforeIdx] || photos[0];
  const after = photos[afterIdx] || photos[photos.length - 1];
  const dateLabel = (p) => (p && p.date ? new Date(p.date).toLocaleDateString() : "undated");
  // Absolute, so picking a later "before" than "after" still reads sensibly.
  const daysApart =
    before.date && after.date
      ? Math.round(Math.abs(after.date - before.date) / (24 * 60 * 60 * 1000))
      : null;

  return (
    <React.Fragment>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal compare-modal" role="dialog" aria-modal="true" aria-labelledby="compare-modal-title" onClick={(e) => e.stopPropagation()}>
          <h2 id="compare-modal-title">Compare photos</h2>

          <div className="compare-stage">
            <img className="compare-img" src={after.imageThumb} alt={`After: ${dateLabel(after)}`} />
            <img
              className="compare-img compare-img-before"
              style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
              src={before.imageThumb}
              alt={`Before: ${dateLabel(before)}`}
            />
            <div className="compare-divider" style={{ left: `${reveal}%` }}></div>
            <span className="compare-tag left">{dateLabel(before)}</span>
            <span className="compare-tag right">{dateLabel(after)}</span>
            <input
              className="compare-range"
              type="range"
              min="0"
              max="100"
              step="1"
              value={reveal}
              onChange={(e) => setReveal(Number(e.target.value))}
              aria-label="Wipe between the two photos"
            />
          </div>

          <p className="compare-meta">
            <i className="bi bi-arrow-left-right" aria-hidden="true"></i>{" "}
            {daysApart === null
              ? "these entries have no dates"
              : daysApart === 0
              ? "same day"
              : `${daysApart} ${daysApart === 1 ? "day" : "days"} apart`}
          </p>

          <div className="compare-pickers">
            <label>
              Before
              <select value={beforeIdx} onChange={(e) => setBeforeIdx(Number(e.target.value))}>
                {photos.map((p, i) => (
                  <option key={i} value={i}>{dateLabel(p)}</option>
                ))}
              </select>
            </label>
            <label>
              After
              <select value={afterIdx} onChange={(e) => setAfterIdx(Number(e.target.value))}>
                {photos.map((p, i) => (
                  <option key={i} value={i}>{dateLabel(p)}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="modal-actions compare-actions">
            <button
              className="btn btn-ghost small"
              onClick={() => setLightbox({ src: before.imageThumb, caption: `${dateLabel(before)} — ${before.analysis || plant.name}` })}
            >
              <i className="bi bi-arrows-fullscreen" aria-hidden="true"></i> Before
            </button>
            <button
              className="btn btn-ghost small"
              onClick={() => setLightbox({ src: after.imageThumb, caption: `${dateLabel(after)} — ${after.analysis || plant.name}` })}
            >
              <i className="bi bi-arrows-fullscreen" aria-hidden="true"></i> After
            </button>
            <button className="btn small" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>

      {/* Sibling of the backdrop, not a child: inside it, the lightbox's own
          click-to-close would bubble up and shut the comparison too. */}
      {lightbox && (
        <ImageLightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}
    </React.Fragment>
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
  const [comparing, setComparing] = useState(false);
  const [form, setForm] = useState(plantFormFrom(plant));
  const fileInputRef = useRef(null); // gallery / files
  const cameraInputRef = useRef(null); // forces the camera

  // Unconditional (rules of hooks) — only actually closes anything while the
  // edit modal is open.
  useEscapeKey(() => editing && setEditing(false));

  useEffect(() => {
    (async () => {
      const routines = await getAllRoutines();
      setLinkedRoutines(routines.filter((r) => r.plantId === plant.id));
    })();
  }, [plant.id]);

  const latestPhoto = (plant.photoHistory || []).filter((p) => p.imageThumb).slice(-1)[0];
  // Cover (set by the AI via SET_COVER) wins over the newest gallery photo.
  const heroSrc = plant.coverThumb || (latestPhoto && latestPhoto.imageThumb) || null;
  const heroCaption = plant.coverThumb ? plant.name : latestPhoto && latestPhoto.analysis;
  // Oldest → newest, so "before" and "after" default to the two ends of the
  // timeline. Sorted rather than trusted: care marks and AI notes are appended
  // to the same log, and an undated entry would otherwise land anywhere.
  const photoEntries = (plant.photoHistory || [])
    .filter((p) => p.imageThumb)
    .slice()
    .sort((a, b) => (a.date || 0) - (b.date || 0));

  async function saveForm() {
    await updatePlant({ ...plant, ...form, tags: normTags(form.tags) });
    setEditing(false);
    onChanged();
  }

  async function markWatered() {
    // withCareLogEntry: tapping repeatedly updates the timestamp but only
    // logs one "Watered" row per day — no more log spam.
    await updatePlant(withCareLogEntry({ ...plant, lastWatered: Date.now() }, "Watered", "water"));
    onChanged();
  }
  async function markFertilized() {
    await updatePlant(withCareLogEntry({ ...plant, lastFertilized: Date.now() }, "Fertilized", "fertilize"));
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

    // The photo is SAVED FIRST, before any AI call — adding pictures must
    // always work, even when the vision API is down. Analysis then fills in
    // the entry's text (or a plain "analysis unavailable" note on failure).
    let withPhoto;
    const entryDate = Date.now();
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const [, base64] = dataUrl.split(",");
      withPhoto = {
        ...plant,
        photoHistory: [
          ...(plant.photoHistory || []),
          { imageThumb: dataUrl, analysis: "Photo added — analyzing…", date: entryDate, kind: "photo" },
        ],
      };
      await updatePlant(withPhoto);
      onChanged();

      const prompt =
        `You are analyzing a photo of the user's plant "${plant.name}" ` +
        `(location: ${plant.location || "unknown"}, planted: ${plant.plantingDate || "unknown"}, ` +
        `current notes: ${plant.notes || "none"}). The user's device says it is now: ${deviceNow()}. ` +
        `Identify visible health issues and give care advice. ` +
        `If this photo suggests an update to this plant's record, end your reply with a new line formatted ` +
        `EXACTLY as (JSON on a single line): UPDATE_PLANT: {"id": ${plant.id}, "fields": {"notes": "..."}} — only include fields that ` +
        `should change, and only add this line if genuinely warranted. Never mention this line in your visible reply. ` +
        `You may also add one line FOLLOWUP: ["short question 1", "short question 2"] — 2-3 short questions the user ` +
        `might want to ask next, in the user's voice.`;

      const data = await apiFetch("/api/vision", { imageBase64: base64, mimeType: "image/jpeg", prompt });
      const { cleanText, actions } = extractActions(data.reply || "");
      // The log entry shows plain analysis text — strip the hidden lines.
      const { cleanText: analysisText } = extractFollowups(extractStatus(cleanText).cleanText);

      const analyzed = {
        ...withPhoto,
        photoHistory: withPhoto.photoHistory.map((h) =>
          h.date === entryDate ? { ...h, analysis: analysisText || "Photo added" } : h
        ),
      };
      await updatePlant(analyzed);
      onChanged();

      // Photo analysis for an existing plant should only ever propose an
      // update to THIS plant, not add a new one — force id-based targeting.
      const updates = actions.filter((a) => a.type === "update");
      for (const action of updates) {
        // Same schema guard the chat path gets (sanitizeActionFields lives in
        // helpers.jsx). This path writes fields straight onto the record, so an
        // invented column ("soilPh", "harvestedOn") would otherwise persist
        // forever and be read back out of the snapshot as if it were real.
        const { fields } = sanitizeActionFields("update", action.fields || {});
        if (!Object.keys(fields).length) continue;
        if (getAiWriteMode() === "confirm") {
          setPendingActions((prev) => [...prev, { type: "update_plant", plant: analyzed, fields }]);
        } else {
          await applyPlantUpdate(analyzed, fields);
          onChanged();
        }
      }
    } catch (e) {
      // Keep the photo; just mark that analysis didn't happen.
      if (withPhoto) {
        const kept = {
          ...withPhoto,
          photoHistory: withPhoto.photoHistory.map((h) =>
            h.date === entryDate ? { ...h, analysis: "Photo added (AI analysis unavailable)" } : h
          ),
        };
        await updatePlant(kept).catch(() => {});
        onChanged();
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // "Last watered" and "where is it" are the two facts that answer the only
  // question this page is really asked — does this plant need me right now.
  // They lead. Everything else is reference material and lives one tap down,
  // in Details, rather than as another row of chips under the photo.
  const secondaryFacts = [
    plant.location ? null : { icon: "bi-geo-alt", label: "no location set" },
    { icon: "bi-calendar3", label: `planted ${plant.plantingDate || "unknown"}` },
    { icon: "bi-flower2", label: `fertilized ${timeAgo(plant.lastFertilized)}` },
  ].filter(Boolean);

  const historyEntries = (plant.photoHistory || []).slice().reverse(); // newest first
  // A log of three or fewer is not a wall — leave it open. Past that it is the
  // longest thing on the page, so it starts closed with its count on the label.
  const historyStartsOpen = historyEntries.length <= 3;

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><i className="bi bi-arrow-left" aria-hidden="true"></i></button>
        <h2>{plant.name || "Unnamed plant"}</h2>
        <button
          className="icon-btn"
          onClick={() => {
            setForm(plantFormFrom(plant)); // re-seed with any changes since mount
            setEditing(true);
          }}
          title="Edit"
          aria-label="Edit"
        >
          <i className="bi bi-pencil" aria-hidden="true"></i>
        </button>
      </div>

      <div className="item-detail">
        {heroSrc ? (
          <button className="detail-hero" onClick={() => setLightbox({ src: heroSrc, caption: heroCaption })}>
            <img src={heroSrc} alt={plant.name} />
          </button>
        ) : (
          <div className="detail-hero placeholder"><i className="bi bi-flower3" aria-hidden="true"></i></div>
        )}

        <div className="detail-lede">
          <span className="detail-lede-main">
            <i className="bi bi-droplet" aria-hidden="true"></i> Watered {timeAgo(plant.lastWatered)}
          </span>
          {plant.location && (
            <span className="detail-lede-sub"><i className="bi bi-geo-alt" aria-hidden="true"></i> {plant.location}</span>
          )}
        </div>
        {plant.notes && <div className="item-notes"><i className="bi bi-journal-text" aria-hidden="true"></i> {plant.notes}</div>}

        {/* One primary action (Watered), one secondary (Add photo), the rest
            behind ⋯. Six equal-weight buttons meant none of them was primary,
            and the two most-used ones were the hardest to hit. */}
        <div className="item-quick-actions">
          <button className="btn small" onClick={markWatered}><i className="bi bi-droplet" aria-hidden="true"></i> Watered</button>
          <GcOverflowMenu
            id={`plant-photo-sheet-${plant.id}`}
            className="btn btn-ghost small"
            title="Add a photo"
            label={busy ? "Analyzing…" : "Add photo"}
            icon="bi-camera"
            disabled={busy}
            items={[
              // Two hidden inputs, two code paths: only the camera one carries
              // capture="environment". Merging the BUTTONS doesn't merge those.
              { key: "camera", icon: "bi-camera", label: "Take a photo", onClick: () => cameraInputRef.current.click() },
              { key: "gallery", icon: "bi-images", label: "Choose from gallery", onClick: () => fileInputRef.current.click() },
            ]}
          />
          <GcOverflowMenu
            id={`plant-more-sheet-${plant.id}`}
            className="btn btn-ghost small"
            title="More actions"
            items={[
              { key: "fertilized", icon: "bi-flower2", label: "Mark fertilized", onClick: markFertilized },
              photoEntries.length >= 2 && {
                key: "compare",
                icon: "bi-layout-split",
                label: "Compare photos",
                onClick: () => setComparing(true),
              },
              { key: "ask", icon: "bi-chat-dots", label: "Ask Sprout", onClick: askSprout },
              { key: "codex", icon: "bi-book", label: "Look up in Codex", onClick: () => onNavigate("codex", { query: plant.name }) },
            ]}
          />
        </div>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onPhotoChosen}
        />

        {error && <div className="error-banner" role="alert">{error}</div>}
        <PendingActionsBanner
          actions={pendingActions}
          onResolve={(next) => {
            setPendingActions(next);
            onChanged();
          }}
        />

        <GcDisclosure id={`plant-details-${plant.id}`} label="Details" icon="bi-info-circle">
          <div className="fact-chips">
            {secondaryFacts.map((f, i) => (
              <span key={i} className="chip"><i className={`bi ${f.icon}`} aria-hidden="true"></i> {f.label}</span>
            ))}
            <TagChips tags={plant.tags} />
          </div>
        </GcDisclosure>

        {linkedRoutines.length > 0 && (
          <div className="linked-section">
            <h3>Care routines</h3>
            {linkedRoutines.map((r) => (
              <button key={r.id} className="linked-row" onClick={() => onNavigate("routines", { itemId: r.id })}>
                <i className="bi bi-arrow-repeat" aria-hidden="true"></i>
                <span>{r.task}</span>
                <span className="linked-sub">every {r.intervalDays}d</span>
                {isRoutineDue(r) && <span className="item-card-badge inline">Due</span>}
                <i className="bi bi-chevron-right" aria-hidden="true"></i>
              </button>
            ))}
          </div>
        )}

        {/* The single longest thing on this page. Collapsed once it passes a
            few entries, with the count on the control so closing it never
            hides the fact that there IS a history. */}
        <GcDisclosure
          id={`plant-history-${plant.id}`}
          label="History"
          icon="bi-clock-history"
          count={historyEntries.length}
          defaultOpen={historyStartsOpen}
        >
          {historyEntries.length === 0 ? (
            <p className="empty-hint">No log entries yet — tap "Add photo" above to start one.</p>
          ) : (
            <div className="log-list">
              {historyEntries.map((p, i) => (
                <div key={i} className="log-item">
                  {p.imageThumb && (
                    // A bare <img onClick> has no keyboard path — role=button +
                    // tabIndex + Enter/Space make it operable without changing
                    // the element (a wrapping <button> here would pick up
                    // default button chrome from styles.css we don't own).
                    <img
                      src={p.imageThumb}
                      alt={p.analysis || "Plant photo"}
                      role="button"
                      tabIndex={0}
                      onClick={() => setLightbox({ src: p.imageThumb, caption: p.analysis })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setLightbox({ src: p.imageThumb, caption: p.analysis });
                        }
                      }}
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
          )}
        </GcDisclosure>
      </div>

      {lightbox && (
        <ImageLightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}

      {comparing && (
        <PhotoCompareOverlay plant={plant} photos={photoEntries} onClose={() => setComparing(false)} />
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
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-plant-modal-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="edit-plant-modal-title">Edit plant</h2>
            <label>
              Name / species
              <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
            <TagPicker
              presets={PRESET_TAGS.plants}
              tags={form.tags}
              onChange={(tags) => setForm({ ...form, tags })}
            />
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
  const [activeTag, setActiveTag] = useState(null);

  async function refresh() {
    setPlants(await getAllPlants());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = plants.find((p) => p.id === selectedId) || null;
  const visible = activeTag ? plants.filter((p) => (p.tags || []).includes(activeTag)) : plants;

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
        <h2><i className="bi bi-flower3" aria-hidden="true"></i> Garden</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add plant" aria-label="Add plant"><i className="bi bi-plus-lg" aria-hidden="true"></i></button>
      </div>
      <TagFilterBar items={plants} activeTag={activeTag} onSelect={setActiveTag} />
      <div className="item-grid">
        {plants.length === 0 && (
          <div className="empty-state">
            <i className="bi bi-flower3" aria-hidden="true"></i>
            <p>No plants yet — tap + to add one, or just tell Sprout about a plant in chat.</p>
          </div>
        )}
        {visible.length === 0 && plants.length > 0 && (
          <p className="empty-hint">No plants tagged "{activeTag}".</p>
        )}
        {visible.map((p) => {
          const lastImg = (p.photoHistory || []).filter((h) => h.imageThumb).slice(-1)[0];
          const cardSrc = p.coverThumb || (lastImg && lastImg.imageThumb) || null;
          return (
            <button key={p.id} className="item-card" onClick={() => setSelectedId(p.id)}>
              {cardSrc ? (
                <img src={cardSrc} alt={p.name} />
              ) : (
                <div className="item-card-placeholder"><i className="bi bi-flower3" aria-hidden="true"></i></div>
              )}
              <span className="item-card-title">{p.name || "Unnamed plant"}</span>
              <span className="item-card-sub">
                {p.location ? `${p.location} · ` : ""}
                <i className="bi bi-droplet" aria-hidden="true"></i> {timeAgo(p.lastWatered)}
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
