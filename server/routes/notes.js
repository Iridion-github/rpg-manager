'use strict';

/**
 * Notes and handouts, within one campaign.
 *
 * One collection covering both, separated by a single flag: a note with
 * `shared: false` is the DM's private prep, and flipping it to true turns the
 * same record into a handout the table can read. Two collections would mean
 * "publish this" was a delete-and-recreate, which loses the id and the history.
 *
 * Only the DM writes. Every member may read — but the *server* decides what
 * "read" returns: a player never receives an unshared note at all, rather than
 * being sent everything and trusted to hide it. A body that reaches the browser
 * has already left your control.
 */

const express = require('express');
const store = require('../store');
const { broadcast } = require('../realtime');
const { scoped, requireDm } = require('../campaigns');
const { postSystemMessage } = require('./chat');

const COLLECTION = 'notes';
const MAX_TITLE = 120;
const MAX_BODY = 20000; // a handout, not a novel

const router = express.Router({ mergeParams: true });

const notesOf = (req) => scoped(req.campaignId, COLLECTION);

function sanitize(body = {}) {
  return {
    title: String(body.title ?? '').trim().slice(0, MAX_TITLE) || 'Untitled note',
    body: String(body.body ?? '').slice(0, MAX_BODY),
    shared: Boolean(body.shared),
  };
}

const canRead = (role, note) => role === 'dm' || note.shared === true;

/**
 * Live updates carry only *what* changed, never the record.
 *
 * A broadcast goes to every member of the campaign regardless of role, so
 * shipping the note along would hand a player the text of a note they can't
 * read. The signal makes clients re-fetch instead, and that fetch is filtered
 * per role.
 */
function announce(req, action, id) {
  broadcast(req, 'notes:changed', { action, id });
}

// Sharing is worth saying out loud — a handout nobody notices may as well not
// exist. Only the false → true edge announces, so re-saving a shared note
// doesn't nag the table.
function announceShare(req, record) {
  return postSystemMessage(req, `shared a handout: “${record.title}”`);
}

router.get('/', async (req, res, next) => {
  try {
    const notes = await store.list(notesOf(req));
    res.json(notes.filter((n) => canRead(req.campaignRole, n)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await store.get(notesOf(req), req.params.id);
    // A private note reads as absent rather than forbidden: "you may not see
    // this" still tells a player there is something to see.
    if (!record || !canRead(req.campaignRole, record)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireDm, async (req, res, next) => {
  try {
    const record = await store.create(notesOf(req), sanitize(req.body));
    announce(req, 'create', record.id);
    if (record.shared) await announceShare(req, record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireDm, async (req, res, next) => {
  try {
    // mutate, not update: we need the *previous* shared flag to spot the edge,
    // and reading it before an update would race with another save landing in
    // between. No createIfMissing — a PUT to a deleted note is a 404, not a
    // resurrection.
    let wasShared = false;
    const record = await store.mutate(notesOf(req), req.params.id, (current) => {
      wasShared = Boolean(current.shared);
      return { ...current, ...sanitize(req.body) };
    });
    if (!record) return res.status(404).json({ error: 'Not found' });

    announce(req, 'update', record.id);
    if (record.shared && !wasShared) await announceShare(req, record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    const ok = await store.remove(notesOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
