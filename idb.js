// Minimal IndexedDB wrapper — this IS the app's "memory". Everything here stays
// on this device/browser only (no server-side sync).
const DB_NAME = "garden-companion";
const DB_VERSION = 3;
const STORE_MESSAGES = "messages";
const STORE_TOOLS = "tools";
const STORE_ROUTINES = "routines";
const STORE_PLANTS = "plants";
const STORE_CHATS = "chats";

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

// chat: { title, createdAt }
export function addChat(chat) {
  return addRecord(STORE_CHATS, { title: chat.title || "New chat", createdAt: Date.now() });
}
export function getAllChats() {
  return getAllRecords(STORE_CHATS);
}
export function updateChat(chat) {
  return putRecord(STORE_CHATS, chat);
}
export function clearAllChats() {
  return clearStore(STORE_CHATS);
}
export async function deleteChat(id) {
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
export async function ensureDefaultChat() {
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

// msg: { chatId, role: 'user'|'assistant', kind: 'text'|'image', text, imageThumb?, createdAt }
export function addMessage(msg) {
  return addRecord(STORE_MESSAGES, { ...msg, createdAt: msg.createdAt || Date.now() });
}
export function getAllMessages() {
  return getAllRecords(STORE_MESSAGES);
}
export async function getMessagesByChat(chatId) {
  const all = await getAllRecords(STORE_MESSAGES);
  return all.filter((m) => m.chatId === chatId);
}
export function clearAllMessages() {
  return clearStore(STORE_MESSAGES);
}

// ---------- tools (inventory) ----------

// tool: { name, quantity, createdAt }
export function addTool(tool) {
  return addRecord(STORE_TOOLS, { ...tool, createdAt: Date.now() });
}
export function getAllTools() {
  return getAllRecords(STORE_TOOLS);
}
export function deleteTool(id) {
  return deleteRecord(STORE_TOOLS, id);
}
export function updateTool(tool) {
  return putRecord(STORE_TOOLS, tool);
}

// ---------- routines (recurring care tasks) ----------

// routine: { task, intervalDays, lastDone: timestamp|null, createdAt }
export function addRoutine(routine) {
  return addRecord(STORE_ROUTINES, { ...routine, lastDone: null, createdAt: Date.now() });
}
export function getAllRoutines() {
  return getAllRecords(STORE_ROUTINES);
}
export function deleteRoutine(id) {
  return deleteRecord(STORE_ROUTINES, id);
}
export function updateRoutine(routine) {
  return putRecord(STORE_ROUTINES, routine);
}
export function isRoutineDue(routine) {
  if (!routine.lastDone) return true;
  const dueAt = routine.lastDone + routine.intervalDays * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

// ---------- plants ----------

// plant: { name, notes, plantingDate, location, lastWatered, lastFertilized,
//          photoHistory: [{ imageThumb, analysis, date }], createdAt }
export function addPlant(plant) {
  return addRecord(STORE_PLANTS, {
    name: plant.name || "",
    notes: plant.notes || "",
    plantingDate: plant.plantingDate || "",
    location: plant.location || "",
    lastWatered: plant.lastWatered || null,
    lastFertilized: plant.lastFertilized || null,
    photoHistory: [],
    createdAt: Date.now(),
  });
}
export function getAllPlants() {
  return getAllRecords(STORE_PLANTS);
}
export function deletePlant(id) {
  return deleteRecord(STORE_PLANTS, id);
}
export function updatePlant(plant) {
  return putRecord(STORE_PLANTS, plant);
}
