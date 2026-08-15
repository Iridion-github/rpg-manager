'use strict';

/**
 * Character sheets within one campaign, and who is allowed to read or change
 * one.
 *
 * Each sheet carries an `access` map (userId → 'view' | 'edit') that only the
 * DM can change - it has its own endpoint precisely so that "edit this
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
const sheetLink = require('../sheetLink');
const {
  scoped,
  requireDm,
  canViewSheet,
  canEditSheet,
  sanitizeSheetAccess,
  sceneAsSeenBy,
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
    // Invisible reads as absent, not as forbidden - "you may not see this"
    // still tells a player whose sheet exists.
    if (!record || !canViewSheet(req.actor, req.campaignRole, record)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

/**
 * Make a character. Anyone at the table may - see who ends up holding it.
 *
 * Not `requireDm`, unlike notes and scenes, and the difference is the point: a
 * note is the DM's material and a scene is their board, but a character is the
 * one thing at a table that belongs to the person playing it. Making somebody
 * ask for a blank sheet is a queue for a piece of paper.
 *
 * `attachCampaign` has already refused anybody who isn't at this table, so the
 * only question left is who the new sheet answers to, and that turns on which
 * of the two made it.
 */
router.post('/', async (req, res, next) => {
  try {
    const dm = req.campaignRole === 'dm';
    const access = dm
      ? // A DM's new sheet starts DM-only unless they say otherwise: handing it
        // out is a decision, and defaulting to "everyone" is the wrong way to
        // be wrong. The access panel is how they then hand it over.
        sanitizeSheetAccess(req.body.access)
      : // A player's own character is theirs from the moment it exists -
        // anything else would mean making one you then have to be given.
        //
        // Built here rather than read from the body, which is deliberate: a
        // player must not be able to grant access to anybody, including
        // themselves at a level they didn't earn or somebody else at any level.
        // The DM decides who else may see this, through the route below.
        { [req.actor.userId]: 'edit' };

    const record = await store.create(sheetsOf(req), {
      ...sanitizeSheet(req.body),
      access,
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
    // actually is - checking first and writing after would let the DM's
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

    // Carry the shared numbers to every token holding this character. After the
    // write rather than inside it: the sheet is the record being saved, and a
    // token that could not be updated must not cost somebody the edit they were
    // making to their own character.
    const touched = await sheetLink.pushSheetToTokens(req.campaignId, record);

    announce(req, record);
    // Those tokens are on maps, and the tabletop is watching a different event.
    // The whole scene is sent rather than a nudge, because that is what the
    // board redraws from - and a character can now be standing on more than one
    // of them at once.
    for (const sceneId of touched) {
      const scene = await store.get(scoped(req.campaignId, 'scenes'), sceneId);
      // Per actor, like everything else that carries a scene: a token the DM
      // has hidden is not on the players' board, and a character sheet edit
      // must not be the thing that puts it there. See sceneAsSeenBy.
      if (scene) {
        broadcastPerActor(req, 'scenes:changed', (actor, role) => ({
          action: 'token:update',
          record: sceneAsSeenBy(role, scene),
        }));
      }
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// Who may see and edit this sheet - the DM's call alone.
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

// Deleting stays the DM's, even for a sheet a player made themselves. Making a
// character is not a decision anybody needs protecting from; destroying one is,
// and the person best placed to notice that a character is still needed is the
// one running the campaign it is in.
router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    // Release the token first. Doing it after the delete would be the same
    // outcome, but a failure between the two would leave a token pointing at a
    // sheet that no longer exists - whereas a failure here leaves a released
    // token and a sheet that is still there, which is merely the state before
    // somebody pressed the button.
    await sheetLink.releaseSheet(req.campaignId, req.params.id);
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
