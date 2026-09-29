// Inventory module: tools/supplies as a card grid, each with a photo-capable,
// info-rich detail page (brand, condition, storage location, purchase date,
// price, last used). Editable via chat too (ADD_TOOL/UPDATE_TOOL/REMOVE_TOOL
// in helpers.jsx).
//
// Item photos double as PRODUCT-LABEL SCANS: taking/choosing a picture on an
// item's page saves it as the item's cover first (it must survive an AI
// outage), then asks the vision model to read the label — product name, type,
// active ingredients, dosage, safety — and stores that as `productInfo`,
// rendered in a "Product info" section. The model may also propose an
// UPDATE_TOOL for fields it's confident about, which goes through the normal
// auto/confirm pipeline.

const TOOL_CONDITIONS = ["", "new", "good", "worn", "needs repair", "broken"];

// Shared field block for the add + edit modals.
function ToolFields({ form, setForm }) {
  return (
    <React.Fragment>
      <label>
        Name
        <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pruning shears, Neem oil" />
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

// Edit-form seed. Re-run every time the edit modal OPENS (not just at mount),
// so quantity bumps and AI updates made in between aren't shown stale.
function toolFormFrom(tool) {
  return {
    name: tool.name || "",
    quantity: tool.quantity != null ? tool.quantity : 1,
    brand: tool.brand || "",
    condition: tool.condition || "",
    location: tool.location || "",
    purchaseDate: tool.purchaseDate || "",
    price: tool.price != null ? tool.price : "",
    notes: tool.notes || "",
    tags: tool.tags || [],
  };
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
  useEscapeKey(onClose);

  async function save() {
    if (!form.name.trim()) return;
    await addTool(toolFromForm(form));
    ensureCodexResearch("tool", form.name.trim()); // background codex entry with sources
    onAdded();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-tool-modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-tool-modal-title">Add tool / supply</h2>
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
  const [busy, setBusy] = useState(false); // label analysis in flight
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState([]);
  // Product info is long AI prose, so it starts collapsed — except right after
  // a scan, when reading it IS the reason the photo was taken.
  const [productOpen, setProductOpen] = useState(false);
  const [form, setForm] = useState(toolFormFrom(tool));
  const fileInputRef = useRef(null); // gallery / files
  const cameraInputRef = useRef(null); // forces the camera

  // Hooks can't be called conditionally, so this always runs; it only ever
  // does something while the edit modal is actually open.
  useEscapeKey(() => editing && setEditing(false));

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

  // Photo: camera or gallery. The picture is the item's cover AND a product-
  // label scan. Same rule as plant photos: SAVE THE PHOTO FIRST, analyze
  // after — a picture must never be lost because the AI was down.
  async function onPhotoChosen(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    setError("");
    setBusy(true);
    let withPhoto = null;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 800, 0.75);
      const [, base64] = dataUrl.split(",");
      withPhoto = { ...tool, photoThumb: dataUrl };
      await updateTool(withPhoto);
      onChanged();

      const prompt =
        `You are Sprout, looking at a photo of one item in the user's garden inventory: ` +
        `"${tool.name}" (id: ${tool.id}, quantity: ${tool.quantity}, brand: ${tool.brand || "unknown"}, ` +
        `current notes: ${tool.notes || "none"}). The user's device says it is now: ${deviceNow()}. ` +
        `IF THE PHOTO SHOWS A PRODUCT LABEL (fungicide, fertilizer, pesticide, soil, seeds, or any ` +
        `packaged garden product), READ THE LABEL and report: product name, brand, what type of ` +
        `product it is, active ingredients, the dosage/mixing rate and how to apply it, and the key ` +
        `safety warnings. If it is a plain tool with no label, explain what the tool is and how and ` +
        `when to use it instead. Answer in 4-8 concise sentences (markdown allowed, no headings). ` +
        `IF THE LABEL IS BLURRY OR ONLY PARTLY READABLE: the big print (brand, product name, active ` +
        `ingredient, concentration) usually is readable — identify the product from it, look it up ` +
        `with web search if you have it, and give the rates from that, saying which parts you read ` +
        `and which you looked up. Only if not even the product name is readable, say so and ask for ` +
        `the brand and product name (not another photo).\n` +
        `You may end your reply with hidden lines — never mention them in your visible text:\n` +
        `UPDATE_TOOL: {"id": ${tool.id}, "fields": {"brand": "...", "tags": ["..."], "condition": "new|good|worn|needs repair", "notes": "..."}} ` +
        `— ONLY fields you are CONFIDENT about from the photo. "notes" REPLACES the old notes, so ` +
        `repeat the existing notes and append the new detail.\n` +
        `FOLLOWUP: ["short question 1", "short question 2"] — optional, 2-3 short questions the user ` +
        `might ask next, in the user's voice.`;

      const data = await apiFetch("/api/vision", { imageBase64: base64, mimeType: "image/jpeg", prompt });
      const { cleanText, actions } = extractActions(data.reply || "");
      const { cleanText: afterStatus } = extractStatus(cleanText);
      const { cleanText: info } = extractFollowups(afterStatus);

      await updateTool({
        ...withPhoto,
        productInfo: info || "No product details could be read from this photo.",
      });
      // A real label reading → look up the full instructions in the background
      // and save them to the Codex (helpers.jsx researchProductFromLabel).
      if (info && typeof ensureLabelResearch === "function") ensureLabelResearch(tool.id);
      setProductOpen(true); // the user just asked for this text — show it
      onChanged();

      // Photo analysis for THIS item may only ever update THIS item — force
      // id-based targeting so a confused model can't edit something else.
      const updates = actions
        .filter((a) => a.type === "update_tool")
        .map((a) => ({ ...a, id: tool.id }));
      await handleAiActions(updates, setPendingActions, {});
      onChanged();
    } catch (err) {
      // Keep the photo; just record that the analysis didn't happen.
      if (withPhoto) {
        await updateTool({ ...withPhoto, productInfo: "Photo saved (AI analysis unavailable)." }).catch(() => {});
        setProductOpen(true); // say so where the answer was going to appear
        onChanged();
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
        <button className="icon-btn" onClick={onBack} aria-label="Back"><i className="bi bi-arrow-left" aria-hidden="true"></i></button>
        <h2>{tool.name || "Unnamed item"}</h2>
        <button
          className="icon-btn"
          onClick={() => {
            setForm(toolFormFrom(tool)); // re-seed: quantity/AI changes since mount
            setEditing(true);
          }}
          title="Edit"
          aria-label="Edit"
        >
          <i className="bi bi-pencil" aria-hidden="true"></i>
        </button>
      </div>

      <div className="item-detail">
        {tool.photoThumb ? (
          <button className="detail-hero" onClick={() => setLightbox(true)}>
            <img src={tool.photoThumb} alt={tool.name} />
          </button>
        ) : (
          <div className="detail-hero placeholder"><i className="bi bi-tools" aria-hidden="true"></i></div>
        )}

        {/* How many left and what state it's in — the two facts you open an
            inventory item to check. The other seven chips moved into Details. */}
        <div className="detail-lede">
          <span className="chip qty-chip">
            <button className="qty-btn" onClick={() => bumpQuantity(-1)} title="One less" aria-label="One less"><i className="bi bi-dash" aria-hidden="true"></i></button>
            <span><i className="bi bi-boxes" aria-hidden="true"></i> {tool.quantity}</span>
            <button className="qty-btn" onClick={() => bumpQuantity(1)} title="One more" aria-label="One more"><i className="bi bi-plus" aria-hidden="true"></i></button>
          </span>
          {tool.condition && (
            <span className="detail-lede-sub"><i className="bi bi-heart-pulse" aria-hidden="true"></i> {tool.condition}</span>
          )}
        </div>
        {tool.notes && <div className="item-notes"><i className="bi bi-journal-text" aria-hidden="true"></i> {tool.notes}</div>}

        {/* One primary action (Mark used), one secondary (Add photo), the rest
            behind ⋯ — same shape as a plant's page, so the two detail screens
            teach each other. */}
        <div className="item-quick-actions">
          <button className="btn small" onClick={markUsed}><i className="bi bi-hand-index" aria-hidden="true"></i> Mark used</button>
          <GcOverflowMenu
            id={`tool-photo-sheet-${tool.id}`}
            className="btn btn-ghost small"
            title="Add a photo"
            label={busy ? "Analyzing…" : "Add photo"}
            icon="bi-camera"
            disabled={busy}
            items={[
              // Still two inputs and two code paths — only the camera one
              // carries capture="environment"; the sheet just picks which.
              { key: "camera", icon: "bi-camera", label: "Take a photo", onClick: () => cameraInputRef.current.click() },
              { key: "gallery", icon: "bi-images", label: "Choose from gallery", onClick: () => fileInputRef.current.click() },
            ]}
          />
          <GcOverflowMenu
            id={`tool-more-sheet-${tool.id}`}
            className="btn btn-ghost small"
            title="More actions"
            items={[
              { key: "ask", icon: "bi-chat-dots", label: "Ask Sprout", onClick: askSprout },
              { key: "codex", icon: "bi-book", label: "Look up in Codex", onClick: () => onNavigate("codex", { query: tool.name }) },
              tool.photoThumb && {
                key: "removephoto",
                icon: "bi-x-circle",
                label: "Remove photo",
                danger: true,
                onClick: () => setConfirmPhotoRemove(true),
              },
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

        <GcDisclosure id={`tool-details-${tool.id}`} label="Details" icon="bi-info-circle">
          <div className="fact-chips">
            {tool.brand && <span className="chip"><i className="bi bi-award" aria-hidden="true"></i> {tool.brand}</span>}
            {tool.location && <span className="chip"><i className="bi bi-geo-alt" aria-hidden="true"></i> {tool.location}</span>}
            {tool.purchaseDate && <span className="chip"><i className="bi bi-bag" aria-hidden="true"></i> bought {tool.purchaseDate}</span>}
            {tool.price != null && tool.price !== "" && <span className="chip"><i className="bi bi-cash" aria-hidden="true"></i> {tool.price}</span>}
            <span className="chip"><i className="bi bi-hand-index" aria-hidden="true"></i> used {timeAgo(tool.lastUsed)}</span>
            <span className="chip"><i className="bi bi-calendar3" aria-hidden="true"></i> added {tool.createdAt ? timeAgo(tool.createdAt) : "unknown"}</span>
            <TagChips tags={tool.tags} />
          </div>
        </GcDisclosure>

        {busy && <p className="empty-hint" role="status" aria-live="polite">Reading the label…</p>}
        {tool.productInfo && (
          // The AI's read of the label can run to a screenful. Behind a named
          // disclosure it stops being the page; the card box around it went too,
          // since the disclosure already gives it a heading and an edge.
          <GcDisclosure
            id={`tool-product-info-${tool.id}`}
            label="Product info"
            icon="bi-upc-scan"
            open={productOpen}
            onToggle={setProductOpen}
          >
            <div
              className="product-info-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(tool.productInfo) }}
            />
          </GcDisclosure>
        )}
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
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-tool-modal-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="edit-tool-modal-title">Edit item</h2>
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
        <h2><i className="bi bi-box-seam" aria-hidden="true"></i> Inventory</h2>
        {section === "items" && (
          <button className="icon-btn" onClick={() => setShowAdd(true)} title="Add item" aria-label="Add item"><i className="bi bi-plus-lg" aria-hidden="true"></i></button>
        )}
      </div>

      <div className="tag-filter-bar">
        <button className={section === "items" ? "tag-chip active" : "tag-chip"} aria-pressed={section === "items"} onClick={() => setSection("items")}>
          Items
        </button>
        <button className={section === "toget" ? "tag-chip active" : "tag-chip"} aria-pressed={section === "toget"} onClick={() => setSection("toget")}>
          To get{openCount > 0 ? ` (${openCount})` : ""}
        </button>
      </div>

      {section === "items" ? (
        <React.Fragment>
          <TagFilterBar items={tools} activeTag={activeTag} onSelect={setActiveTag} />
          <div className="item-grid">
            {tools.length === 0 && (
              <div className="empty-state">
                <i className="bi bi-box-seam" aria-hidden="true"></i>
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
                  <div className="item-card-placeholder"><i className="bi bi-tools" aria-hidden="true"></i></div>
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
        <div className="toget-panel" role="list">
          <div className="toget-add" role="listitem">
            <input
              className="text-input"
              placeholder="Add something to get…"
              aria-label="Add something to get"
              value={newToGet}
              onChange={(e) => setNewToGet(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addToGet()}
            />
            <button className="btn btn-send" onClick={addToGet} disabled={!newToGet.trim()} title="Add" aria-label="Add">
              <i className="bi bi-plus-lg" aria-hidden="true"></i>
            </button>
          </div>
          {shopping.length === 0 && (
            <div className="empty-state">
              <i className="bi bi-cart" aria-hidden="true"></i>
              <p>Nothing to get — add items here, or tell Sprout "I need to buy…".</p>
            </div>
          )}
          {[...shopping]
            .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.id - a.id)
            .map((s) => (
              <div key={s.id} role="listitem" className={s.done ? "toget-row done" : "toget-row"}>
                <button className="toget-check" onClick={() => toggleToGet(s)} title={s.done ? "Uncheck" : "Check off"} aria-label={s.done ? "Uncheck" : "Check off"} aria-pressed={s.done}>
                  <i className={s.done ? "bi bi-check-square-fill" : "bi bi-square"} aria-hidden="true"></i>
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
                    <i className="bi bi-box-seam" aria-hidden="true"></i> To inventory
                  </button>
                )}
                <button className="icon-btn small" onClick={() => removeToGet(s)} title="Remove" aria-label="Remove">
                  <i className="bi bi-trash" aria-hidden="true"></i>
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
