// IndexedDB-backed offline cache.
//
// Every successful load from the server is mirrored here. When the server is
// your PC and it's offline, the app reads this snapshot instead so friends can
// still VIEW the last-synced data (read-only). We keep it deliberately tiny:
// one object store per kind of record, keyed by id, plus a "last synced"
// timestamp in localStorage (a single scalar doesn't justify its own store).
//
// Records are tagged with the campaign they came from, and every read and write
// is scoped to one. Without that, opening a second campaign would overwrite the
// first one's snapshot - and worse, the offline view would show you a mixture
// of two tables with no way to tell which was which.
//
// We only ever cache what the server chose to send us, which is what keeps a
// player's browser from holding the DM's private notes: they were filtered out
// upstream, so they were never ours to store.

const DB_NAME = 'rpg-manager';
const DB_VERSION = 2; // 2 added the notes store
const STORES = ['sheets', 'notes'];
const SYNC_KEY = 'rpg-manager:lastSynced';
const TAG = '_campaign';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Creating only what's missing makes this both the first-run setup and
      // the upgrade path from an older version.
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGetAll(kind, campaignId) {
  if (!campaignId) return [];
  const db = await openDB();
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(kind, 'readonly');
      const req = tx.objectStore(kind).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all
      .filter((r) => r[TAG] === campaignId)
      .map(({ [TAG]: _drop, ...record }) => record);
  } finally {
    db.close();
  }
}

/**
 * The tag the characters on your own shelf are kept under.
 *
 * Not a campaign, so not a campaign id - and it cannot collide with one, since
 * every campaign id is a uuid. They share the store with the tables' sheets
 * because they are the same kind of thing to read back; they are separate
 * records, so there is nothing for the two to overwrite in each other.
 */
export const MINE = '@mine';

// Replace this campaign's snapshot with the latest server state. Records
// belonging to *other* campaigns are left alone; within this one it's a
// clear-then-fill, which is what makes deletions propagate - a record the
// server no longer has must not survive in the cache.
export async function cachePutAll(kind, campaignId, records) {
  if (!campaignId) return;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(kind, 'readwrite');
      const store = tx.objectStore(kind);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          if (cursor.value?.[TAG] === campaignId) cursor.delete();
          cursor.continue();
          return;
        }
        // Cursor exhausted - the old snapshot is gone, write the new one.
        for (const r of records) store.put({ ...r, [TAG]: campaignId });
      };
      cursorReq.onerror = () => reject(cursorReq.error);
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
