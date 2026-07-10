// Inventory module: tools/supplies as a card grid, each with its own detail
// page. Can also be edited via chat (see ADD_TOOL/REMOVE_TOOL in helpers.jsx).

function AddToolModal({ onClose, onAdded }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  async function save() {
    if (!name.trim()) return;
    await addTool({ name: name.trim(), quantity: Number(quantity) || 1, notes });
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
        <div className="modal-actions">
          <button className="btn" onClick={save}>Add</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ToolDetail({ tool, onBack, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    name: tool.name || "",
    quantity: tool.quantity || 1,
    notes: tool.notes || "",
  });

  async function saveForm() {
    await updateTool({ ...tool, ...form, quantity: Number(form.quantity) || 1 });
    setEditing(false);
    onChanged();
  }

  async function remove() {
    await deleteTool(tool.id);
    setConfirmDelete(false);
    onBack();
    onChanged();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>{tool.name || "Unnamed item"}</h2>
        <button className="icon-btn" onClick={() => setEditing(true)}><i className="bi bi-pencil"></i></button>
      </div>

      <div className="item-detail">
        <div className="item-facts">
          <div><i className="bi bi-boxes"></i> quantity: {tool.quantity}</div>
          <div><i className="bi bi-calendar3"></i> added {tool.createdAt ? new Date(tool.createdAt).toLocaleDateString() : "unknown"}</div>
          {tool.notes && <div className="item-notes"><i className="bi bi-journal-text"></i> {tool.notes}</div>}
        </div>

        <div className="item-quick-actions">
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
              <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
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

function InventoryView({ onBack }) {
  const [tools, setTools] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setTools(await getAllTools());
  }
  useEffect(() => {
    refresh();
  }, []);

  const selected = tools.find((t) => t.id === selectedId) || null;

  if (selected) {
    return <ToolDetail tool={selected} onBack={() => setSelectedId(null)} onChanged={refresh} />;
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Inventory</h2>
        <button className="icon-btn" onClick={() => setShowAdd(true)}><i className="bi bi-plus-lg"></i></button>
      </div>
      <div className="item-grid">
        {tools.length === 0 && <p className="empty-hint">No tools or supplies yet — tap + to add one.</p>}
        {tools.map((t) => (
          <button key={t.id} className="item-card" onClick={() => setSelectedId(t.id)}>
            <div className="item-card-placeholder"><i className="bi bi-tools"></i></div>
            <span>{t.name || "Unnamed item"}</span>
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
