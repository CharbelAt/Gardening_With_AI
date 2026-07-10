// Codex module: a static quick-reference library, plus an AI-backed
// in-depth search (with cited sources) for anything not in the static list.

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

// Pulls a trailing "SOURCES: url1, url2" line off an AI codex reply.
function extractSources(text) {
  const match = text.match(/SOURCES:\s*(.+)\s*$/i);
  if (!match) return { body: text.trim(), sources: [] };
  const body = text.slice(0, match.index).trim();
  const raw = match[1].trim();
  if (!raw || /^none$/i.test(raw)) return { body, sources: [] };
  const sources = raw
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { body, sources };
}

function CodexView({ onBack }) {
  const [query, setQuery] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiResult, setAiResult] = useState(null); // { term, body, sources }
  const filtered = CODEX_ENTRIES.filter(
    (e) =>
      e.title.toLowerCase().includes(query.toLowerCase()) ||
      e.body.toLowerCase().includes(query.toLowerCase())
  );

  async function deepSearch() {
    const term = query.trim();
    if (!term || aiLoading) return;
    setAiLoading(true);
    setAiError("");
    setAiResult(null);
    try {
      const data = await apiFetch("/api/chat", {
        messages: [
          {
            role: "system",
            content:
              "You are a gardening reference-library assistant. Given a plant, pest, disease, or " +
              "gardening topic, write a concise but in-depth reference entry (4-8 sentences) covering " +
              "identification, care, or treatment as relevant, using trusted gardening sources. After " +
              "the entry, on its own final line, output exactly: SOURCES: <1-3 real source URLs, comma " +
              "separated> — or SOURCES: none if you're not confident of a real source. Never omit that line.",
          },
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

  return (
    <div className="tab-panel">
      <div className="view-header">
        <button className="icon-btn" onClick={onBack}><i className="bi bi-arrow-left"></i></button>
        <h2>Codex</h2>
      </div>
      <div className="composer" style={{ padding: "0 16px 8px" }}>
        <input
          className="text-input codex-search"
          style={{ margin: 0, flex: 1 }}
          placeholder="Search plants, pests, topics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && filtered.length === 0 && deepSearch()}
        />
        <button className="icon-btn" title="In-depth AI search" onClick={deepSearch} disabled={!query.trim() || aiLoading}>
          <i className={aiLoading ? "bi bi-hourglass-split" : "bi bi-search-heart"}></i>
        </button>
      </div>
      <div className="codex-list">
        {filtered.map((e) => (
          <div key={e.title} className="codex-entry">
            <h3>{e.title}</h3>
            <p>{e.body}</p>
          </div>
        ))}
        {filtered.length === 0 && !aiResult && !aiLoading && (
          <p className="empty-hint">
            No matches in the built-in library — tap <i className="bi bi-search-heart"></i> above for an in-depth AI search.
          </p>
        )}
        {aiLoading && <p className="empty-hint">Searching in depth…</p>}
        {aiError && <div className="error-banner">{aiError}</div>}
        {aiResult && (
          <div className="codex-entry">
            <h3>{aiResult.term} <span className="item-card-sub">(AI deep search)</span></h3>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(aiResult.body) }} />
            {aiResult.sources.length > 0 && (
              <div className="codex-source">
                Sources:{" "}
                {aiResult.sources.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <a href={s} target="_blank" rel="noopener noreferrer">{s}</a>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
