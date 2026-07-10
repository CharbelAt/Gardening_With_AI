// App entry point. Loaded LAST (see index.html) since it references
// components defined in every ./modules/*.jsx file — all sharing this page's
// global scope, no import/export. Keeps the whole app deployable by just
// editing files and committing to GitHub Pages (no build step).

function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState("chat");
  const [view, setView] = useState(null); // null = show chat/call tabs; else 'garden'|'inventory'|'routines'|'codex'
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChatList, setShowChatList] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    localStorage.setItem(LS_THEME, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#16391a" : "#2e7d32");
  }, [theme]);

  function navigateFromDrawer(key) {
    setShowDrawer(false);
    if (key === "settings") setShowSettings(true);
    else if (key === "help") setShowHelp(true);
    else setView(key);
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

  return (
    <div className={`app ${theme === "dark" ? "dark" : ""}`}>
      <header className="app-header">
        <button className="icon-btn" onClick={() => setShowChatList(true)} title="Chats"><i className="bi bi-chat-dots"></i></button>
        <span className="app-title"><i className="bi bi-flower1"></i> Garden Companion</span>
        <button className="icon-btn" onClick={() => setShowDrawer(true)} title="Menu"><i className="bi bi-gear"></i></button>
      </header>

      {view === null && (
        <nav className="tabs">
          <button className={tab === "chat" ? "tab active" : "tab"} onClick={() => setTab("chat")}>Chat</button>
          <button className={tab === "call" ? "tab active" : "tab"} onClick={() => setTab("call")}>Call</button>
        </nav>
      )}

      {view === null && loaded && tab === "chat" && (
        <ChatTab chatId={activeChatId} messages={messages} setMessages={setMessages} busy={busy} setBusy={setBusy} />
      )}
      {view === null && loaded && tab === "call" && (
        <CallTab chatId={activeChatId} messages={messages} setMessages={setMessages} />
      )}
      {view === "garden" && <GardenView onBack={() => setView(null)} />}
      {view === "inventory" && <InventoryView onBack={() => setView(null)} />}
      {view === "routines" && <RoutinesView onBack={() => setView(null)} />}
      {view === "codex" && <CodexView onBack={() => setView(null)} />}

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

      {showDrawer && (
        <SideDrawer onClose={() => setShowDrawer(false)} onNavigate={navigateFromDrawer} />
      )}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onCleared={onMemoryCleared}
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
