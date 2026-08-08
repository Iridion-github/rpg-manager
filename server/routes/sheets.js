'use strict';

/**
 * Character sheets within one campaign, and who is allowed to read or change
 * one.
 *
 * Each sheet carries an `access` map (userId → 'view' | 'edit') that only the
 * DM can change — it has its own endpoint precisely so that "edit this
 * character" and "decide who may edit this character" can never be the same
 * request. A player editing their own sheet sends the whole sheet back, and if
 * access travelled in that body they could promote themselves in the process.
 *
 * The rule is enforced on the way out as well as on the way in: a player is
 * never *sent* a sheet they can't see, so there's nothing in their browser to
 * uncover with the dev tools.
 */

const express = require('express');
const store = require('../store');
const { broadcastPerActor } = require('../realtime');
const {
  scoped,
  requireDm,
  canViewSheet,
  canEditSheet,
  sanitizeSheetAccess,
} = require('../campaigns');
const { sanitizeSheet } = require('../sheetSchema');

const COLLECTION = 'sheets';
const router = express.Router({ mergeParams: true });

const sheetsOf = (req) => scoped(req.campaignId, COLLECTION);

/**
 * Tell each connection what *it* is allowed to know.
 *
 * Everyone who can see the sheet gets the new version; everyone who can't gets
 * a delete. That second half is what makes revoking access take effect live:
 * the player it was taken from is told the sheet is gone, rather than keeping a
 * stale copy on screen until they happen to reload. Telling someone to delete a
 * sheet they never had is a no-op on their end, so it needs no special case.
 */
function announce(req, record) {
  broadcastPerActor(req, 'sheets:changed', (actor, role) =>
    canViewSheet(actor, role, record)
      ? { action: 'update', record }
      : { action: 'delete', record: { id: record.id } }
  );
}

router.get('/', async (req, res, next) => {
  try {
    const sheets = await store.list(sheetsOf(req));
    res.json(sheets.filter((s) => canViewSheet(req.actor, req.campaignRole, s)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await store.get(sheetsOf(req), req.params.id);
    // Invisible reads as absent, not as forbidden — "you may not see this"
    // still tells a player whose sheet exists.
    if (!record || !canViewSheet(req.actor, req.campaignRole, record)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireDm, async (req, res, next) => {
  try {
    // A new sheet starts DM-only unless the DM says otherwise: handing it out
    // is a decision, and defaulting to "everyone" is the wrong way to be wrong.
    const record = await store.create(sheetsOf(req), {
      ...sanitizeSheet(req.body),
      access: sanitizeSheetAccess(req.body.access),
    });
    announce(req, record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    // The permission check runs inside the write lock, against the record as it
    // actually is — checking first and writing after would let the DM's
    // revocation land in between and be overtaken by the write it revoked.
    let seen = null;
    const record = await store.mutate(sheetsOf(req), req.params.id, (current) => {
      seen = current;
      if (!canEditSheet(req.actor, req.campaignRole, current)) return null; // write nothing
      // access is deliberately taken from the stored record, never the body.
      return { ...sanitizeSheet(req.body), access: current.access || {} };
    });

    if (!record) {
      if (!seen || !canViewSheet(req.actor, req.campaignRole, seen)) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.status(403).json({ error: 'This sheet is read-only for you.' });
    }

    announce(req, record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// Who may see and edit this sheet — the DM's call alone.
router.put('/:id/access', requireDm, async (req, res, next) => {
  try {
    const access = sanitizeSheetAccess(req.body?.access);
    const record = await store.mutate(sheetsOf(req), req.params.id, (current) => ({
      ...current,
      access,
    }));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    const ok = await store.remove(sheetsOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    // A deletion is safe to tell the table about: an id they can't resolve to a
    // sheet tells them nothing.
    broadcastPerActor(req, 'sheets:changed', () => ({
      action: 'delete',
      record: { id: req.params.id },
    }));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
