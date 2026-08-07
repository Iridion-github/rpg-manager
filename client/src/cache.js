// IndexedDB-backed offline cache.
//
// Every successful load from the server is mirrored here. When the server is
// your PC and it's offline, the app reads this snapshot instead so friends can
// still VIEW the last-synced data (read-only). We keep it deliberately tiny:
// one object store keyed by record id, plus a "last synced" timestamp in
// localStorage (a single scalar doesn't justify its own store).

const DB_NAME = 'rpg-manager';
const DB_VERSION = 1;
const STORE = 'sheets';
const SYNC_KEY = 'rpg-manager:lastSynced';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGetAllSheets() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// Replace the whole snapshot with the latest server state.
export async function cachePutAllSheets(records) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const r of records) store.put(r);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    localStorage.setItem(SYNC_KEY, new Date().toISOString());
  } finally {
    db.close();
  }
}

export function getLastSynced() {
  return localStorage.getItem(SYNC_KEY) || '';
}
