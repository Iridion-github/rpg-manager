'use strict';

/**
 * Notes and handouts, within one campaign.
 *
 * One collection covering both, separated by who may read the record rather
 * than by where it is kept: the DM's private prep and the letter the party just
 * found are the same kind of thing, one sentence apart. Two collections would
 * make "hand this out" a delete-and-recreate, which loses the id and everything
 * hanging off it.
 *
 * ## Who may read one
 *
 * Every note carries a `visibility`, and it is the whole of the rule:
 *
 *   private  nobody but the author. Not the other DM, not the admin.
 *   shared   the author, plus the people named in `sharedWith`.
 *   public   anybody at this table - including whoever joins next week,
 *            because this asks the campaign who its members are at the moment
 *            of reading rather than freezing a list at the moment of sharing.
 *
 * It replaced a single `shared` boolean, which could only say "the DM" or
 * "everybody". Notes written under it are still read here: see visibilityOf,
 * where true becomes public and false becomes private, which is exactly what
 * those two meant.
 *
 * ## Who may change one
 *
 * The author, and nobody else, however widely it is shared. Being given a note
 * is being given something to read - a player who could edit the handout in
 * front of them could rewrite what the DM handed the table, and a second DM
 * could quietly edit the first one's prep.
 *
 * `createdBy` is what records that. A note whose author cannot be found at this
 * table - one written before the field existed, or by somebody since removed
 * from the campaign - falls back to the DM's chair instead, which is precisely
 * what every note in this collection allowed on the day before this was
 * written. See authorIsHere for why that fallback has to exist at all.
 *
 * ## What actually leaves the server
 *
 * A player is never *sent* a note they may not read, rather than being sent
 * everything and trusted to hide it. A body that reaches the browser has
 * already left your control.
 */

const express = require('express');
const store = require('../store');
const { broadcast } = require('../realtime');
const { scoped, requireDm } = require('../campaigns');
const { postSystemMessage } = require('./chat');

const COLLECTION = 'notes';
const MAX_TITLE = 120;
const MAX_BODY = 20000; // a handout, not a novel
const MAX_SHARED_WITH = 100; // a table, not a mailing list

const VISIBILITIES = new Set(['private', 'shared', 'public']);

const router = express.Router({ mergeParams: true });

const notesOf = (req) => scoped(req.campaignId, COLLECTION);

/**
 * What this note's visibility is, including for notes that predate the word.
 *
 * The old boolean said "the DM alone" or "the whole table", which are private
 * and public under the new names. Read here rather than migrated in a batch:
 * the mapping is total and lossless, so a note that is never opened again never
 * needs rewriting, and one that is saved is written in the new shape on its way
 * past.
 */
function visibilityOf(note) {
  if (VISIBILITIES.has(note?.visibility)) return note.visibility;
  return note?.shared === true ? 'public' : 'private';
}

const sharedWithOf = (note) => (Array.isArray(note?.sharedWith) ? note.sharedWith : []);

/**
 * The shape a note leaves in.
 *
 * Normalised on the way out so that no client ever has to know the old boolean
 * existed, and `shared` is dropped rather than carried: two fields answering
 * the same question is how they come to disagree.
 */
function present(note) {
  const { shared, ...rest } = note;
  return {
    ...rest,
    visibility: visibilityOf(note),
    sharedWith: sharedWithOf(note),
    createdBy: note.createdBy || null,
  };
}

/** Ids of people a note is shared with - deduped, and shaped like our ids. */
function pickSharedWith(source) {
  if (!Array.isArray(source)) return [];
  const out = [];
  for (const raw of source.slice(0, MAX_SHARED_WITH)) {
    const id = String(raw ?? '');
    // Not checked against the campaign's members, deliberately, and for the
    // same reason a sheet's access map isn't: every route here runs behind
    // attachCampaign, so somebody who has left the table cannot reach a note
    // whatever this list says. A leftover id is dead weight, not a way in - and
    // keeping it means a player who is added back gets their handouts back.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Everything a writer may decide about a note.
 *
 * `sharedWith` is kept whatever the visibility says, rather than emptied the
 * moment somebody switches to Private or Public. The list is a decision about
 * people - "these three" - and the visibility is a decision about whether it is
 * in force; throwing the names away on the way past Public would mean rebuilding
 * them by hand to go back, which is the same reason the sheet's modifier lists
 * keep their rows when their master switch goes off.
 */
function sanitize(body = {}) {
  return {
    title: String(body.title ?? '').trim().slice(0, MAX_TITLE) || 'Untitled note',
    body: String(body.body ?? '').slice(0, MAX_BODY),
    visibility: VISIBILITIES.has(body.visibility) ? body.visibility : visibilityOf(body),
    sharedWith: pickSharedWith(body.sharedWith),
  };
}

/**
 * Whose note is this?
 *
 * Null for one written before notes had authors. Every rule below treats that
 * as "the DM's", which is what it was.
 */
const authorOf = (note) => note?.createdBy || null;

/**
 * Is the person who wrote this still at this table?
 *
 * Asked because an author who isn't leaves a note nobody in the world can
 * change - and there are two ordinary ways to get one. A DM can be removed from
 * a campaign, and a campaign can be carried to another server as a file, where
 * every id in it names somebody who does not exist there.
 *
 * A note in that state falls back to the DM's chair, exactly like one written
 * before authors were recorded. That is a deliberate loosening and it is worth
 * saying what it costs: the private notes of a DM who leaves become readable by
 * whoever runs the table after them. The alternative is prep that outlives its
 * author as a locked box, on a tool whose whole point is running the game.
 *
 * The admin is never in a members map (see roleIn in campaigns.js), so notes
 * they write at somebody else's table are authorless by this rule too. That is
 * the right way round: this account administers the server rather than playing
 * here, and the table's own DM should not be locked out of a note it left
 * behind.
 */
const authorIsHere = (campaign, note) => {
  const author = authorOf(note);
  return Boolean(author) && Boolean(campaign?.members?.[author]);
};

const isAuthor = (req, note) => authorOf(note) === req.actor?.userId && Boolean(authorOf(note));

const canEditNote = (req, note) =>
  isAuthor(req, note) || (!authorIsHere(req.campaign, note) && req.campaignRole === 'dm');

function canReadNote(req, note) {
  // Whoever may change it may obviously read it - and this is also what lets an
  // author see their own private note, which nothing below would.
  if (canEditNote(req, note)) return true;
  const visibility = visibilityOf(note);
  if (visibility === 'public') return true;
  if (visibility === 'shared') {
    return Boolean(req.actor?.userId) && sharedWithOf(note).includes(req.actor.userId);
  }
  return false;
}

/**
 * Live updates carry only *what* changed, never the record.
 *
 * A broadcast goes to every member of the campaign regardless of role, so
 * shipping the note along would hand somebody the text of a note they can't
 * read. The signal makes clients re-fetch instead, and that fetch is filtered
 * per person - which is what makes taking a note back take effect at once, on
 * the screen of somebody who has it open.
 */
function announce(req, action, id) {
  broadcast(req, 'notes:changed', { action, id });
}

/**
 * Say out loud that the table has been handed something.
 *
 * Only for a note that has just become public. A handout nobody notices may as
 * well not exist, so the whole table gets a line about it - but the whole table
 * is exactly who this line reaches, which is why a note shared with two named
 * people does not get one: announcing it would tell the other five that
 * something had been handed to somebody, which is both noise to them and more
 * than the DM chose to say. Those two find it in their handouts, live, the
 * moment it is shared.
 */
function announcePublic(req, record) {
  return postSystemMessage(req, `shared a handout: “${record.title}”`);
}

router.get('/', async (req, res, next) => {
  try {
    const notes = await store.list(notesOf(req));
    res.json(
      notes.filter((n) => canReadNote(req, n)).map(present)
    );
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const record = await store.get(notesOf(req), req.params.id);
    // A note you may not read is absent rather than forbidden: "you may not see
    // this" still tells somebody there is something to see.
    if (!record || !canReadNote(req, record)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(present(record));
  } catch (err) {
    next(err);
  }
});

/**
 * Write a note. The DM's, still.
 *
 * Not because a player has nothing worth writing down, but because this is the
 * DM's prep drawer and the tab is theirs; a player's own notes would be a
 * different feature with a different question to answer (who else, if anyone,
 * ever sees them). What has changed is that the author is now recorded, which
 * is what every rule above turns on.
 */
router.post('/', requireDm, async (req, res, next) => {
  try {
    const record = await store.create(notesOf(req), {
      ...sanitize(req.body),
      createdBy: req.actor.userId,
    });
    announce(req, 'create', record.id);
    if (visibilityOf(record) === 'public') await announcePublic(req, record);
    res.status(201).json(present(record));
  } catch (err) {
    next(err);
  }
});

/**
 * Edit a note, sharing included.
 *
 * Both in one request, unlike a character sheet - where who may read it has an
 * endpoint of its own precisely because the person editing the sheet is not the
 * person who decides that. Here they are the same person by definition: only
 * the author may write at all, and the author is exactly who may say who else
 * reads it. A second route would be the same permission asked twice.
 */
router.put('/:id', async (req, res, next) => {
  try {
    // The check runs inside the write, against the record as it actually is:
    // reading first and writing after would let a change of author or of
    // visibility land in between and be overtaken by the write it should have
    // refused. Same shape as the sheets. No createIfMissing - a PUT to a
    // deleted note is a 404, not a resurrection.
    let seen = null;
    let wasPublic = false;
    const record = await store.mutate(notesOf(req), req.params.id, (current) => {
      seen = current;
      if (!canEditNote(req, current)) return null; // write nothing
      wasPublic = visibilityOf(current) === 'public';
      // The old boolean is dropped rather than merged past: visibilityOf has
      // already read whatever it said, and a note that keeps both fields is a
      // note where somebody later has to work out which one wins. Saving one is
      // what finishes its migration, and nothing has to sweep the collection.
      const { shared, ...rest } = current;
      // The author never moves. It is the one field on a note that is a fact
      // about the past rather than a decision, and letting a body carry it
      // would make "only the author may edit" a sentence anybody could opt into.
      return { ...rest, ...sanitize(req.body), createdBy: current.createdBy || null };
    });

    if (!record) {
      if (!seen || !canReadNote(req, seen)) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.status(403).json({ error: 'Only the person who wrote this note can change it.' });
    }

    announce(req, 'update', record.id);
    // The edge, not the state: re-saving a note that was already public should
    // not nag the table every time its author fixes a typo.
    if (visibilityOf(record) === 'public' && !wasPublic) await announcePublic(req, record);
    res.json(present(record));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const record = await store.get(notesOf(req), req.params.id);
    if (!record || !canReadNote(req, record)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Destroying somebody else's note is a heavier act than editing it, so it
    // takes the same permission and no other.
    if (!canEditNote(req, record)) {
      return res.status(403).json({ error: 'Only the person who wrote this note can delete it.' });
    }
    const ok = await store.remove(notesOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
