// Minimal IndexedDB wrapper — this IS the app's "memory". Everything here stays
// on this device/browser only (no server-side sync).
const DB_NAME = "garden-companion";
const DB_VERSION = 6; // v6 adds the to-do (one-off tasks) store
const STORE_MESSAGES = "messages";
const STORE_TOOLS = "tools";
const STORE_ROUTINES = "routines";
const STORE_PLANTS = "plants";
const STORE_CHATS = "chats";
const STORE_CODEX = "codex";
const STORE_SHOPPING = "shopping";
const STORE_TODOS = "todos";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_TOOLS)) {
        db.createObjectStore(STORE_TOOLS, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_ROUTINES)) {
        db.createObjectStore(STORE_ROUTINES, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PLANTS)) {
        db.createObjectStore(STORE_PLANTS, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_CHATS)) {
        db.createObjectStore(STORE_CHATS, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_CODEX)) {
        db.createObjectStore(STORE_CODEX, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SHOPPING)) {
        db.createObjectStore(STORE_SHOPPING, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_TODOS)) {
        db.createObjectStore(STORE_TODOS, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- generic helpers used by all stores ----------

async function addRecord(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecord(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id));
    req.onerror = () => reject(req.error);
  });
}

async function clearStore(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- chats (multiple conversation threads) ----------
//
// NOTE: this file is loaded as a plain classic <script> (see index.html) so
// every function below is a normal global, shared with modules/*.jsx and
// app.jsx via the browser's global scope — no import/export, and no build
// step required. This is intentional: it keeps the whole app deployable by
// just editing files and committing to GitHub Pages, per Babel-standalone's
// limitation that <script type="text/babel"> can't resolve real ES imports
// between files without a real bundler.

// chat: { title, createdAt }
function addChat(chat) {
  return addRecord(STORE_CHATS, { title: chat.title || "New chat", createdAt: Date.now() });
}
function getAllChats() {
  return getAllRecords(STORE_CHATS);
}
function updateChat(chat) {
  return putRecord(STORE_CHATS, chat);
}
function clearAllChats() {
  return clearStore(STORE_CHATS);
}
async function deleteChat(id) {
  const all = await getAllRecords(STORE_MESSAGES);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, "readwrite");
    const store = tx.objectStore(STORE_MESSAGES);
    for (const m of all) {
      if (m.chatId === id) store.delete(m.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return deleteRecord(STORE_CHATS, id);
}

// One-time migration: if there are no chats yet but there are pre-existing
// messages without a chatId (from before multi-chat support), file them all
// under a new default chat instead of losing them. Returns the chat id that
// should be treated as active if none is currently selected.
async function ensureDefaultChat() {
  const chats = await getAllChats();
  if (chats.length > 0) return chats[0].id;

  const defaultChatId = await addChat({ title: "Chat 1" });
  const messages = await getAllRecords(STORE_MESSAGES);
  const orphaned = messages.filter((m) => m.chatId == null);
  for (const m of orphaned) {
    await putRecord(STORE_MESSAGES, { ...m, chatId: defaultChatId });
  }
  return defaultChatId;
}

// ---------- messages (chat/call memory) ----------

// msg: { chatId, role: 'user'|'assistant', kind: 'text'|'image', text, imageThumb?, createdAt,
//        suggestions?: [string] } — suggestions are the follow-up questions from the
// reply's FOLLOWUP line (chat renders them as chips under the newest reply).
function addMessage(msg) {
  return addRecord(STORE_MESSAGES, { ...msg, createdAt: msg.createdAt || Date.now() });
}
function getAllMessages() {
  return getAllRecords(STORE_MESSAGES);
}
async function getMessagesByChat(chatId) {
  const all = await getAllRecords(STORE_MESSAGES);
  return all.filter((m) => m.chatId === chatId);
}
function updateMessage(msg) {
  return putRecord(STORE_MESSAGES, msg);
}
function clearAllMessages() {
  return clearStore(STORE_MESSAGES);
}

// ---------- tools (inventory) ----------

// tool: { name, quantity, notes, tags: [string], createdAt,
//         photoThumb?: dataURL|null, brand?, condition?, location?,
//         purchaseDate?: "YYYY-MM-DD", price?: number|null, lastUsed?: timestamp|null,
//         productInfo?: string } — productInfo is the AI's label reading of the
// item's photo (product type, active ingredients, dosage, safety), rendered as
// the "Product info" section on the detail page. Schemaless field, no DB bump.
function addTool(tool) {
  return addRecord(STORE_TOOLS, { ...tool, createdAt: Date.now() });
}
function getAllTools() {
  return getAllRecords(STORE_TOOLS);
}
function deleteTool(id) {
  return deleteRecord(STORE_TOOLS, id);
}
function updateTool(tool) {
  return putRecord(STORE_TOOLS, tool);
}
function clearAllTools() {
  return clearStore(STORE_TOOLS);
}

// ---------- saved codex entries (AI deep-search results the user kept) ----------

// entry: { title, body, sources: [url], createdAt,
//          kind?: 'plant'|'tool'|'topic', itemName?: string, auto?: boolean }
// kind/itemName/auto are set by ensureCodexResearch (helpers.jsx), which
// auto-researches every newly added plant/tool into a codex entry.
function addCodexEntry(entry) {
  return addRecord(STORE_CODEX, { ...entry, createdAt: Date.now() });
}
function getAllCodexEntries() {
  return getAllRecords(STORE_CODEX);
}
function deleteCodexEntry(id) {
  return deleteRecord(STORE_CODEX, id);
}
function clearAllCodexEntries() {
  return clearStore(STORE_CODEX);
}

// ---------- to-get list (shopping checklist) ----------

// item: { name, quantity, notes, done: boolean, createdAt }
function addShoppingItem(item) {
  return addRecord(STORE_SHOPPING, {
    name: item.name || "",
    quantity: Number(item.quantity) || 1,
    notes: item.notes || "",
    done: !!item.done,
    createdAt: Date.now(),
  });
}
function getAllShoppingItems() {
  return getAllRecords(STORE_SHOPPING);
}
function updateShoppingItem(item) {
  return putRecord(STORE_SHOPPING, item);
}
function deleteShoppingItem(id) {
  return deleteRecord(STORE_SHOPPING, id);
}
function clearAllShoppingItems() {
  return clearStore(STORE_SHOPPING);
}

// ---------- to-do list (one-off garden tasks) ----------

// todo: { text, done: boolean, completedAt: timestamp|null,
//         dueDate: "YYYY-MM-DD"|"" (optional), dueTime: "HH:MM"|"" (optional,
//         24h, DEVICE-local), notes (optional), createdAt }
// Distinct from routines (which recur on an interval) and from the to-get
// shopping list (things to BUY): a to-do is a single task to DO once.
//
// dueTime IS THE REMINDER CLOCK TIME, and it is why NO DB_VERSION BUMP was
// needed for it: an IndexedDB object store is schemaless, so every to-do
// written before this field existed simply has no `dueTime` key. Every reader
// treats a missing/blank one as "no time" and keeps the old day-granularity
// behaviour (see todoDueDelta/todoDueAt in modules/helpers.jsx), which is what
// makes adding it a pure addition rather than a migration.
// It only MEANS anything alongside a dueDate — a time with no date has no
// instant to fire at, so readers ignore it (they all require dueDate first).
function addTodo(todo) {
  return addRecord(STORE_TODOS, {
    text: todo.text || "",
    done: false,
    completedAt: null,
    dueDate: todo.dueDate || "",
    // Normalised at the storage boundary so no create path (the UI's time
    // input, an AI ADD_TODO, a future caller) can put "25:99" or "banana" in
    // the database. helpers.jsx loads immediately after this file and this
    // body only ever runs long after that, but the typeof guard keeps a
    // partial page load from breaking to-do creation outright.
    dueTime: typeof normalizeDueTime === "function" ? normalizeDueTime(todo.dueTime) : todo.dueTime || "",
    notes: todo.notes || "",
    createdAt: Date.now(),
  });
}
function getAllTodos() {
  return getAllRecords(STORE_TODOS);
}
function updateTodo(todo) {
  return putRecord(STORE_TODOS, todo);
}
function deleteTodo(id) {
  return deleteRecord(STORE_TODOS, id);
}
function clearAllTodos() {
  return clearStore(STORE_TODOS);
}

// ---------- routines (recurring care tasks) ----------

// routine: { task, intervalDays, lastDone: timestamp|null, createdAt,
//            plantId?: number|null, careAction?: ''|'water'|'fertilize', tags: [string],
//            photoThumb?: dataURL|null (cover picture, set by AI SET_COVER) }
// plantId/careAction link a routine to a plant: marking the routine done also
// stamps that plant's lastWatered/lastFertilized and appends to its history log
// (see completeRoutine in modules/helpers.jsx).
function addRoutine(routine) {
  return addRecord(STORE_ROUTINES, { ...routine, lastDone: null, createdAt: Date.now() });
}
function getAllRoutines() {
  return getAllRecords(STORE_ROUTINES);
}
function deleteRoutine(id) {
  return deleteRecord(STORE_ROUTINES, id);
}
function updateRoutine(routine) {
  return putRecord(STORE_ROUTINES, routine);
}
function clearAllRoutines() {
  return clearStore(STORE_ROUTINES);
}
function isRoutineDue(routine) {
  if (!routine.lastDone) return true;
  const dueAt = routine.lastDone + routine.intervalDays * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// ---------- plants ----------

// plant: { name, notes, plantingDate, location, lastWatered, lastFertilized,
//          tags: [string], photoHistory: [{ imageThumb?, analysis, date, kind }], createdAt,
//          coverThumb?: dataURL|null (cover picture — overrides latest gallery photo) }
function addPlant(plant) {
  return addRecord(STORE_PLANTS, {
    name: plant.name || "",
    notes: plant.notes || "",
    plantingDate: plant.plantingDate || "",
    location: plant.location || "",
    lastWatered: plant.lastWatered || null,
    lastFertilized: plant.lastFertilized || null,
    tags: plant.tags || [],
    photoHistory: [],
    createdAt: Date.now(),
  });
}
function getAllPlants() {
  return getAllRecords(STORE_PLANTS);
}
function deletePlant(id) {
  return deleteRecord(STORE_PLANTS, id);
}
function updatePlant(plant) {
  return putRecord(STORE_PLANTS, plant);
}
function clearAllPlants() {
  return clearStore(STORE_PLANTS);
}

// ---------- backup & restore (whole-database export / import) ----------
//
// Everything the app knows lives in ONE browser's IndexedDB, so clearing site
// data, reinstalling the PWA, or moving to a new phone destroys it for good.
// These functions are the only way out and back in. The Settings UI calls
// exportAllData() / importAllData(data, mode) by exactly these names.

// Every store that goes into a backup file, in the order it's written out.
const BACKUP_STORES = [
  STORE_MESSAGES,
  STORE_CHATS,
  STORE_TOOLS,
  STORE_ROUTINES,
  STORE_PLANTS,
  STORE_CODEX,
  STORE_SHOPPING,
  STORE_TODOS,
];

// Restore order — deliberately different. Plants and chats go FIRST because
// merge mode hands every imported record a NEW id, and the stores that point
// at them (routine.plantId, message.chatId) can only be remapped once those
// new ids exist.
const IMPORT_STORE_ORDER = [
  STORE_PLANTS,
  STORE_CHATS,
  STORE_MESSAGES,
  STORE_ROUTINES,
  STORE_TOOLS,
  STORE_CODEX,
  STORE_SHOPPING,
  STORE_TODOS,
];

async function exportAllData() {
  const stores = {};
  // One store at a time rather than Promise.all: a photo-heavy garden is
  // already the largest thing this app ever holds in memory at once, and
  // nothing is waiting on a backup finishing a few ms sooner.
  for (const name of BACKUP_STORES) {
    stores[name] = await getAllRecords(name);
  }
  return {
    app: "garden-companion",
    schema: DB_VERSION,
    exportedAt: Date.now(),
    // Photos are base64 data URLs held INSIDE the records themselves
    // (plant.photoHistory[].imageThumb, plant.coverThumb, tool.photoThumb,
    // message.imageThumb), so they travel with the backup for free — which is
    // also why an export of a well-used garden can run to tens of MB.
    stores: stores,
  };
}

// Import refuses anything it can't positively identify as our own backup:
// a half-restored database is far worse than a rejected file. Messages are
// written for a human because the UI shows e.message verbatim.
function assertBackupShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("That file isn't a Garden Companion backup — it isn't backup data at all.");
  }
  if (data.app !== "garden-companion") {
    throw new Error('That file isn\'t a Garden Companion backup (its "app" marker doesn\'t match).');
  }
  if (!data.stores || typeof data.stores !== "object" || Array.isArray(data.stores)) {
    throw new Error('This backup has no "stores" section, so there is nothing in it to restore.');
  }
}

// mode "replace": this device ends up matching the backup (ids preserved).
// mode "merge":   existing records are kept and the backup is added alongside.
// Returns { imported: { store: count }, skipped: [storeName], mode }.
async function importAllData(data, mode) {
  assertBackupShape(data);
  if (mode !== "replace" && mode !== "merge") {
    // Never guess a default here — guessing wrong either wipes the user's
    // garden or silently duplicates all of it.
    throw new Error('Import mode must be "replace" or "merge".');
  }

  const imported = {};
  const skipped = [];
  // oldId -> id the record actually got on THIS device (merge mode only).
  const newPlantIds = new Map();
  const newChatIds = new Map();

  // Schema tolerance: a backup from a NEWER build can carry stores this
  // version has never heard of, and one from an OLDER build simply won't have
  // some. Both are fine — import what's recognised, report the rest.
  for (const key of Object.keys(data.stores)) {
    if (BACKUP_STORES.indexOf(key) === -1) skipped.push(key);
  }

  for (const name of IMPORT_STORE_ORDER) {
    const records = data.stores[name];
    if (records === undefined) continue; // older backup: that store didn't exist yet
    if (!Array.isArray(records)) {
      skipped.push(name); // present but malformed — don't guess at it
      continue;
    }

    // Only stores the backup actually contains get cleared, so restoring an
    // OLD backup can't destroy data it has no replacement for.
    if (mode === "replace") await clearStore(name);

    let count = 0;
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue; // junk row
      const copy = { ...record };

      if (mode === "replace") {
        // putRecord, NOT addRecord: the original id HAS to survive. With new
        // ids, every cross-reference in the backup (routine.plantId,
        // message.chatId) would quietly point at the wrong record or nothing.
        await putRecord(name, copy);
        count++;
        continue;
      }

      // merge: existing records are untouched, so each imported record is
      // inserted fresh and gets a new autoIncrement id. That invalidates every
      // id the backup referred to, so references are rewritten on the way in —
      // which is why plants and chats were restored first.
      if (name === STORE_ROUTINES && copy.plantId != null) {
        // An unresolvable plantId is nulled, not kept: on this device that same
        // number belongs to a different plant, and a routine silently attached
        // to the wrong plant is worse than one with no plant at all.
        copy.plantId = newPlantIds.has(copy.plantId) ? newPlantIds.get(copy.plantId) : null;
      }
      if (name === STORE_MESSAGES && copy.chatId != null) {
        // Same trap: a stale chatId would drop imported messages into an
        // unrelated local conversation. Orphans are kept, just unfiled.
        copy.chatId = newChatIds.has(copy.chatId) ? newChatIds.get(copy.chatId) : null;
      }

      const oldId = copy.id;
      delete copy.id;
      const newId = await addRecord(name, copy);
      if (name === STORE_PLANTS && oldId != null) newPlantIds.set(oldId, newId);
      if (name === STORE_CHATS && oldId != null) newChatIds.set(oldId, newId);
      count++;
    }
    imported[name] = count;
  }

  return { imported: imported, skipped: skipped, mode: mode };
}

// Saves an export to the user's device. Not pretty-printed: indentation would
// roughly double a file that is mostly base64 photo data already.
function downloadDataBackup(data, filename) {
  const name = filename || "garden-companion-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a later tick, never in the same one as the click: iOS Safari
  // aborts an in-flight download if its object URL dies immediately.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
