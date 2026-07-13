// Codex module: the garden's knowledge library. Three kinds of content:
// 1. A small static quick-reference list (CODEX_ENTRIES).
// 2. Auto-researched entries — every plant/tool added to the app gets a
//    background AI research pass with sources (ensureCodexResearch in
//    helpers.jsx) and lands here automatically.
// 3. Manual AI deep-search results the user chose to save.
// Item detail pages link here via their "Codex" button (prefilled search).

const CODEX_ENTRIES = [
  { title: "Tomatoes", body: "6-8 hours direct sun. Water deeply and consistently — irregular watering causes blossom end rot. Stake or cage for support. Feed every 2-3 weeks once fruiting starts." },
  { title: "Basil", body: "Loves warmth and sun (6+ hours). Pinch off flower buds to keep leaves coming. Water when the top inch of soil is dry — avoid soggy roots." },
  { title: "Roses", body: "Full sun, well-drained soil. Water at the base, not the leaves, to avoid fungal disease. Prune in late winter/early spring. Feed monthly during growing season." },
  { title: "Succulents", body: "Bright light, minimal water — let soil dry out completely between waterings. Overwatering is the #1 killer. Use gritty, fast-draining soil." },
  { title: "Pothos", body: "Tolerates low light but grows faster in bright, indirect light. Water when top 1-2 inches of soil are dry. Very forgiving — good for beginners." },
  { title: "Lettuce", body: "Cool-season crop, partial shade in hot climates. Keep soil consistently moist. Harvest outer leaves to extend the plant's life." },
  { title: "Peppers", body: "Full sun, warm soil. Water consistently; inconsistent watering causes blossom drop. Feed with a balanced or low-nitrogen fertilizer once flowering." },
  { title: "Lavender", body: "Full sun, very well-drained (even poor) soil. Overwatering kills it faster than drought. Prune after flowering to keep it compact." },
  { title: "Mint", body: "Spreads aggressively — grow in a container to contain roots. Tolerates partial shade. Keep soil moist; pinch back to encourage bushiness." },
  { title: "Aphids (pest)", body: "Small sap-sucking insects, often clustered on new growth. Spray off with water, or use insecticidal soap/neem oil. Ladybugs are a natural predator." },
  { title: "Powdery mildew (disease)", body: "White powdery coating on leaves, common in humid conditions with poor airflow. Improve air circulation, avoid overhead watering, treat with a sulfur or potassium bicarbonate fungicide." },
  { title: "Overwatering signs", body: "Yellowing leaves, soft/mushy stems, wilting despite wet soil, root rot smell. Let soil dry out and check drainage before watering again." },
  { title: "Underwatering signs", body: "Dry, crispy leaf edges, drooping, soil pulling away from pot edges. Water deeply and check moisture more frequently." },
  { title: "Composting basics", body: "Balance 'greens' (nitrogen: food scraps, grass) with 'browns' (carbon: dry leaves, cardboard). Turn regularly for airflow. Should smell earthy, not rotten." },
  { title: "Soil pH basics", body: "Most vegetables prefer slightly acidic to neutral soil (6.0-7.0). Acid-lovers (blueberries, azaleas) want lower pH (~5.0-5.5). Test with a cheap soil pH kit before amending." },
];

function CodexSources({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="codex-source">
      Sources:{" "}
      {sources.map((s, i) => (
        <span key={s}>
          {i > 0 && ", "}
          <a href={s} target="_blank" rel="noopener noreferrer">{s}</a>
        </span>
      ))}
    </div>
  );
}

function CodexKindBadge({ entry }) {
  if (!entry.kind || entry.kind === "topic") return null;
  const icon = entry.kind === "plant" ? "bi-flower3" : "bi-tools";
  return (
    <span className="codex-kind">
      <i className={`bi ${icon}`}></i> {entry.kind}
      {entry.auto ? " · auto" : ""}
    </span>
  );
}

function CodexView({ initialQuery, onNavigate }) {
  const [query, setQuery] = useState(initialQuery || "");
  const [saved, setSaved] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiResult, setAiResult] = useState(null); // { term, body, sources, savedId? }
  const [deleteTarget, setDeleteTarget] = useState(null);

  async function refreshSaved() {
    const all = await getAllCodexEntries();
    setSaved(all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))); // newest first
  }
  useEffect(() => {
    refreshSaved();
    // Back-fill any plant/tool that's missing its researched entry (e.g. the
    // AI was unreachable when it was added), then refresh the list.
    syncCodexEntries().then((missing) => {
      if (missing > 0) refreshSaved();
    });
  }, []);

  const q = query.toLowerCase();
  const matches = (e) =>
    e.title.toLowerCase().includes(q) || (e.body || "").toLowerCase().includes(q);
  const filteredSaved = saved.filter(matches);
  const filteredBuiltIn = CODEX_ENTRIES.filter(matches);
  const nothingFound = filteredSaved.length === 0 && filteredBuiltIn.length === 0;

  async function deepSearch() {
    const term = query.trim();
    if (!term || aiLoading) return;
    setAiLoading(true);
    setAiError("");
    setAiResult(null);
    try {
      const data = await apiFetch("/api/chat", {
        mode: "research", // web-search-capable model chain
        messages: [
          { role: "system", content: CODEX_RESEARCH_SYSTEM },
          { role: "user", content: term },
        ],
      });
      const { body, sources } = extractSources(data.reply || "");
      setAiResult({ term, body, sources });
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }

  async function saveResult() {
    if (!aiResult || aiResult.savedId) return;
    const id = await addCodexEntry({
      title: aiResult.term,
      body: aiResult.body,
      sources: aiResult.sources,
      kind: "topic",
      itemName: aiResult.term,
    });
    setAiResult({ ...aiResult, savedId: id });
    refreshSaved();
  }

  function askSprout(title) {
    onNavigate("chat", { draft: `From the codex, about "${title}": how does this apply to my garden?` });
  }

  async function removeSaved() {
    if (!deleteTarget) return;
    await deleteCodexEntry(deleteTarget.id);
    setDeleteTarget(null);
    refreshSaved();
  }

  return (
    <div className="tab-panel">
      <div className="view-header">
        <h2><i className="bi bi-book"></i> Codex</h2>
      </div>
      <div className="codex-search-row">
        <input
          className="text-input"
          placeholder="Search plants, pests, topics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && nothingFound && deepSearch()}
        />
        <button className="icon-btn" title="In-depth AI search" onClick={deepSearch} disabled={!query.trim() || aiLoading}>
          <i className={aiLoading ? "bi bi-hourglass-split" : "bi bi-search-heart"}></i>
        </button>
      </div>
      <div className="codex-list">
        {aiLoading && <p className="empty-hint">Searching in depth…</p>}
        {aiError && <div className="error-banner">{aiError}</div>}
        {aiResult && (
          <div className="codex-entry ai-result">
            <h3>{aiResult.term} <span className="item-card-sub">(AI deep search)</span></h3>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(aiResult.body) }} />
            <CodexSources sources={aiResult.sources} />
            <div className="codex-entry-actions">
              <button className="btn small" onClick={saveResult} disabled={!!aiResult.savedId}>
                <i className={aiResult.savedId ? "bi bi-check2" : "bi bi-bookmark-plus"}></i>{" "}
                {aiResult.savedId ? "Saved" : "Save to Codex"}
              </button>
              <button className="btn btn-ghost small" onClick={() => askSprout(aiResult.term)}>
                <i className="bi bi-chat-dots"></i> Ask Sprout
              </button>
            </div>
          </div>
        )}

        {filteredSaved.length > 0 && <h3 className="codex-section-title">Your library</h3>}
        {filteredSaved.map((e) => (
          <div key={`saved-${e.id}`} className="codex-entry">
            <h3>
              {e.title} <CodexKindBadge entry={e} />
            </h3>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(e.body) }} />
            <CodexSources sources={e.sources} />
            <div className="codex-entry-actions">
              <button className="btn btn-ghost small" onClick={() => askSprout(e.title)}>
                <i className="bi bi-chat-dots"></i> Ask Sprout
              </button>
              <button className="icon-btn small" title="Delete entry" onClick={() => setDeleteTarget(e)}>
                <i className="bi bi-trash"></i>
              </button>
            </div>
          </div>
        ))}

        {filteredSaved.length > 0 && filteredBuiltIn.length > 0 && (
          <h3 className="codex-section-title">Built-in library</h3>
        )}
        {filteredBuiltIn.map((e) => (
          <div key={e.title} className="codex-entry">
            <h3>{e.title}</h3>
            <p>{e.body}</p>
            <div className="codex-entry-actions">
              <button className="btn btn-ghost small" onClick={() => askSprout(e.title)}>
                <i className="bi bi-chat-dots"></i> Ask Sprout
              </button>
            </div>
          </div>
        ))}

        {nothingFound && !aiResult && !aiLoading && (
          <div className="empty-state">
            <i className="bi bi-book"></i>
            <p>
              No matches in the library — tap <i className="bi bi-search-heart"></i> above for an
              in-depth AI search with sources.
            </p>
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title="Delete saved entry?"
          message={`Remove "${deleteTarget.title}" from your codex?`}
          confirmLabel="Delete"
          onConfirm={removeSaved}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
