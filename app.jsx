// App entry point. Loaded LAST (see index.html) since it references
// components defined in every ./modules/*.jsx file — all sharing this page's
// global scope, no import/export. Keeps the whole app deployable by just
// editing files and committing to GitHub Pages (no build step).
//
// Navigation model: a persistent bottom bar switches the main view between the
// five tabs (today/garden/chat/tasks/inventory). Voice input is a tap-to-talk
// toggle in the chat composer (VoiceButton in voice.jsx: tap to open the mic,
// tap again to close it and append the transcript) — there is no separate
// call view or call mode. Cross-module links (e.g. a plant's "Ask
// Sprout" button, a routine's linked plant, an item's Codex button) go through
// navigate(view, {itemId, draft, query}).
//
// Two views have no tab of their own and that is deliberate:
//   codex  — a reference library you arrive at from something else (header
//            search, an item page's Codex button, Settings › Knowledge
//            library), never a destination you open cold.
//   search — an app-wide overlay from the header magnifier, not a section.
//
// "routines" and "todos" are still accepted as view keys for ever: they are
// legacy aliases for the Tasks tab (LEGACY_VIEW_ALIASES/resolveView in
// shared-ui.jsx) and resolve to view "tasks" plus the section to preselect, so
// every existing deep link — garden.jsx's linked routines, today.jsx's rows,
// search.jsx's results — keeps landing exactly where it used to.

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [view, setView] = useState("chat"); // today | garden | chat | tasks | inventory | codex
  const [navItemId, setNavItemId] = useState(null); // open this item's detail page on view mount
  const [tasksSection, setTasksSection] = useState(null); // "routines" | "todos" from a legacy link; null = leave Tasks where the user left it
  const [chatDraft, setChatDraft] = useState(""); // prefilled composer text from "Ask Sprout" buttons
  const [codexQuery, setCodexQuery] = useState(""); // prefilled codex search from item "Codex" buttons
  const [dueCount, setDueCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatList, setShowChatList] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showGuide, setShowGuide] = useState(false); // "How to talk to Sprout" (guide.jsx)
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [contextPeek, setContextPeek] = useState(null); // { summary, revision } from the refresh button
  const [showSearch, setShowSearch] = useState(false); // global search overlay (header magnifier)

  // ---------- Android back button ----------
  // Installed as a PWA there is no browser chrome, so the hardware/gesture Back
  // is the ONLY back affordance — and with a single history entry Android takes
  // it as "leave the app". Closing a modal or returning to the previous tab used
  // to quit outright, losing whatever was on screen.
  //
  // The fix is a depth counter mirrored into history.pushState: every layer the
  // user opens (an overlay, or moving off the landing tab) pushes one entry, and
  // popstate unwinds exactly one layer instead of exiting. Only a Back pressed
  // at depth 0 — landing tab, nothing open — falls through and closes the app,
  // which is what a user actually expects there.
  const LANDING_VIEW = localStorage.getItem(LS_LANDING_VIEW) === "today" ? "today" : "chat";
  // Ordered outermost-last: popstate closes the FIRST match, i.e. the topmost
  // thing on screen. Detail pages inside a view own their own back arrow and
  // are deliberately not layers here.
  const overlays = [
    [contextPeek, () => setContextPeek(null)],
    [deleteTarget, () => setDeleteTarget(null)],
    [renameTarget, () => setRenameTarget(null)],
    [showHelp, () => setShowHelp(false)],
    [showGuide, () => setShowGuide(false)],
    [showSearch, () => setShowSearch(false)],
    [showChatList, () => setShowChatList(false)],
    [showSettings, () => setShowSettings(false)],
  ];
  const openOverlays = overlays.filter(([isOpen]) => isOpen);
  const depth = openOverlays.length + (view === LANDING_VIEW ? 0 : 1);
  const depthRef = useRef(0);
  const closeTopRef = useRef(null);
  // history.back() is asynchronous and fires popstate just like a real Back
  // press. Without this counter, closing a modal with its own X button would
  // unwind the history entry AND have the popstate handler close a second
  // layer underneath it — one tap, two things closed. Each programmatic back
  // marks one popstate to be ignored.
  const suppressPopRef = useRef(0);
  // Read by the popstate handler so it always acts on the CURRENT screen without
  // the listener needing to be torn down and re-added on every state change.
  closeTopRef.current = () => {
    if (openOverlays.length) {
      openOverlays[0][1]();
      return true;
    }
    if (view !== LANDING_VIEW) {
      navigate(LANDING_VIEW);
      return true;
    }
    return false; // depth 0 — let Android close the app
  };

  useEffect(() => {
    const prev = depthRef.current;
    depthRef.current = depth;
    // Only ever PUSH on the way down. Unwinding is done by popstate itself (or
    // by history.back below), so closing a modal with its own X button stays in
    // sync with the history stack instead of leaving a stale entry behind.
    if (depth > prev) {
      window.history.pushState({ gcDepth: depth }, "");
    } else if (depth < prev) {
      // Closed from inside the UI rather than via Back: drop the matching
      // entries so the next Back press doesn't just replay a no-op. Each of
      // these will fire a popstate that must NOT be treated as a user Back.
      const n = prev - depth;
      suppressPopRef.current += n;
      for (let i = 0; i < n; i++) window.history.back();
    }
  }, [depth]);

  useEffect(() => {
    function onPop() {
      // Our own history.back() bookkeeping, not a user Back press.
      if (suppressPopRef.current > 0) {
        suppressPopRef.current -= 1;
        return;
      }
      const handled = closeTopRef.current && closeTopRef.current();
      if (handled) {
        // Re-arm: we consumed this entry to close a layer, so push a fresh one
        // to stay one deep for the NEXT Back press.
        window.history.pushState({ gcDepth: depthRef.current }, "");
      }
      // Not handled → nothing pushed → the browser/OS takes the Back, which at
      // depth 0 means leaving the app. That is the intended escape hatch.
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_THEME, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    // From the registry, not a ternary: a new theme in THEMES (helpers.jsx) must
    // colour the Android status bar without anyone remembering to edit this line.
    if (meta) meta.setAttribute("content", themeById(theme).themeColor);
  }, [theme]);

  // Keep the nav badges fresh (due routines + open to-get items + to-dos that
  // are overdue or due today) — cheap IndexedDB reads, refreshed whenever the
  // user changes views.
  const [togetCount, setTogetCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0);
  async function refreshDueCount() {
    const [routines, shopping, todos] = await Promise.all([
      getAllRoutines(),
      getAllShoppingItems(),
      getAllTodos(),
    ]);
    setDueCount(routines.filter(isRoutineDue).length);
    setTogetCount(shopping.filter((s) => !s.done).length);
    setTodoCount(todos.filter(isTodoUrgent).length);
  }
  useEffect(() => {
    refreshDueCount();
  }, [view]);

  // "What can Sprout see?" (Settings): re-reads IndexedDB, bumps the context
  // revision, and shows the user the counts the AI will be given. The prompt
  // snapshot is rebuilt per request anyway — this exists so the user can VERIFY
  // what Sprout can see instead of taking its word for it, which is why it
  // lives in Settings rather than costing a permanent header icon.
  async function refreshAiContext() {
    const revision = bumpContextRevision();
    const summary = await buildContextSummary();
    await refreshDueCount(); // same underlying read, so the nav badges can't disagree
    setContextPeek({ summary, revision });
  }

  function navigate(nextView, opts = {}) {
    // Legacy keys ("routines"/"todos") resolve to the tab that absorbed them
    // plus the section to open on; everything else passes straight through.
    const target = resolveView(nextView);
    setNavItemId(opts.itemId != null ? opts.itemId : null);
    if (opts.draft) setChatDraft(opts.draft);
    setCodexQuery(opts.query || ""); // cleared unless a Codex link set one
    setTasksSection(target.section);
    setView(target.view);
  }

  // Initial load: run the one-time migration, figure out which chat is
  // active, and load its messages.
  useEffect(() => {
    (async () => {
      const defaultId = await ensureDefaultChat();
      const allChats = await getAllChats();
      setChats(allChats);

      const stored = Number(localStorage.getItem(LS_ACTIVE_CHAT));
      const activeId = allChats.some((c) => c.id === stored) ? stored : defaultId;
      setActiveChatId(activeId);

      const history = await getMessagesByChat(activeId);
      setMessages(history);
      setLoaded(true);
      // Landing view: Today is opt-in (Settings), because most sessions start
      // with a question, not a chore list. Chat stays the default.
      if (localStorage.getItem(LS_LANDING_VIEW) === "today") setView("today");
      if (!getSettings().apiBase) setShowSettings(true);
      // Back-fill codex entries for any items that missed their auto-research
      // (background, throttled — see syncCodexEntries in helpers.jsx).
      if (getSettings().apiBase) syncCodexEntries();
    })();
  }, []);

  // Due-date notifications: only ever fire while a tab is open (no push server
  // — see notify.jsx). Guarded so the app still boots if notify.jsx is absent.
  useEffect(() => {
    if (typeof startNotifyTimer !== "function") return;
    return startNotifyTimer();
  }, []);

  // The empty chat offers "How to talk to Sprout" too (that's where the
  // question gets asked). It signals through the window rather than a prop so
  // ChatTab's signature stays as-is for the test harness.
  useEffect(() => {
    const open = () => setShowGuide(true);
    window.addEventListener("gc:open-guide", open);
    return () => window.removeEventListener("gc:open-guide", open);
  }, []);

  async function switchChat(id) {
    setActiveChatId(id);
    localStorage.setItem(LS_ACTIVE_CHAT, String(id));
    const history = await getMessagesByChat(id);
    setMessages(history);
    setShowChatList(false);
  }

  async function newChat() {
    const id = await addChat({ title: `Chat ${chats.length + 1}` });
    const allChats = await getAllChats();
    setChats(allChats);
    await switchChat(id);
  }

  // Auto-name still-untitled chats after the user's first message, so the
  // chat list reads "Yellowing basil leaves" instead of "Chat 3".
  async function onFirstUserMessage(text) {
    const chat = chats.find((c) => c.id === activeChatId);
    if (!chat || !/^Chat \d+$/.test(chat.title || "")) return;
    await updateChat({ ...chat, title: autoTitleFromText(text) });
    setChats(await getAllChats());
  }

  function renameChat(chat) {
    setRenameTarget(chat);
  }

  async function applyRename(title) {
    if (!renameTarget) return;
    await updateChat({ ...renameTarget, title });
    setChats(await getAllChats());
    setRenameTarget(null);
  }

  function removeChat(chat) {
    setDeleteTarget(chat);
  }

  async function applyRemoveChat() {
    const chat = deleteTarget;
    if (!chat) return;
    await deleteChat(chat.id);
    const allChats = await getAllChats();
    if (allChats.length === 0) {
      // Always keep at least one chat around.
      const id = await ensureDefaultChat();
      setChats(await getAllChats());
      await switchChat(id);
    } else {
      setChats(allChats);
      if (chat.id === activeChatId) await switchChat(allChats[0].id);
    }
    setDeleteTarget(null);
  }

  async function onMemoryCleared() {
    const id = await ensureDefaultChat();
    setChats(await getAllChats());
    await switchChat(id);
    refreshDueCount(); // routines are gone — clear the nav badge immediately
  }

  const activeChat = chats.find((c) => c.id === activeChatId);

  // themeClassName emits "theme-<id>" plus "dark" for any dark palette. That
  // second class is what keeps the `.dark .foo` STRUCTURAL rules in styles.css
  // alive — see the note over THEMES in helpers.jsx before trimming it.
  return (
    <div className={`app ${themeClassName(theme)}`}>
      <header className="app-header">
        {/* Two jobs left in the header: switch conversations (chat only) on the
            left, search and settings on the right. Today became a tab, and the
            context peek moved into Settings — it verifies something the app
            already does on every request, so it never earned a permanent icon
            next to the things you tap all day. */}
        <div className="header-side">
          {view === "chat" && (
            <button className="icon-btn" onClick={() => setShowChatList(true)} title="Chats" aria-label="Chats">
              <i className="bi bi-chat-square-text" aria-hidden="true"></i>
            </button>
          )}
        </div>
        <span className="app-title">
          <i className="bi bi-flower1" aria-hidden="true"></i>
          <span>
            Garden Companion
            {view === "chat" && activeChat && <em className="app-subtitle">{activeChat.title}</em>}
          </span>
        </span>
        <div className="header-side right">
          <button className="icon-btn" onClick={() => setShowSearch(true)} title="Search everything" aria-label="Search everything">
            <i className="bi bi-search" aria-hidden="true"></i>
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
            <i className="bi bi-gear" aria-hidden="true"></i>
          </button>
        </div>
      </header>

      <main className="app-main">
        {loaded && view === "chat" && (
          <ChatTab
            chatId={activeChatId}
            messages={messages}
            setMessages={setMessages}
            busy={busy}
            setBusy={setBusy}
            draft={chatDraft}
            onDraftConsumed={() => setChatDraft("")}
            onFirstUserMessage={onFirstUserMessage}
          />
        )}
        {view === "garden" && <GardenView initialId={navItemId} onNavigate={navigate} />}
        {view === "inventory" && <InventoryView initialId={navItemId} onNavigate={navigate} />}
        {view === "tasks" && (
          <TasksView initialId={navItemId} initialSection={tasksSection} onNavigate={navigate} />
        )}
        {view === "today" && <TodayView onNavigate={navigate} />}
        {view === "codex" && <CodexView initialQuery={codexQuery} onNavigate={navigate} />}
      </main>

      <BottomNav
        view={view}
        onNavigate={navigate}
        dueCount={dueCount}
        togetCount={togetCount}
        todoCount={todoCount}
      />

      {showChatList && (
        <ChatListModal
          chats={chats}
          activeChatId={activeChatId}
          onSwitch={switchChat}
          onNew={newChat}
          onRename={renameChat}
          onDelete={removeChat}
          onClose={() => setShowChatList(false)}
        />
      )}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showGuide && typeof GuideView === "function" && (
        <GuideView onNavigate={navigate} onClose={() => setShowGuide(false)} />
      )}

      {showSearch && (
        <SearchOverlay
          onClose={() => setShowSearch(false)}
          onNavigate={(nextView, opts) => {
            setShowSearch(false); // a result always takes you somewhere — get out of the way
            navigate(nextView, opts);
          }}
        />
      )}

      {contextPeek && (
        <ContextPeekModal
          summary={contextPeek.summary}
          revision={contextPeek.revision}
          onClose={() => setContextPeek(null)}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onCleared={onMemoryCleared}
          onShowHelp={() => {
            setShowSettings(false);
            setShowHelp(true);
          }}
          onShowGuide={() => {
            setShowSettings(false);
            setShowGuide(true);
          }}
          onShowContext={() => {
            // Same handoff as onShowHelp: the peek is its own dialog, and two
            // stacked sheets read as a bug rather than as depth.
            setShowSettings(false);
            refreshAiContext();
          }}
          onOpenCodex={() => {
            setShowSettings(false);
            navigate("codex");
          }}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {renameTarget && (
        <PromptModal
          title="Rename chat"
          label="Chat name"
          initialValue={renameTarget.title}
          confirmLabel="Save"
          onConfirm={applyRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete chat?"
          message={`Delete "${deleteTarget.title}" and all its messages? This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={applyRemoveChat}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
