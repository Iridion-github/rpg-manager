'use strict';

/**
 * Tiny file-based JSON store — our stand-in for a database.
 *
 * Each "collection" (e.g. "sheets") is one JSON file under DATA_DIR, holding an
 * object keyed by record id: { [id]: record }.
 *
 * Two safety properties matter because flat files have no transactions:
 *   1. Atomic writes  — we write to a temp file then rename() over the target,
 *      so a crash mid-write can never leave a half-written (corrupt) file.
 *   2. Serialized writes — all mutations for a given file go through a per-file
 *      promise queue, so two concurrent saves can't clobber each other.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

// One promise chain per file path — the tail of the chain is the "current" work.
const writeQueues = new Map();

function enqueue(file, task) {
  const prev = writeQueues.get(file) || Promise.resolve();
  // Run task after prev settles, regardless of whether prev failed.
  const next = prev.then(task, task);
  // Keep a swallowed copy in the map so one failure doesn't poison the chain.
  writeQueues.set(file, next.then(() => {}, () => {}));
  return next;
}

function fileFor(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

async function readCollection(collection) {
  try {
    const raw = await fsp.readFile(fileFor(collection), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // no file yet == empty collection
    throw err;
  }
}

async function writeCollectionAtomic(collection, data) {
  const file = fileFor(collection);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file); // atomic on the same filesystem
}

// ---- Public CRUD API ----

async function list(collection) {
  const data = await readCollection(collection);
  return Object.values(data).sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || '')
  );
}

async function get(collection, id) {
  const data = await readCollection(collection);
  return data[id] || null;
}

async function create(collection, doc) {
  return enqueue(fileFor(collection), async () => {
    const data = await readCollection(collection);
    const id = doc.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const record = { ...doc, id, createdAt: now, updatedAt: now };
    data[id] = record;
    await writeCollectionAtomic(collection, data);
    return record;
  });
}

async function update(collection, id, patch) {
  return enqueue(fileFor(collection), async () => {
    const data = await readCollection(collection);
    if (!data[id]) return null;
    const record = { ...data[id], ...patch, id, updatedAt: new Date().toISOString() };
    data[id] = record;
    await writeCollectionAtomic(collection, data);
    return record;
  });
}

/**
 * Read-modify-write a single record *inside* the write queue.
 *
 * `update` is a shallow merge, which can't express "change one token inside
 * this scene's array" — doing that as read-then-update would race, because
 * another writer can land between the two calls. Here the mutator runs while we
 * hold the queue, so it always sees the current record.
 *
 * The mutator may throw to abort; the error propagates and nothing is written.
 */
async function mutate(collection, id, mutator) {
  return enqueue(fileFor(collection), async () => {
    const data = await readCollection(collection);
    const current = data[id];
    if (!current) return null;
    const updated = await mutator(current);
    if (!updated) return null;
    const record = { ...updated, id, updatedAt: new Date().toISOString() };
    data[id] = record;
    await writeCollectionAtomic(collection, data);
    return record;
  });
}

async function remove(collection, id) {
  return enqueue(fileFor(collection), async () => {
    const data = await readCollection(collection);
    if (!data[id]) return false;
    delete data[id];
    await writeCollectionAtomic(collection, data);
    return true;
  });
}

module.exports = { DATA_DIR, list, get, create, update, mutate, remove };
