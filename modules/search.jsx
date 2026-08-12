// Global search: one full-screen overlay that looks through everything the app
// stores — plants, inventory, routines, to-dos, the to-get list, codex entries
// and chat messages — and jumps straight to whatever the user taps.
//
// Loaded after the feature modules and before app.jsx (see index.html), so all
// of idb.js's readers and shared-ui's components are already plain globals by
// the time anything here runs. No import/export, same as every other module.

// Display + grouping order. Each key matches the store it reads from.
const SEARCH_CATEGORIES = [
  { key: "plants", label: "Plants", icon: "bi-flower3" },
  { key: "tools", label: "Inventory", icon: "bi-box-seam" },
  { key: "routines", label: "Routines", icon: "bi-arrow-repeat" },
  { key: "todos", label: "To-do", icon: "bi-check2-square" },
  { key: "shopping", label: "To get", icon: "bi-cart" },
  { key: "codex", label: "Codex", icon: "bi-book" },
  { key: "messages", label: "Chat", icon: "bi-chat-dots" },
];

const SEARCH_CATEGORY_CAP = 5; // rows per group before the "N more" line
const SEARCH_DEBOUNCE_MS = 150;

function searchJoinFields(parts) {
  return parts.filter((p) => p != null && String(p).trim() !== "").join(" · ");
}

// Where each result navigates to. Mirrors navigate(view, { itemId, draft,
// query }) in app.jsx exactly — those are the only options it understands.
function searchTargetFor(item) {
  switch (item.cat) {
    case "plants":
      return ["garden", { itemId: item.id }];
    case "tools":
      return ["inventory", { itemId: item.id }];
    case "routines":
      return ["routines", { itemId: item.id }];
    case "todos":
      return ["todos", {}];
    // "To get" is a section inside InventoryView with its own local state, so
    // there's no id to hand over — this lands on Inventory and no further.
    case "shopping":
      return ["inventory", {}];
    case "codex":
      return ["codex", { query: item.title }];
    default:
      return ["chat", {}];
  }
}

// ONE flat, pre-lowercased index, built when the overlay opens. Only the
// searchable strings are kept: the same records carry base64 photo data URLs
// (tens of MB in a well-used garden), and dragging those through a filter on
// every keystroke is what would make typing stutter on a phone.
async function buildSearchIndex() {
  const [plants, tools, routines, todos, shopping, codex, messages, chats] = await Promise.all([
    getAllPlants(),
    getAllTools(),
    getAllRoutines(),
    getAllTodos(),
    getAllShoppingItems(),
    getAllCodexEntries(),
    getAllMessages(),
    getAllChats(),
  ]);

  const items = [];
  // `name` is what gets ranked as the item's title; `body` is everything else
  // worth matching; `sub` is display-only context.
  function push(cat, id, name, body, sub, ts, rankName) {
    items.push({
      cat: cat,
      id: id,
      title: String(name || ""),
      body: String(body || ""),
      sub: String(sub || ""),
      ts: ts || 0,
      // rankName === false means "this row's heading isn't its own text" —
      // used for chat messages, whose heading is the conversation's title.
      nameLc: rankName === false ? "" : String(name || "").toLowerCase(),
      bodyLc: String(body || "").toLowerCase(),
    });
  }

  for (const p of plants) {
    push(
      "plants",
      p.id,
      p.name || "Unnamed plant",
      searchJoinFields([p.notes, p.location, (p.tags || []).join(" ")]),
      p.location || "",
      p.createdAt
    );
  }
  for (const t of tools) {
    push(
      "tools",
      t.id,
      t.name || "Unnamed item",
      searchJoinFields([t.notes, t.brand, t.location, (t.tags || []).join(" "), t.productInfo]),
      searchJoinFields([t.brand, t.location]),
      t.createdAt
    );
  }
  for (const r of routines) {
    push(
      "routines",
      r.id,
      r.task || "Untitled routine",
      (r.tags || []).join(" "),
      "every " + r.intervalDays + "d",
      r.createdAt
    );
  }
  for (const t of todos) {
    push("todos", t.id, t.text || "Untitled to-do", t.notes, t.dueDate ? "due " + t.dueDate : "", t.createdAt);
  }
  for (const s of shopping) {
    push("shopping", s.id, s.name || "Unnamed item", s.notes, s.done ? "bought" : "", s.createdAt);
  }
  for (const e of codex) {
    push("codex", e.id, e.title || "Untitled entry", e.body, e.itemName || "", e.createdAt);
  }

  // Messages are titled by their conversation so a hit reads as "which chat was
  // that in?" — but the chat title itself is NOT searchable here, or searching
  // a chat's name would dump every message it contains into the results.
  const chatTitles = {};
  for (const c of chats) chatTitles[c.id] = c.title || "Untitled chat";
  for (const m of messages) {
    if (!m.text) continue; // image-only messages have nothing to match on
    push(
      "messages",
      m.id,
      chatTitles[m.chatId] || "Chat",
      m.text,
      (m.role === "user" ? "you" : "Sprout") + " · " + timeAgo(m.createdAt),
      m.createdAt,
      false
    );
  }

  return items;
}

// Lower is better; -1 means no match. Exact-name beats prefix beats substring,
// and any name match beats a body match.
function scoreSearchMatch(item, q) {
  if (item.nameLc) {
    if (item.nameLc === q) return 0;
    if (item.nameLc.indexOf(q) === 0) return 1;
    if (item.nameLc.indexOf(q) !== -1) return 2;
  }
  return item.bodyLc.indexOf(q) !== -1 ? 3 : -1;
}

function runSearch(index, term) {
  const q = term.toLowerCase();
  const byCat = {};
  for (const item of index) {
    const score = scoreSearchMatch(item, q);
    if (score < 0) continue;
    if (!byCat[item.cat]) byCat[item.cat] = [];
    byCat[item.cat].push({ item: item, score: score });
  }
  // Ties break on recency, so the newest matching plant/message wins the slot.
  for (const key of Object.keys(byCat)) {
    byCat[key].sort((a, b) => a.score - b.score || b.item.ts - a.item.ts);
  }
  return byCat;
}

// A window of text around the match, so a 2000-character codex entry shows the
// sentence that actually matched instead of its opening line.
function searchSnippet(text, term, radius) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const pad = radius || 40;
  if (!term) return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
  const i = clean.toLowerCase().indexOf(term.toLowerCase());
  if (i === -1) return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
  const start = Math.max(0, i - pad);
  const end = Math.min(clean.length, i + term.length + pad * 2);
  return (start > 0 ? "…" : "") + clean.slice(start, end) + (end < clean.length ? "…" : "");
}

// Highlighting is built out of React text children, never out of interpolated
// HTML: the search term comes from the user and the surrounding text can come
// from an AI reply, so neither is ever handed to dangerouslySetInnerHTML.
function SearchHighlight({ text, term }) {
  const full = String(text || "");
  if (!term) return <React.Fragment>{full}</React.Fragment>;
  const i = full.toLowerCase().indexOf(term.toLowerCase());
  if (i === -1) return <React.Fragment>{full}</React.Fragment>;
  return (
    <React.Fragment>
      {full.slice(0, i)}
      <span className="search-hit">{full.slice(i, i + term.length)}</span>
      {full.slice(i + term.length)}
    </React.Fragment>
  );
}

function SearchResultRow({ hit, term, icon, onPick }) {
  const item = hit.item;
  // Only highlight inside the snippet when the body is what matched —
  // otherwise the snippet is just a preview of the record.
  const snippet = searchSnippet(item.body, hit.score === 3 ? term : "");
  return (
    <button className="search-row" onClick={() => onPick(item)}>
      <i className={"bi " + icon + " search-row-icon"} aria-hidden="true"></i>
      <span className="search-row-main">
        <span className="search-row-title">
          <SearchHighlight text={item.title} term={term} />
        </span>
        {snippet && (
          <span className="search-row-snippet">
            <SearchHighlight text={snippet} term={term} />
          </span>
        )}
        {item.sub && <span className="search-row-sub">{item.sub}</span>}
      </span>
      <i className="bi bi-chevron-right search-row-chevron" aria-hidden="true"></i>
    </button>
  );
}

function SearchOverlay({ onNavigate, onClose }) {
  const [raw, setRaw] = useState("");
  const [term, setTerm] = useState("");
  const [index, setIndex] = useState(null); // null while the first read is in flight
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const built = await buildSearchIndex();
        if (alive) setIndex(built);
      } catch (e) {
        // A search that couldn't READ the database has to say so — rendering
        // "no results" here would read as "you have nothing saved".
        if (alive) {
          setIndex([]);
          setLoadError("Couldn't read your garden data: " + e.message);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Debounced so each keystroke doesn't re-scan the whole index mid-typing.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(raw.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [raw]);

  // Escape closes, like every other full-screen surface on a desktop browser
  // (shared-ui.jsx's useEscapeKey — this used to be its own inline listener).
  useEscapeKey(onClose);

  const grouped = React.useMemo(() => (index && term ? runSearch(index, term) : null), [index, term]);
  const totalHits = grouped
    ? Object.keys(grouped).reduce((sum, key) => sum + grouped[key].length, 0)
    : 0;

  // Before anything is typed: the handful of things most recently added, so the
  // overlay is useful the moment it opens rather than an empty box.
  const recent = React.useMemo(() => {
    if (!index) return [];
    return index
      .filter((i) => i.cat === "plants" || i.cat === "tools" || i.cat === "codex")
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5);
  }, [index]);

  const iconFor = {};
  for (const c of SEARCH_CATEGORIES) iconFor[c.key] = c.icon;

  function pick(item) {
    const target = searchTargetFor(item);
    onNavigate(target[0], target[1]);
    onClose();
  }

  function askSprout() {
    onNavigate("chat", { draft: 'About "' + term + '": ' });
    onClose();
  }

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search everything" onClick={(e) => e.stopPropagation()}>
        <div className="search-bar">
          <i className="bi bi-search search-bar-icon" aria-hidden="true"></i>
          <input
            className="text-input search-input"
            autoFocus
            type="search"
            value={raw}
            placeholder="Search plants, tools, notes, chats…"
            aria-label="Search plants, tools, notes, chats"
            onChange={(e) => setRaw(e.target.value)}
          />
          {raw && (
            <button className="icon-btn small" title="Clear" aria-label="Clear" onClick={() => setRaw("")}>
              <i className="bi bi-x-circle" aria-hidden="true"></i>
            </button>
          )}
          <button className="icon-btn" title="Close search" aria-label="Close search" onClick={onClose}>
            <i className="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </div>

        <div className="search-results">
          {loadError && <div className="error-banner" role="alert">{loadError}</div>}

          {index === null && <p className="empty-hint" role="status" aria-live="polite">Reading your garden…</p>}

          {index !== null && !term && (
            <React.Fragment>
              {recent.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    <i className="bi bi-clock-history" aria-hidden="true"></i> Recently added
                  </div>
                  {recent.map((item) => (
                    <SearchResultRow
                      key={item.cat + ":" + item.id}
                      hit={{ item: item, score: 2 }}
                      term=""
                      icon={iconFor[item.cat]}
                      onPick={pick}
                    />
                  ))}
                </div>
              )}
              <div className="empty-state search-empty">
                <i className="bi bi-search" aria-hidden="true"></i>
                <p>Search your whole garden at once — plants, tools, routines, to-dos, codex entries and past chats.</p>
              </div>
            </React.Fragment>
          )}

          {index !== null && term && totalHits === 0 && (
            <div className="empty-state search-empty">
              <i className="bi bi-search" aria-hidden="true"></i>
              <p>Nothing saved matches "{term}".</p>
              <button className="btn small" onClick={askSprout}>
                <i className="bi bi-chat-dots" aria-hidden="true"></i> Ask Sprout about "{term}"
              </button>
            </div>
          )}

          {grouped &&
            totalHits > 0 &&
            SEARCH_CATEGORIES.map((cat) => {
              const hits = grouped[cat.key] || [];
              if (hits.length === 0) return null;
              const shown = hits.slice(0, SEARCH_CATEGORY_CAP);
              return (
                <div key={cat.key} className="search-group">
                  <div className="search-group-head">
                    <i className={"bi " + cat.icon} aria-hidden="true"></i> {cat.label}
                    <span className="search-group-count">{hits.length}</span>
                  </div>
                  {shown.map((hit) => (
                    <SearchResultRow
                      key={cat.key + ":" + hit.item.id}
                      hit={hit}
                      term={term}
                      icon={cat.icon}
                      onPick={pick}
                    />
                  ))}
                  {hits.length > shown.length && (
                    <div className="search-more">
                      {hits.length - shown.length} more — keep typing to narrow it down
                    </div>
                  )}
                </div>
              );
            })}

          {index !== null && term && totalHits > 0 && (
            <button className="btn btn-ghost small search-ask" onClick={askSprout}>
              <i className="bi bi-chat-dots" aria-hidden="true"></i> Ask Sprout about "{term}"
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
