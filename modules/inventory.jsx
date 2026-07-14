// Inventory module: tools/supplies as a card grid, each with a photo-capable,
// info-rich detail page (brand, condition, storage location, purchase date,
// price, last used). Editable via chat too (ADD_TOOL/UPDATE_TOOL/REMOVE_TOOL
// in helpers.jsx).

const TOOL_CONDITIONS = ["", "new", "good", "worn", "needs repair", "broken"];

// Shared field block for the add + edit modals.
function ToolFields({ form, setForm }) {
  return (
    <React.Fragment>
      <label>
        Name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pruning shears, Neem oil" />
      </label>
      <label>
        Quantity
        <input type="number" min="0" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
      </label>
      <label>
        Brand (optional)
        <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="e.g. Fiskars" />
      </label>
      <label>
        Condition
        <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>
          {TOOL_CONDITIONS.map((c) => (
            <option key={c} value={c}>{c === "" ? "—" : c}</option>
          ))}
        </select>
      </label>
      <label>
        Stored in (optional)
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. garden shed, top shelf" />
      </label>
      <label>
        Purchase date (optional)
        <input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
      </label>
      <label>
        Price (optional)
        <input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.00" />
      </label>
      <label>
        Notes
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="optional" />
      </label>
      <TagPicker presets={PRESET_TAGS.tools} tags={form.tags} onChange={(tags) => setForm({ ...form, tags })} />
    </React.Fragment>
  );
}

function emptyToolForm() {
  return { name: "", quantity: 1, brand: "", condition: "", location: "", purchaseDate: "", price: "", notes: "", tags: [] };
}

function toolFromForm(form) {
  return {
    name: form.name.trim(),
    quantity: Number(form.quantity) || 0,
    brand: form.brand.trim(),
    condition: form.condition,
    location: form.location.trim(),
    purchaseDate: form.purchaseDate,
    price: form.price === "" ? null : Number(form.price),
    notes: form.notes,
    tags: normTags(form.tags),
  };
}

function AddToolModal({ onClose, onAdded }) {
  const [form, setForm] = useState(emptyToolForm());

  async function save() {
    if (!form.name.trim()) return;
    await addTool(toolFromForm(form));
    ensureCodexResearch("tool", form.name.trim()); // background codex entry with sources
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add tool / supply</h2>
        <ToolFields form={form} setForm={setForm} />
        <div className="modal-actions">
          <button className="btn" onClick={save} disabled={!form.name.trim()}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ToolDetail({ tool, onBack, onChanged, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPhotoRemove, setConfirmPhotoRemove] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [form, setForm] = useState({
    name: tool.name || "",
    quantity: tool.quantity != null ? tool.quantity : 1,
    brand: tool.brand || "",
    condition: tool.condition || "",
    location: tool.location || "",
    purchaseDate: tool.purchaseDate || "",
    price: tool.price != null ? tool.price : "",
    notes: tool.notes || "",
    tags: tool.tags || [],
  });
  const fileInputRef = useRef(null); // gallery / files
  const cameraInputRef = useRef(null); // forces the camera

  async function saveForm() {
    await updateTool({ ...tool, ...toolFromForm(form) });
    setEditing(false);
    onChanged();
  }

  // One-tap +/- so "used one up" doesn't require opening the edit form.
  async function bumpQuantity(delta) {
    const next = Math.max(0, (Number(tool.quantity) || 0) + delta);
    await updateTool({ ...tool, quantity: next });
    onChanged();
  }

  async function markUsed() {
    await updateTool({ ...tool, lastUsed: Date.now() });
    onChanged();
  }

  // Photo: camera or gallery (no capture attribute → the OS shows a chooser).
  async function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const dataUrl = await resizeImageToDataUrl(file, 800, 0.75);
    await updateTool({ ...tool, photoThumb: dataUrl });
    onChanged();
  }

  async function removePhoto() {
    await updateTool({ ...tool, photoThumb: null });
    setConfirmPhotoRemove(false);
    onChanged();
  }

  async function remove() {
    await deleteTool(tool.id);
    setConfirmDelete(false);
    onBack();
    onChanged();
  }

  function askSprout() {
    onNavigate("chat", { draft: `About "${tool.name}" in my garden supplies: how and when should I use it?` });
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{tool.name || "Unnamed item"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)} title="Edit"><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        {tool.photoThumb ? (
          <button className="detail-hero" onClick={() => setLightbox(true)}>
            <img src={tool.photoThumb} alt={tool.name} />
          </button>
        ) : (
          <div className="detail-hero placeholder"><i className="bi bi-tools"></i></div>
        )}

        <div className="fact-chips">
          <span className="chip qty-chip">
            <button className="qty-btn" onClick={() => bumpQuantity(-1)} title="One less"><i className="bi bi-dash"></i></button>
            <span><i className="bi bi-boxes"></i> {tool.quantity}</span>
            <button className="qty-btn" onClick={() => bumpQuantity(1)} title="One more"><i className="bi bi-plus"></i></button>
          </span>
          {tool.brand && <span className="chip"><i className="bi bi-award"></i> {tool.brand}</span>}
          {tool.condition && <span className="chip"><i className="bi bi-heart-pulse"></i> {tool.condition}</span>}
          {tool.location && <span className="chip"><i className="bi bi-geo-alt"></i> {tool.location}</span>}
          {tool.purchaseDate && <span className="chip"><i className="bi bi-bag"></i> bought {tool.purchaseDate}</span>}
          {tool.price != null && tool.price !== "" && <span className="chip"><i className="bi bi-cash"></i> {tool.price}</span>}
          <span className="chip"><i className="bi bi-hand-index"></i> used {timeAgo(tool.lastUsed)}</span>
          <span className="chip"><i className="bi bi-calendar3"></i> added {tool.createdAt ? timeAgo(tool.createdAt) : "unknown"}</span>
          <TagChips tags={tool.tags} />
        </div>
        {tool.notes && <div className="item-notes"><i className="bi bi-journal-text"></i> {tool.notes}</div>}

        <div className="item-quick-actions">
          <button className="btn small" onClick={markUsed}><i className="bi bi-hand-index"></i> Mark used</button>
          <button className="btn small" onClick={() => cameraInputRef.current.click()}>
            <i className="bi bi-camera"></i> Camera
          </button>
          <button className="btn small" onClick={() => fileInputRef.current.click()}>
            <i className="bi bi-images"></i> Gallery
          </button>
          {tool.photoThumb && (
            <button className="btn btn-ghost small" onClick={() => setConfirmPhotoRemove(true)}>
              <i className="bi bi-x-circle"></i> Remove photo
            </button>
          )}
          <button className="btn btn-ghost small" onClick={askSprout}><i className="bi bi-chat-dots"></i> Ask Sprout</button>
          <button className="btn btn-ghost small" onClick={() => onNavigate("codex", { query: tool.name })}>
            <i className="bi bi-book"></i> Codex
          </button>
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
      </div>

      {lightbox && tool.photoThumb && (
        <ImageLightbox src={tool.photoThumb} caption={tool.name} onClose={() => setLightbox(false)} />
      )}

      {confirmPhotoRemove && (
        <ConfirmModal
          title="Remove photo?"
          message={`Remove the photo from "${tool.name}"?`}
          confirmLabel="Remove"
          onConfirm={removePhoto}
          onCancel={() => setConfirmPhotoRemove(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete item?"
          message={`Remove "${tool.name || "this item"}" from your inventory?`}
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit item</h2>
            <ToolFields form={form} setForm={setForm} />
            <div className="modal-actions">
              <button className="btn" onClick={saveForm} disabled={!form.name.trim()}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            <hr />
            <button className="btn btn-danger" onClick={() => { setEditing(false); setConfirmDelete(true); }}>
              Delete item
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function InventoryView({ initialId, onNavigate }) {
  const [tools, setTools] = useState([]);
  const [selectedId, setSelectedId] = useState(initialId || null);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTag, setActiveTag] = useState(null);
  const [section, setSection] = useState("items"); // items | toget
  const [shopping, setShopping] = useState([]);
  const [newToGet, setNewToGet] = useState("");

  async function refresh() {
    setTools(await getAllTools());
  }
  async function refreshShopping() {
    setShopping(await getAllShoppingItems());
  }
  useEffect(() => {
    refresh();
    refreshShopping();
  }, []);

  const selected = tools.find((t) => t.id === selectedId) || null;
  const visible = activeTag ? tools.filter((t) => (t.tags || []).includes(activeTag)) : tools;
  const openCount = shopping.filter((s) => !s.done).length;

  async function addToGet() {
    const n = newToGet.trim();
    if (!n) return;
    await addShoppingItem({ name: n });
    setNewToGet("");
    refreshShopping();
  }
  async function toggleToGet(s) {
    await updateShoppingItem({ ...s, done: !s.done });
    refreshShopping();
  }
  async function removeToGet(s) {
    await deleteShoppingItem(s.id);
    refreshShopping();
  }
  // Bought it → it becomes a real inventory item (and gets codex research).
  async function moveToInventory(s) {
    await addTool({ name: s.name, quantity: s.quantity || 1, notes: s.notes || "", tags: [] });
    ensureCodexResearch("tool", s.name);
    await deleteShoppingItem(s.id);
    refreshShopping();
    refresh();
  }

  if (selected) {
    return (
      <ToolDetail
        tool={selected}
        onBack={() => setSelectedId(null)}
        onChanged={refresh}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <h2><i className="bi bi-box-seam"></i> Inventory</h2>
        {section === "items" && (
          <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add item"><i className="bi bi-plus-lg"></i></button>
        )}
      </div>

      <div className="tag-filter-bar">
        <button className={section === "items" ? "tag-chip active" : "tag-chip"} onClick={() => setSection("items")}>
          Items
        </button>
        <button className={section === "toget" ? "tag-chip active" : "tag-chip"} onClick={() => setSection("toget")}>
          To get{openCount > 0 ? ` (${openCount})` : ""}
        </button>
      </div>

      {section === "items" ? (
        <React.Fragment>
          <TagFilterBar items={tools} activeTag={activeTag} onSelect={setActiveTag} />
          <div className="item-grid">
            {tools.length === 0 && (
              <div className="empty-state">
                <i className="bi bi-box-seam"></i>
                <p>No tools or supplies yet — tap + to add one, or tell Sprout what you bought.</p>
              </div>
            )}
            {visible.length === 0 && tools.length > 0 && (
              <p className="empty-hint">No items tagged "{activeTag}".</p>
            )}
            {visible.map((t) => (
              <button key={t.id} className="item-card" onClick={() => setSelectedId(t.id)}>
                {t.photoThumb ? (
                  <img src={t.photoThumb} alt={t.name} />
                ) : (
                  <div className="item-card-placeholder"><i className="bi bi-tools"></i></div>
                )}
                <span className="item-card-title">{t.name || "Unnamed item"}</span>
                <span className="item-card-sub">
                  × {t.quantity}
                  {t.condition ? ` · ${t.condition}` : ""}
                </span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ) : (
        <div className="toget-panel">
          <div className="toget-add">
            <input
              className="text-input"
              placeholder="Add something to get…"
              value={newToGet}
              onChange={(e) => setNewToGet(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addToGet()}
            />
            <button className="btn btn-send" onClick={addToGet} disabled={!newToGet.trim()} title="Add">
              <i className="bi bi-plus-lg"></i>
            </button>
          </div>
          {shopping.length === 0 && (
            <div className="empty-state">
              <i className="bi bi-cart"></i>
              <p>Nothing to get — add items here, or tell Sprout "I need to buy…".</p>
            </div>
          )}
          {[...shopping]
            .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.id - a.id)
            .map((s) => (
              <div key={s.id} className={s.done ? "toget-row done" : "toget-row"}>
                <button className="toget-check" onClick={() => toggleToGet(s)} title={s.done ? "Uncheck" : "Check off"}>
                  <i className={s.done ? "bi bi-check-square-fill" : "bi bi-square"}></i>
                </button>
                <div className="toget-text">
                  <span className="toget-name">
                    {s.name}
                    {s.quantity > 1 ? ` ×${s.quantity}` : ""}
                  </span>
                  {s.notes && <span className="toget-notes">{s.notes}</span>}
                </div>
                {s.done && (
                  <button className="btn btn-ghost small" onClick={() => moveToInventory(s)} title="Move to inventory">
                    <i className="bi bi-box-seam"></i> To inventory
                  </button>
                )}
                <button className="icon-btn small" onClick={() => removeToGet(s)} title="Remove">
                  <i className="bi bi-trash"></i>
                </button>
              </div>
            ))}
        </div>
      )}

      {showAdd && (
        <AddToolModal
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
