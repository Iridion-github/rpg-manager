'use strict';

/**
 * The campaign's own tokens — its cast, rather than what is on a map right now.
 *
 * A token in this campaign is in one of two places: standing on a scene, or
 * waiting on the bench. This router is the view that spans both, because the
 * question it answers — "what tokens exist here, and whose are they?" — is not
 * a question about any one scene.
 *
 * What it deliberately does not touch is hit points and initiative. Those are
 * decided in the moment, on the tabletop, by whoever is looking at the fight;
 * they ride along on the token untouched by anything here. A wounded character
 * taken off the table comes back wounded.
 *
 * Who sees what: the DM sees the whole cast, everyone else sees the tokens that
 * belong to them. Who may *make* one: the DM as many as they like, a player
 * one — their own character — which is why a token remembers the hand that
 * created it as well as the one it belongs to.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast } = require('../realtime');
const { requireUser } = require('../auth');
const { scoped, canMoveToken, isDm } = require('../campaigns');

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
 * progress. No owner — that is handled apart, below, since only the DM may
 * change it and it is the one field that hands something over.
 */
function sanitizeLook(body = {}, existing = {}) {
  return {
    label: String(body.label ?? existing.label ?? 'Token').slice(0, 60),
    color: hexOr(body.color ?? existing.color, '#58a6ff'),
    borderColor:
      (body.borderColor ?? existing.borderColor) === null
        ? null
        : hexOr(body.borderColor ?? existing.borderColor, null),
    imageUrl: String(body.imageUrl ?? existing.imageUrl ?? '').slice(0, 500),
    size: clamp(num(body.size ?? existing.size, 1), 0.5, 10),
  };
}

/** Every token in the campaign, with the scene it stands on if it stands on one. */
async function everyToken(req) {
  const scenes = await store.list(scenesOf(req));
  const placed = [];
  for (const scene of scenes) {
    for (const token of scene.tokens || []) {
      placed.push({ ...token, sceneId: scene.id, sceneName: scene.name || 'Untitled scene' });
    }
  }
  const benched = (await store.list(benchOf(req))).map((t) => ({
    ...t,
    sceneId: null,
    sceneName: null,
  }));
  return [...placed, ...benched];
}

/** Find one, wherever it happens to be. */
async function locate(req, tokenId) {
  const benched = await store.get(benchOf(req), tokenId);
  if (benched) return { where: 'bench', token: benched };
  const scenes = await store.list(scenesOf(req));
  for (const scene of scenes) {
    const token = (scene.tokens || []).find((t) => t.id === tokenId);
    if (token) return { where: 'scene', token, sceneId: scene.id };
  }
  return null;
}

router.get('/', requireUser, async (req, res, next) => {
  try {
    const all = await everyToken(req);
    const mine = all.filter((token) => canMoveToken(req.actor, req.campaignRole, token));
    // Unplaced first — those are the ones you can do something with from here —
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
 * A player gets one, and only one, and it is theirs from the moment it exists.
 * The limit is counted on who *created* a token rather than who owns one: a DM
 * handing somebody a second character shouldn't cost that person the right to
 * have made their own, and being given three tokens shouldn't mean you were
 * never allowed one.
 */
router.post('/', requireUser, async (req, res, next) => {
  try {
    const dm = isDm(req.campaign, req.actor);
    if (!dm) {
      const all = await everyToken(req);
      if (all.some((t) => t.createdBy === req.actor.userId)) {
        throw new HttpError(409, 'You have already made your token. Edit that one instead.');
      }
    }
    const token = {
      id: crypto.randomUUID(),
      ...sanitizeLook(req.body),
      // Read off the session, never the request. Who made a token decides
      // whether they may make another; who owns it decides who may move it.
      createdBy: req.actor.userId,
      // A player's own token is theirs. The DM says who anybody else's belongs
      // to, and may say nobody — the monsters and the scenery.
      ownerId: dm ? (req.body?.ownerId ? String(req.body.ownerId) : null) : req.actor.userId,
      initiative: null,
      initiativeDie: null,
      initiativeMod: null,
      hp: null,
      maxHp: null,
      sheetId: null,
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
 * is the same edit either way — which is the point of this view existing. Only
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
    // Handing a token to somebody is the DM's alone, so a player's edit cannot
    // carry an owner even if the request does.
    const owner = dm
      ? { ownerId: req.body?.ownerId ? String(req.body.ownerId) : null }
      : {};
    const patch = { ...sanitizeLook(req.body, found.token), ...owner };

    if (found.where === 'bench') {
      const updated = { ...found.token, ...patch };
      await store.put(benchOf(req), updated);
      broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: updated.id } });
      return res.json({ ...updated, sceneId: null, sceneName: null });
    }

    const scene = await store.mutate(scenesOf(req), found.sceneId, (current) => ({
      ...current,
      tokens: current.tokens.map((t) => (t.id === req.params.tokenId ? { ...t, ...patch } : t)),
    }));
    broadcast(req, 'scenes:changed', { action: 'token:update', record: scene });
    const updated = scene.tokens.find((t) => t.id === req.params.tokenId);
    res.json({ ...updated, sceneId: scene.id, sceneName: scene.name });
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

    if (found.where === 'bench') {
      await store.remove(benchOf(req), req.params.tokenId);
      broadcast(req, 'scenes:changed', { action: 'token:roster', record: { id: req.params.tokenId } });
      return res.status(204).end();
    }

    const scene = await store.mutate(scenesOf(req), found.sceneId, (current) => ({
      ...current,
      tokens: current.tokens.filter((t) => t.id !== req.params.tokenId),
      turnTokenId: current.turnTokenId === req.params.tokenId ? null : current.turnTokenId,
    }));
    broadcast(req, 'scenes:changed', { action: 'token:delete', record: scene });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
