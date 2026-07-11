// App entry point. Loaded LAST (see index.html) since it references
// components defined in every ./modules/*.jsx file — all sharing this page's
// global scope, no import/export. Keeps the whole app deployable by just
// editing files and committing to GitHub Pages (no build step).
//
// Navigation model: a persistent bottom bar switches the main view
// (chat/garden/routines/inventory/codex). "call" is a sub-mode of chat,
// entered from the phone icon in the header. Cross-module links (e.g. a
// plant's "Ask Sprout" button, a routine's linked plant) go through
// navigate(view, {itemId, draft}).

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [view, setView] = useState("chat"); // chat | call | garden | inventory | routines | codex
  const [navItemId, setNavItemId] = useState(null); // open this item's detail page on view mount
  const [chatDraft, setChatDraft] = useState(""); // prefilled composer text from "Ask Sprout" buttons
  const [dueCount, setDueCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatList, setShowChatList] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    localStorage.setItem(LS_THEME, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#101510" : "#2e6b34");
  }, [theme]);

  // Keep the "due" badge on the Routines nav item fresh — cheap IndexedDB
  // read, refreshed whenever the user changes views.
  async function refreshDueCount() {
    const routines = await getAllRoutines();
    setDueCount(routines.filter(isRoutineDue).length);
  }
  useEffect(() => {
    refreshDueCount();
  }, [view]);

  function navigate(nextView, opts = {}) {
    setNavItemId(opts.itemId != null ? opts.itemId : null);
    if (opts.draft) setChatDraft(opts.draft);
    setView(nextView);
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
      if (!getSettings().apiBase) setShowSettings(true);
    })();
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
  }

  const activeChat = chats.find((c) => c.id === activeChatId);

  return (
    <div className={`app ${theme === "dark" ? "dark" : ""}`}>
      <header className="app-header">
        <div className="header-side">
          {view === "chat" && (
            <button className="icon-btn" onClick={() => setShowChatList(true)} title="Chats">
              <i className="bi bi-chat-square-text"></i>
            </button>
          )}
          {view === "call" && (
            <button className="icon-btn" onClick={() => setView("chat")} title="Back to chat">
              <i className="bi bi-arrow-left"></i>
            </button>
          )}
        </div>
        <span className="app-title">
          <i className="bi bi-flower1"></i>
          <span>
            Garden Companion
            {view === "chat" && activeChat && <em className="app-subtitle">{activeChat.title}</em>}
          </span>
        </span>
        <div className="header-side right">
          {view === "chat" && (
            <button className="icon-btn" onClick={() => setView("call")} title="Voice call">
              <i className="bi bi-telephone"></i>
            </button>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">
            <i className="bi bi-gear"></i>
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
        {loaded && view === "call" && (
          <CallTab chatId={activeChatId} messages={messages} setMessages={setMessages} />
        )}
        {view === "garden" && <GardenView initialId={navItemId} onNavigate={navigate} />}
        {view === "inventory" && <InventoryView initialId={navItemId} onNavigate={navigate} />}
        {view === "routines" && <RoutinesView initialId={navItemId} onNavigate={navigate} />}
        {view === "codex" && <CodexView onNavigate={navigate} />}
      </main>

      <BottomNav view={view} onNavigate={navigate} dueCount={dueCount} />

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

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onCleared={onMemoryCleared}
          onShowHelp={() => {
            setShowSettings(false);
            setShowHelp(true);
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
