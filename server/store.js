'use strict';

/**
 * The store — now SQLite, with the same six verbs it always had.
 *
 * Everything above this file (71 call sites, at last count) speaks in
 * collections and records and knows nothing about how they're kept. That was
 * true when this wrote JSON files and it stays true now, which is why swapping
 * the engine underneath cost one module rather than a rewrite.
 *
 * ## Why the table looks like this
 *
 * One `records` table of (collection, id, JSON), not a normalised schema. A
 * character sheet is a document — nested abilities, skills, a spell list — and
 * nothing ever asks "every character with STR above 15". Shredding it across
 * eighty columns would buy joins and cost clarity. Where a *constraint* is
 * genuinely worth having, an expression index provides it: see the unique
 * indexes on username and email below, which turn a check-then-write race into
 * something the database refuses outright.
 *
 * ## Campaign isolation
 *
 * The collection name carries the campaign — `campaigns/<uuid>/sheets` — and it
 * is the leading half of the primary key. That's deliberate. The obvious SQL
 * translation would have been one `sheets` table with a `campaign_id` column,
 * and then every query that forgets its WHERE clause silently serves another
 * table's secrets. Here there is no query without a collection, because there's
 * no row you can reach without its key.
 *
 * ## Transactions
 *
 * `mutate()` used to exist because files have no transactions: it hand-rolled
 * read-modify-write inside a per-file promise queue. It's now a real
 * transaction, and the queue is gone.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, 'rpg-manager.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);

// WAL lets reads carry on during a write, which matters when a token drop and a
// chat message land together. FULL sync costs a little speed for the guarantee
// that a committed write survives losing power — this is somebody's campaign on
// a home PC, and the write volume is tiny.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID;
`);

/**
 * Uniqueness the database enforces, rather than the application hoping for.
 *
 * Registration checks for a duplicate username and then inserts, and between
 * those two steps another registration can land — a race no amount of care in
 * JavaScript closes. These make the second insert fail instead. The routes keep
 * their friendly check because it gives a better message; this is the backstop
 * that makes the check honest.
 */
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON records (json_extract(data, '$.username'))
    WHERE collection = 'users' AND json_extract(data, '$.username') IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON records (json_extract(data, '$.email'))
    WHERE collection = 'users' AND json_extract(data, '$.email') IS NOT NULL;
`);

const statements = {
  get: db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?'),
  // Ordered by creation so lists read in the order things were made, exactly as
  // they did when this sorted an object's values by createdAt. The id breaks
  // ties, so two records made in the same millisecond still have a stable order.
  list: db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY created_at, id'),
  upsert: db.prepare(`
    INSERT INTO records (collection, id, data, created_at, updated_at)
    VALUES (@collection, @id, @data, @createdAt, @updatedAt)
    ON CONFLICT (collection, id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `),
  remove: db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
  removePrefix: db.prepare(
    String.raw`DELETE FROM records WHERE collection = ? OR collection LIKE ? ESCAPE '\'`
  ),
  count: db.prepare('SELECT COUNT(*) AS n FROM records'),
};

const now = () => new Date().toISOString();
const parse = (row) => (row ? JSON.parse(row.data) : null);

// The record is stored whole, timestamps included, so what comes back out is
// exactly what went in. The columns are copies for ordering — written in the
// same statement as the JSON, so the two cannot drift.
function write(collection, record) {
  statements.upsert.run({
    collection,
    id: record.id,
    data: JSON.stringify(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return record;
}

// ---- Public CRUD API ----

async function list(collection) {
  return statements.list.all(collection).map(parse);
}

async function get(collection, id) {
  return parse(statements.get.get(collection, id));
}

async function create(collection, doc) {
  const id = doc.id || crypto.randomUUID();
  const stamp = now();
  return write(collection, { ...doc, id, createdAt: stamp, updatedAt: stamp });
}

async function update(collection, id, patch) {
  const run = db.transaction(() => {
    const current = parse(statements.get.get(collection, id));
    if (!current) return null;
    return write(collection, { ...current, ...patch, id, updatedAt: now() });
  });
  return run();
}

/**
 * Read-modify-write a single record inside a transaction.
 *
 * `update` is a shallow merge, which can't express "change one token inside
 * this scene's array". Doing that as read-then-update would race; here the
 * mutator runs inside the transaction, so it always sees the current record and
 * anything it throws rolls the whole thing back.
 *
 * `createIfMissing` supplies a starting record when there isn't one yet, so
 * "create it if absent, then modify it" stays a single transaction.
 */
async function mutate(collection, id, mutator, { createIfMissing = null } = {}) {
  const run = db.transaction(() => {
    let current = parse(statements.get.get(collection, id));
    if (!current && createIfMissing) {
      current = { ...createIfMissing, id, createdAt: now() };
    }
    if (!current) return null;

    const updated = mutator(current);
    // A mutator that awaits would return a promise here, and the transaction
    // would commit before its work happened. Better to say so than to write
    // half a change.
    if (updated && typeof updated.then === 'function') {
      throw new Error('store.mutate: the mutator must be synchronous — it runs inside a transaction.');
    }
    if (!updated) return null;

    // createdAt leads so a mutator that returns a fresh record — rather than
    // spreading the one it was handed — keeps the original birthday instead of
    // writing NULL into a NOT NULL column. It's before the spread, not after,
    // so a mutator that genuinely means to set one still wins.
    return write(collection, { createdAt: current.createdAt, ...updated, id, updatedAt: now() });
  });
  return run();
}

async function remove(collection, id) {
  return statements.remove.run(collection, id).changes > 0;
}

/**
 * Delete a collection and everything nested under it.
 *
 * Deleting a campaign used to be deleting a directory; it's now one statement
 * against the key prefix, which is the same idea expressed in SQL.
 */
async function removeTree(prefix) {
  const clean = prefix.replace(/\/$/, '');
  // Escape the LIKE wildcards a uuid can't contain but a caller might.
  const pattern = `${clean.replace(/[%_\\]/g, '\\$&')}/%`;
  return statements.removePrefix.run(clean, pattern).changes;
}

const isEmpty = () => statements.count.get().n === 0;

module.exports = { DATA_DIR, DB_FILE, db, list, get, create, update, mutate, remove, removeTree, isEmpty };
