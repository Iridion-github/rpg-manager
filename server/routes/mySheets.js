'use strict';

/**
 * My Characters: the characters that are yours rather than a table's.
 *
 * Every other sheet in this app belongs to a campaign - it is the table's
 * record of somebody at it, the DM decides who may read it, and it dies with
 * the campaign. These do not. They are kept under the account instead of under
 * a campaign, nobody else can see them at all, and there is no access map
 * because there is nobody to grant access to: the owner is the key.
 *
 * ## Copies, not links
 *
 * A character arrives here by being copied off a campaign sheet ("Save to My
 * Characters"), and the copy is the whole point. The two are separate records
 * from that moment: levelling up at the table does not touch the one on your
 * shelf, and tidying the one on your shelf does not reach into somebody's
 * campaign. That is what makes this safe to keep a character in - a shelf whose
 * contents changed underneath you when a DM edited something would be a shelf
 * you could not trust to hold a version.
 *
 * `savedFrom` is the one thing kept about where a copy came from: the name of
 * the campaign, as it was called on the day. A name and not an id, deliberately
 * - it is a note about provenance for the person reading it, not a pointer to
 * follow, and a campaign that has since been deleted or renamed should not turn
 * it into a broken link.
 */

const express = require('express');
const store = require('../store');
const { requireUser } = require('../auth');
const { notifyUser } = require('../realtime');
const { sanitizeSheet } = require('../sheetSchema');

const router = express.Router();

// The store mints uuids, so anything that isn't one was not minted by us. The
// same guard scoped() applies to a campaign id, and for the same reason: this
// is the one place an id becomes part of a key.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A ceiling, not a policy. Nobody has two hundred characters; somebody with a
 * script does, and an unbounded shelf under an account is a way to fill the
 * disk with one endpoint.
 */
const MAX_SHEETS = 200;

function shelfOf(req) {
  const userId = req.actor?.userId;
  if (!UUID_RE.test(String(userId || ''))) {
    const err = new Error('Bad account id');
    err.status = 400;
    throw err;
  }
  return `users/${userId}/sheets`;
}

// Where this copy came from, as a note. Long enough for any campaign name the
// app will accept, and a plain string whatever arrives.
const noteOf = (value) => String(value ?? '').slice(0, 120);

// Only this person's own connections, wherever they are looking: these are not
// a table's records, so there is no table to tell. Two tabs open on the same
// account is the whole of the audience.
const announce = (req, action, record) =>
  notifyUser(req, req.actor.userId, 'mysheets:changed', { action, record });

// Everything here is about the account making the request, so there is no id in
// any of these URLs saying whose - and therefore no way to ask for somebody
// else's by changing one.
router.use(requireUser);

router.get('/', async (req, res, next) => {
  try {
    res.json(await store.list(shelfOf(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * Put a character on the shelf: a blank one, or a copy of one from a table.
 *
 * One route for both, because they differ only in what is in the body - an
 * empty body sanitises into a blank character sheet, which is exactly what
 * "+ New character" wants.
 */
router.post('/', async (req, res, next) => {
  try {
    const shelf = shelfOf(req);
    const held = await store.list(shelf);
    if (held.length >= MAX_SHEETS) {
      return res
        .status(409)
        .json({ error: `You can keep ${MAX_SHEETS} characters here. Delete one to make room.` });
    }
    const record = await store.create(shelf, {
      ...sanitizeSheet(req.body),
      savedFrom: noteOf(req.body?.savedFrom),
    });
    announce(req, 'update', record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const record = await store.mutate(shelfOf(req), req.params.id, (current) => ({
      ...sanitizeSheet(req.body),
      // Taken from the stored record, never the body: where a copy came from is
      // a fact about the day it was made, and editing the character is not the
      // act that changes it. The same reasoning that keeps `access` out of an
      // edit on the campaign side.
      savedFrom: current.savedFrom || '',
    }));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// No requireDm and nothing to ask: this shelf is one person's, and deleting
// from it takes nothing away from anybody else. The copy at the table is a
// different record and is not touched.
router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await store.remove(shelfOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
