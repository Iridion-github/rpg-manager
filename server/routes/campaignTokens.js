'use strict';

/**
 * The campaign's own tokens - its cast, rather than what is on a map right now.
 *
 * A token in this campaign is in one of two places: standing on a scene, or
 * waiting on the bench. This router is the view that spans both, because the
 * question it answers - "what tokens exist here, and whose are they?" - is not
 * a question about any one scene.
 *
 * What it deliberately does not touch is hit points and initiative. Those are
 * decided in the moment, on the tabletop, by whoever is looking at the fight;
 * they ride along on the token untouched by anything here. A wounded character
 * taken off the table comes back wounded.
 *
 * Who sees what: the DM sees the whole cast, everyone else sees the tokens that
 * belong to them. Who may *make* one: anybody, as many as they like. A player's
 * are theirs from the moment they exist, and the DM says who everyone else's
 * belong to - as many as they like to whoever they like, though a token belongs
 * to one person at a time, because `ownerId` is a single field and "whose is
 * this?" is a question that wants one answer.
 *
 * A token still remembers the hand that created it as well as the one it
 * belongs to. Nothing is gated on it now, but they are different facts and the
 * one that is not ownership is the one you cannot reconstruct later.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast, broadcastPerActor } = require('../realtime');
const { requireUser } = require('../auth');
const {
  scoped,
  canMoveToken,
  canSeeToken,
  sceneAsSeenBy,
  canViewSheet,
  canEditSheet,
  isDm,
} = require('../campaigns');
const sheetLink = require('../sheetLink');
const { locateToken, patchEverywhere, removeEverywhere } = require('../tokenCopies');

const router = express.Router({ mergeParams: true });

const benchOf = (req) => scoped(req.campaignId, 'bench');
const scenesOf = (req) => scoped(req.campaignId, 'scenes');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (value, fallback) => (HEX.test(String(value)) ? String(value) : fallback);
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The fields this view is allowed to decide.
 *
 * A deliberately shorter list than the tabletop's: what a token is called, what
 * it looks like and how big it is. No position, because nothing here is on a
 * map. No hit points or initiative, because those belong to a fight in
 * progress. No owner - that is handled apart, below, since only the DM may
 * change it and it is the one field that hands something over.
 */
function sanitizeLook(body = {}, existing = {}) {
  /**
   * Did the caller mention this field at all?
   *
   * The distinction this exists to make: **saying null is not the same as
   * saying nothing**. For `borderColor`, null is a real answer - "no colour,
   * draw the default dark ring" - and it is exactly what the form sends when
   * the border checkbox is unticked.
   *
   * This used to be written with `??`, which cannot tell the two apart: it
   * falls through on null as readily as on undefined, so `body.borderColor ??
   * existing.borderColor` read an explicit "remove the border" as silence and
   * handed back the colour already on the token. Removing a border from the
   * Tokens tab was therefore impossible - the request was accepted, answered
   * 200, and changed nothing. `hasOwnProperty` asks the question actually being
   * asked, which is about the *key*, not about its value.
   *
   * The tabletop's own editor (routes/scenes.js) never had the bug: it uses
   * destructuring defaults, which fire only on undefined and so let a null
   * through intact.
   */
  const said = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = (key, fallback) => (said(key) ? body[key] : fallback);

  return {
    label: String(pick('label', existing.label) ?? 'Token').slice(0, 60),
    // Part of what a token *is* rather than what it is doing, so it belongs on
    // this shorter list too: a token prepared in the Tokens tab arrives on the
    // map already captioned, or already not.
    showNameplate: pick('showNameplate', existing.showNameplate) === true,
    // Kept here too, even though a condition is closer to what a token is doing
    // than to what it is: the form offers it in both places, and a token
    // prepared as already poisoned should arrive on the map that way rather
    // than have the answer quietly dropped between the two.
    status: String(pick('status', existing.status) ?? '').slice(0, 40),
    showStatus: pick('showStatus', existing.showStatus) === true,
    color: hexOr(pick('color', existing.color), '#58a6ff'),
    // No null branch needed: hexOr already answers null for anything that isn't
    // a colour, which includes the null meaning "no border".
    borderColor: hexOr(pick('borderColor', existing.borderColor), null),
    imageUrl: String(pick('imageUrl', existing.imageUrl) ?? '').slice(0, 500),
    // `?? 1` before num(), because Number(null) is 0 rather than NaN - so a null
    // size would slip past the finite check and be clamped to the minimum
    // instead of falling back to one cell.
    size: clamp(num(pick('size', existing.size) ?? 1, 1), 0.5, 10),
  };
}

/**
 * A changed scene, announced to each person as they may see it.
 *
 * The same rule the tabletop's own announcements follow (routes/scenes.js): a
 * scene record carries its tokens, and a token the DM has hidden must not
 * travel to anybody else. Editing a token from the Tokens tab or coupling it to
 * a character sends the whole board out, so it needs the same door.
 */
function announceScene(req, action, scene) {
  broadcastPerActor(req, 'scenes:changed', (actor, role) => ({
    action,
    record: sceneAsSeenBy(role, scene, actor, req.campaign),
  }));
}

/**
 * Write a patch onto every figure of one creature, and tell the tables looking
 * at them. The other half of patchEverywhere: the writing is arithmetic, the
 * announcing needs the request.
 */
async function announceEverywhere(req, tokenId, patch) {
  const touched = await patchEverywhere(req.campaignId, tokenId, patch);
  for (const sceneId of touched) {
    const scene = await store.get(scenesOf(req), sceneId);
    if (scene) announceScene(req, 'token:update', scene);
  }
  return touched;
}

/**
 * Every token in the campaign, once each, with everywhere it is standing.
 *
 * Once each because a token can stand on several maps at a time now, and this
 * is a cast list: the innkeeper is one entry that happens to be in two places,
 * not two innkeepers. `scenes` is that list; `sceneId` and `sceneName` are the
 * first of them, kept because "is it placed at all, and where do I look first"
 * is what most of the callers actually ask.
 */
async function everyToken(req) {
  const scenes = await store.list(scenesOf(req));
  const byId = new Map();
  for (const scene of scenes) {
    const where = { id: scene.id, name: scene.name || 'Untitled scene' };
    for (const token of scene.tokens || []) {
      const seen = byId.get(token.id);
      if (seen) seen.scenes.push(where);
      else byId.set(token.id, { ...token, scenes: [where] });
    }
  }
  for (const token of await store.list(benchOf(req))) {
    if (!byId.has(token.id)) byId.set(token.id, { ...token, scenes: [] });
  }
  return [...byId.values()].map((token) => ({
    ...token,
    sceneId: token.scenes[0]?.id || null,
    sceneName: token.scenes[0]?.name || null,
  }));
}

/**
 * Find one, wherever it happens to be.
 *
 * The search itself lives in tokenCopies.js, which needs the same answer when a
 * copy is pasted from a token that has since been benched. One walk of the
 * campaign rather than two: the second one would eventually forget about the
 * bench, or about a scene, and only one of the two would be wrong.
 */
const locate = (req, tokenId) => locateToken(req.campaignId, tokenId);

router.get('/', requireUser, async (req, res, next) => {
  try {
    const all = await everyToken(req);
    // Yours, and only the ones you can see. Both questions, because they are
    // different questions: the DM can hide a token that belongs to somebody
    // else, and handing that person its id here would be handing them the one
    // thing the map is careful not to send - see canSeeToken.
    const mine = all.filter(
      (token) =>
        canMoveToken(req.actor, req.campaignRole, token) &&
        canSeeToken(req.campaignRole, token)
    );
    // Unplaced first - those are the ones you can do something with from here -
    // and alphabetically within that, since this is a cast list rather than a
    // history.
    mine.sort(
      (a, b) =>
        Number(Boolean(a.sceneId)) - Number(Boolean(b.sceneId)) ||
        String(a.label || '').localeCompare(String(b.label || ''))
    );
    res.json(mine);
  } catch (err) {
    next(err);
  }
});

/**
 * Make one in advance. It arrives on the bench, because a token made before the
 * session hasn't been put anywhere yet.
 *
 * No limit on how many. A player with a familiar, a summoned swarm and a horse
 * has three things to move, and a table where the fourth one has to be asked
 * for is a table where somebody plays a spell wrong rather than interrupt.
 * Every one a player makes is theirs from the moment it exists.
 */
router.post('/', requireUser, async (req, res, next) => {
  try {
    const dm = isDm(req.campaign, req.actor);
    const token = {
      id: crypto.randomUUID(),
      ...sanitizeLook(req.body),
      // Read off the session, never the request. A different fact from
      // ownership: who owns a token decides who may move it, and who made it is
      // the part that cannot be worked out afterwards.
      createdBy: req.actor.userId,
      // A player's own token is theirs. The DM says who anybody else's belongs
      // to, and may say nobody - the monsters and the scenery.
      ownerId: dm ? (req.body?.ownerId ? String(req.body.ownerId) : null) : req.actor.userId,
      // Whether the table can see it, which only the DM may decide. A player's
      // own token is always visible: hiding one is a thing the person running
      // the game does to the rest of the table, not a thing anybody does to
      // themselves.
      visible: dm ? req.body?.visible !== false : true,
      initiative: null,
      initiativeDie: null,
      initiativeMod: null,
      hp: null,
      maxHp: null,
      sheetId: null,
      // Not a copy of anything: this one was made rather than pasted. Written
      // down as null rather than left absent so that every token has the same
      // shape, whichever of the two ways it came into existence.
      copyOf: null,
      copyIndex: null,
      benchedAt: new Date().toISOString(),
    };
    await store.put(benchOf(req), token);
    broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: token.id } });
    res.status(201).json(token);
  } catch (err) {
    next(err);
  }
});

/**
 * Edit one, wherever it is.
 *
 * The same token can be sitting on the bench or standing on a map, and the edit
 * is the same edit either way - which is the point of this view existing. Only
 * the look is touched; a placed token keeps its square, its wounds and its
 * place in the turn order.
 */
router.put('/:tokenId', requireUser, async (req, res, next) => {
  try {
    const found = await locate(req, req.params.tokenId);
    if (!found) return res.status(404).json({ error: 'Not found' });
    if (!canMoveToken(req.actor, req.campaignRole, found.token)) {
      throw new HttpError(403, 'You can only change your own token.');
    }
    const dm = isDm(req.campaign, req.actor);
    // The two fields that are the DM's alone: handing a token to somebody, and
    // deciding whether the table can see it. Absent from an owner's patch
    // entirely, so what is stored stays whatever it was however the request was
    // built. Same rule, same reason, as the tabletop's own editor.
    const dmOnly = dm
      ? {
        ownerId: req.body?.ownerId ? String(req.body.ownerId) : null,
        visible: req.body?.visible !== false,
      }
      : {};
    const patch = { ...sanitizeLook(req.body, found.token), ...dmOnly };

    // Everywhere it stands, and the bench if that is where it is waiting. One
    // creature has one name and one face however many maps it is on.
    const touched = await patchEverywhere(req.campaignId, req.params.tokenId, patch);

    if (!touched.length) {
      const updated = { ...found.token, ...patch };
      broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: updated.id } });
      return res.json({ ...updated, scenes: [], sceneId: null, sceneName: null });
    }

    let updated = null;
    for (const sceneId of touched) {
      const scene = await store.get(scenesOf(req), sceneId);
      if (!scene) continue;
      announceScene(req, 'token:update', scene);
      if (!updated) {
        updated = { ...scene.tokens.find((t) => t.id === req.params.tokenId) };
        updated.scenes = [{ id: scene.id, name: scene.name || 'Untitled scene' }];
        updated.sceneId = scene.id;
        updated.sceneName = scene.name;
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Couple this token to a character sheet, or set it loose.
 *
 * One route for both tabs. The Characters tab asks "which token is this
 * character?" and the Tokens tab asks "which character is this token?", but
 * they are the same fact written from two ends, and two endpoints would be two
 * chances for the ends to disagree about what it means.
 *
 * **Who may.** The DM may couple anything to anything at their own table. Anyone
 * else needs both halves to be theirs: a token they could move, and a sheet
 * they could edit. Requiring *edit* rather than mere sight is the point - a
 * character somebody has been allowed to read is not a character they may weld
 * their figure to, and the link writes hit points in both directions
 * afterwards.
 *
 * Both halves are checked even for a token the caller owns, because the two
 * permissions come from different places: owning the figure says nothing about
 * being trusted with the character.
 */
router.put('/:tokenId/sheet', requireUser, async (req, res, next) => {
  try {
    const found = await locate(req, req.params.tokenId);
    if (!found) return res.status(404).json({ error: 'Not found' });
    if (!canMoveToken(req.actor, req.campaignRole, found.token)) {
      throw new HttpError(403, 'You can only link your own token.');
    }

    const sheetId = req.body?.sheetId ? String(req.body.sheetId) : null;

    if (!sheetId) {
      const patch = await sheetLink.unlink(req.campaignId, found);
      // And on every other map this creature is standing on: one figure holding
      // a character and another that has let go would be two answers to whose
      // hit points these are.
      await announceEverywhere(req, found.token.id, patch);
      broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: found.token.id } });
      return res.json({ ...found.token, ...patch });
    }

    const sheet = await store.get(scoped(req.campaignId, 'sheets'), sheetId);
    // Invisible reads as absent here too: a player guessing at ids should not
    // be able to learn which of them are sheets.
    if (!sheet || !canViewSheet(req.actor, req.campaignRole, sheet)) {
      return res.status(404).json({ error: 'No such character sheet.' });
    }
    if (!canEditSheet(req.actor, req.campaignRole, sheet)) {
      throw new HttpError(403, 'You can only link a character you can edit.');
    }

    const { patch, scenes } = await sheetLink.link(req.campaignId, found, sheet);
    // The same coupling on every map it stands on. sheetLink writes the one
    // placement it was handed; the others are this creature too.
    await announceEverywhere(req, found.token.id, patch);
    // A roster nudge rather than a scene update: the token may be on the bench,
    // and the tab that cares is listening for this either way.
    broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: found.token.id } });
    // Taking a character off another figure changes that figure too, and it may
    // be standing on a map somebody is looking at. The whole scene goes, because
    // that is what the board redraws from.
    for (const sceneId of scenes) {
      const other = await store.get(scoped(req.campaignId, 'scenes'), sceneId);
      if (other) announceScene(req, 'token:update', other);
    }
    res.json({ ...found.token, ...patch });
  } catch (err) {
    next(err);
  }
});

/** Delete one for good, wherever it is. */
router.delete('/:tokenId', requireUser, async (req, res, next) => {
  try {
    const found = await locate(req, req.params.tokenId);
    if (!found) return res.status(404).json({ error: 'Not found' });
    if (!canMoveToken(req.actor, req.campaignRole, found.token)) {
      throw new HttpError(403, 'You can only delete your own token.');
    }

    // Off every map it stands on, and off the bench: a creature deleted from
    // the cast list has to be gone from the campaign, not from one of the three
    // places it happened to be.
    const touched = await removeEverywhere(req.campaignId, req.params.tokenId);
    if (!touched.length) {
      broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: req.params.tokenId } });
      return res.status(204).end();
    }
    for (const sceneId of touched) {
      const scene = await store.get(scenesOf(req), sceneId);
      if (scene) announceScene(req, 'token:delete', scene);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
