// Inventory module: tools/supplies as a card grid, each with its own detail
// page. Can also be edited via chat (see ADD_TOOL/UPDATE_TOOL/REMOVE_TOOL in
// helpers.jsx).

function AddToolModal({ onClose, onAdded }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState([]);

  async function save() {
    if (!name.trim()) return;
    await addTool({ name: name.trim(), quantity: Number(quantity) || 1, notes, tags: normTags(tags) });
    ensureCodexResearch("tool", name.trim()); // background codex entry with sources
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add tool / supply</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pruning shears, Neem oil" />
        </label>
        <label>
          Quantity
          <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
        <TagPicker presets={PRESET_TAGS.tools} tags={tags} onChange={setTags} />
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ToolDetail({ tool, onBack, onChanged, onNavigate }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    name: tool.name || "",
    quantity: tool.quantity || 1,
    notes: tool.notes || "",
    tags: tool.tags || [],
  });

  async function saveForm() {
    await updateTool({ ...tool, ...form, quantity: Number(form.quantity) || 1, tags: normTags(form.tags) });
    setEditing(false);
    onChanged();
  }

  // One-tap +/- so "used one up" doesn't require opening the edit form.
  async function bumpQuantity(delta) {
    const next = Math.max(0, (Number(tool.quantity) || 0) + delta);
    await updateTool({ ...tool, quantity: next });
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
        <div className="fact-chips">
          <span className="chip qty-chip">
            <button className="qty-btn" onClick={() => bumpQuantity(-1)} title="One less"><i className="bi bi-dash"></i></button>
            <span><i className="bi bi-boxes"></i> {tool.quantity}</span>
            <button className="qty-btn" onClick={() => bumpQuantity(1)} title="One more"><i className="bi bi-plus"></i></button>
          </span>
          <span className="chip"><i className="bi bi-calendar3"></i> added {tool.createdAt ? timeAgo(tool.createdAt) : "unknown"}</span>
          <TagChips tags={tool.tags} />
        </div>
        {tool.notes && <div className="item-notes"><i className="bi bi-journal-text"></i> {tool.notes}</div>}

        <div className="item-quick-actions">
          <button className="btn btn-ghost small" onClick={askSprout}><i className="bi bi-chat-dots"></i> Ask Sprout</button>
          <button className="btn btn-ghost small" onClick={() => onNavigate("codex", { query: tool.name })}>
            <i className="bi bi-book"></i> Codex
          </button>
          <button className="btn btn-danger small" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>

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
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Quantity
              <input type="number" min="0" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </label>
            <label>
              Notes
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <TagPicker
              presets={PRESET_TAGS.tools}
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

function InventoryView({ initialId, onNavigate }) {
  const [tools, setTools] = useState([]);
  const [selectedId, setSelectedId] = useState(initialId || null);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTag, setActiveTag] = useState(null);

  async function refresh() {
    setTools(await getAllTools());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = tools.find((t) => t.id === selectedId) || null;
  const visible = activeTag ? tools.filter((t) => (t.tags || []).includes(activeTag)) : tools;

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
        <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add item"><i className="bi bi-plus-lg"></i></button>
      </div>
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
            <div className="item-card-placeholder"><i className="bi bi-tools"></i></div>
            <span className="item-card-title">{t.name || "Unnamed item"}</span>
            <span className="item-card-sub">× {t.quantity}</span>
          </button>
        ))}
      </div>
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
