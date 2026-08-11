'use strict';

/**
 * Scenes — a map image plus the tokens standing on it.
 *
 * Token coordinates are stored in *grid cells*, not pixels, so the same scene
 * renders correctly at any zoom or canvas size. Snapping is the client's job.
 *
 * Permissions: this campaign's DM owns the scene (image, grid, which tokens
 * exist and who they belong to). A player may only move a token whose ownerId
 * is theirs. Both are decided by role *in this campaign* — the same person may
 * be the DM here and a player at the next table.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast } = require('../realtime');
const { scoped, requireDm, canMoveToken } = require('../campaigns');

const COLLECTION = 'scenes';
const router = express.Router({ mergeParams: true });

const scenesOf = (req) => scoped(req.campaignId, COLLECTION);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A scene is a map of a fixed pixel size with a grid laid over it.
 *
 * `width`/`height` are the map's own dimensions and `gridSize` is how many of
 * those pixels one cell spans — so the GM can retune the grid to match the art
 * without the map changing size. Column and row counts are *derived* from that
 * ratio rather than stored, which is what keeps the two from contradicting
 * each other.
 */
function sanitizeScene(body = {}) {
  const { name = 'New Scene', imageUrl = '', gridSize = 70 } = body;
  // Older scenes described their size as cols/rows instead of pixels.
  const fallbackW = num(body.cols, 0) * num(gridSize, 70) || 1200;
  const fallbackH = num(body.rows, 0) * num(gridSize, 70) || 840;
  return {
    name: String(name).slice(0, 120),
    imageUrl: String(imageUrl).slice(0, 500),
    gridSize: clamp(num(gridSize, 70), 8, 500), // map px per cell
    // Absent means on: every scene that existed before this flag did had a
    // grid, and they should keep it.
    gridOn: body.gridOn !== false,
    width: clamp(Math.round(num(body.width, 0) || fallbackW), 32, 12000),
    height: clamp(Math.round(num(body.height, 0) || fallbackH), 32, 12000),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (value, fallback) => (HEX.test(String(value)) ? String(value) : fallback);

/**
 * A whole-number stat the DM may simply not have filled in.
 *
 * Null rather than 0, because on a token those say different things: 0 hit
 * points is a creature that has just dropped, null is one nobody is counting.
 * An empty string arrives from a cleared form field and means the same as null.
 */
function statOrNull(value, lo, hi) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : null;
}

/**
 * Initiative, and the roll behind it.
 *
 * The total is what the order is read from, so it stays the authoritative
 * field — but when both halves are known the total is *derived* from them
 * rather than trusted alongside them. Two numbers that are supposed to add up
 * to a third will eventually disagree if all three are stored independently,
 * and the one that would be wrong is the one everything else reads.
 *
 * Half a breakdown is no breakdown: a die with no modifier tells a tie nothing,
 * so both or neither are kept and a lone half is dropped back to a bare total.
 */
function rolledInitiative(total, die, mod) {
  const d = statOrNull(die, -99, 999);
  const m = statOrNull(mod, -99, 999);
  if (d !== null && m !== null) {
    return { initiative: clamp(d + m, -99, 999), initiativeDie: d, initiativeMod: m };
  }
  return { initiative: statOrNull(total, -99, 999), initiativeDie: null, initiativeMod: null };
}

/**
 * Current and total hit points, decided together.
 *
 * Current only means something measured against a total — it's what draws the
 * bar — so a token without a total has no hit points at all rather than a
 * number floating free. Given a total but no current, it starts at full: that's
 * the state a creature is in when it walks onto the map.
 */
function hitPoints(maxHp, hp) {
  const max = statOrNull(maxHp, 0, 9999);
  if (max === null) return { maxHp: null, hp: null };
  const current = statOrNull(hp, 0, max);
  return { maxHp: max, hp: current === null ? max : current };
}

function sanitizeToken(body = {}, existing = {}) {
  const {
    label = existing.label ?? 'Token',
    color = existing.color ?? '#58a6ff',
    // Null means "whatever the stylesheet draws" — the dark ring every token
    // had before this was a choice. Kept nullable so old tokens don't have to
    // be migrated into an explicit colour they never picked.
    borderColor = existing.borderColor ?? null,
    // A token's face. Empty means it shows its name instead.
    imageUrl = existing.imageUrl ?? '',
    // What the tooltip reads out. Everyone sees initiative; the hit points are
    // the DM's business, and the client only shows them to them.
    initiative = existing.initiative ?? null,
    // The two halves of that total, kept because the total alone can't settle a
    // tie: two creatures on 25 are separated by who had the bigger modifier,
    // which is a fact about the creature rather than about the roll. Optional —
    // a token whose initiative was typed in as a bare number has neither.
    initiativeDie = existing.initiativeDie ?? null,
    initiativeMod = existing.initiativeMod ?? null,
    maxHp = existing.maxHp ?? null,
    hp = existing.hp ?? null,
    x = existing.x ?? 0,
    y = existing.y ?? 0,
    size = existing.size ?? 1,
    ownerId = existing.ownerId ?? null,
    sheetId = existing.sheetId ?? null,
  } = body;
  return {
    label: String(label).slice(0, 60),
    color: hexOr(color, '#58a6ff'),
    borderColor: borderColor === null ? null : hexOr(borderColor, null),
    imageUrl: String(imageUrl).slice(0, 500),
    // Wide enough for a d20 plus any modifier a table can produce, and for the
    // dexterity contest that follows a tie.
    ...rolledInitiative(initiative, initiativeDie, initiativeMod),
    ...hitPoints(maxHp, hp),
    x: num(x, 0),
    y: num(y, 0),
    size: clamp(num(size, 1), 0.5, 10),
    ownerId: ownerId ? String(ownerId) : null,
    sheetId: sheetId ? String(sheetId) : null,
  };
}

function announce(req, action, record, extra = {}) {
  broadcast(req, 'scenes:changed', { action, record, ...extra });
}

/**
 * One token per cell.
 *
 * Tokens can be bigger than one cell (a size-2 ogre covers 2×2), so this is a
 * rectangle-intersection test rather than a comparison of coordinates. Every
 * check runs inside store.mutate — that is, while holding the write queue — so
 * two players cannot both be told an empty cell is theirs.
 */
function overlaps(a, b) {
  const aSize = a.size || 1;
  const bSize = b.size || 1;
  return (
    a.x < b.x + bSize && b.x < a.x + aSize && a.y < b.y + bSize && b.y < a.y + aSize
  );
}

/**
 * How close counts as "the same place" on a gridless scene.
 *
 * A fraction of a cell, and it exists because positions are floats: two tokens
 * dropped on the same spot are almost never bit-identical, so a literal `===`
 * would forbid nothing. It is a tolerance for arithmetic, not for stacking —
 * anywhere a human could see daylight between two tokens is allowed.
 */
const SAME_SPOT = 0.02;

/**
 * Is this position already taken?
 *
 * With a grid, footprints may not overlap at all — a table with squares has one
 * token per square. Without one, a token goes where you put it and the only
 * refusal left is dropping it exactly where another already stands, which would
 * hide one behind the other with no way to tell they're both there.
 */
function conflicts(scene, a, b) {
  if (scene.gridOn === false) {
    return Math.abs(a.x - b.x) < SAME_SPOT && Math.abs(a.y - b.y) < SAME_SPOT;
  }
  return overlaps(a, b);
}

// The token standing where `candidate` wants to be, if any.
function blockerFor(scene, candidate, ignoreId) {
  return (
    (scene.tokens || []).find((t) => t.id !== ignoreId && conflicts(scene, t, candidate)) || null
  );
}

// Cell counts are derived from the map size, exactly as the client derives them.
function gridOf(scene) {
  const g = scene.gridSize || 70;
  return {
    cols: Math.max(1, Math.floor((scene.width || 1200) / g)),
    rows: Math.max(1, Math.floor((scene.height || 840) / g)),
  };
}

// First cell a token of this size fits in, scanning row by row. Lets the GM add
// several tokens in a row without each one landing on the last.
function firstFreeCell(scene, size, ignoreId) {
  const { cols, rows } = gridOf(scene);
  const span = Math.max(1, Math.ceil(size || 1));
  // A gridless scene has no cells to step through, and needs none: the only
  // thing in the way is an exact overlap, which any nudge clears.
  const step = scene.gridOn === false ? 0.5 : 1;
  for (let y = 0; y + span <= Math.max(rows, span); y += step) {
    for (let x = 0; x + span <= Math.max(cols, span); x += step) {
      if (!blockerFor(scene, { x, y, size }, ignoreId)) return { x, y };
    }
  }
  return null;
}

function refuseOverlap(scene, candidate, ignoreId) {
  const blocker = blockerFor(scene, candidate, ignoreId);
  if (blocker) {
    throw new HttpError(409, `${blocker.label || 'Another token'} is already there.`);
  }
}

// Find a token or fail with the right status.
function tokenIn(scene, tokenId) {
  const token = (scene.tokens || []).find((t) => t.id === tokenId);
  if (!token) throw new HttpError(404, 'Token not found');
  return token;
}

// ---- Scenes ----

router.get('/', async (req, res, next) => {
  try {
    res.json(await store.list(scenesOf(req)));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const scene = await store.get(scenesOf(req), req.params.id);
    if (!scene) return res.status(404).json({ error: 'Not found' });
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireDm, async (req, res, next) => {
  try {
    const record = await store.create(scenesOf(req), { ...sanitizeScene(req.body), tokens: [] });
    announce(req, 'create', record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireDm, async (req, res, next) => {
  try {
    // Merge scene fields only — tokens have their own endpoints, so a stale
    // client PUT can't wipe the board.
    const record = await store.update(scenesOf(req), req.params.id, sanitizeScene(req.body));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    const ok = await store.remove(scenesOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Tokens ----

router.post('/:id/tokens', requireDm, async (req, res, next) => {
  try {
    const wanted = { id: crypto.randomUUID(), ...sanitizeToken(req.body) };
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      let token = wanted;
      // Asking for an occupied cell isn't an error when adding — slide the new
      // token to the first free one instead. Tokens are created where the DM
      // right-clicked, and "on top of that one" is a near miss rather than a
      // mistake worth refusing.
      if (blockerFor(current, token, null)) {
        const free = firstFreeCell(current, token.size, null);
        if (!free) throw new HttpError(409, 'No free cell left on this scene.');
        token = { ...token, ...free };
      }
      return { ...current, tokens: [...(current.tokens || []), token] };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    const placed = scene.tokens.find((t) => t.id === wanted.id);
    announce(req, 'token:add', scene, { token: placed });
    res.status(201).json(placed);
  } catch (err) {
    next(err);
  }
});

// Full token edit (label, colour, owner, size) — DM only.
router.put('/:id/tokens/:tokenId', requireDm, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      const updated = { ...existing, ...sanitizeToken(req.body, existing) };
      // Growing a token can push it into a neighbour just as moving it can.
      refuseOverlap(current, updated, updated.id);
      return {
        ...current,
        tokens: current.tokens.map((t) => (t.id === updated.id ? updated : t)),
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:update', scene);
    res.json(scene.tokens.find((t) => t.id === req.params.tokenId));
  } catch (err) {
    next(err);
  }
});

// Move — the one write a player is allowed to make. Position only: a player
// can't repaint or rename a token by POSTing extra fields here.
router.put('/:id/tokens/:tokenId/position', async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      if (!canMoveToken(req.actor, req.campaignRole, existing)) {
        throw new HttpError(403, 'You can only move your own token.');
      }
      const moved = { ...existing, x: num(req.body?.x, existing.x), y: num(req.body?.y, existing.y) };
      refuseOverlap(current, moved, moved.id);
      return {
        ...current,
        tokens: current.tokens.map((t) => (t.id === moved.id ? moved : t)),
      };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:move', scene);
    res.json(scene.tokens.find((t) => t.id === req.params.tokenId));
  } catch (err) {
    next(err);
  }
});

// ---- Turn mode ----

/**
 * The tokens that take a turn, in the order they take them.
 *
 * Highest initiative first, and *only* tokens that have one — a door or a pile
 * of crates stands on the board without being in the fight. Ties keep the order
 * they already stand in, which is the order they were added and therefore the
 * same list for everyone looking at it.
 *
 * The client sorts its own copy by this exact rule to draw the list. If one of
 * the two ever changes, the other has to change with it, or the DM's Next would
 * step somewhere other than where the highlight is.
 */
function turnOrder(scene) {
  return (scene.tokens || [])
    .filter((t) => t.initiative !== null && t.initiative !== undefined)
    .sort((a, b) => b.initiative - a.initiative || byModifier(a, b));
}

/**
 * The tie-break: level totals are settled by the bigger modifier.
 *
 * A token whose initiative was typed in as a bare total has no modifier to
 * compare, and sorts below any token that does — it can't win a contest it
 * brought no evidence to. Compared rather than subtracted so that two unknowns
 * are equal instead of NaN, which is what `-Infinity - -Infinity` would give
 * and what a subtracting comparator would quietly scramble the order with.
 */
function byModifier(a, b) {
  const of = (t) =>
    t.initiativeMod === null || t.initiativeMod === undefined ? -Infinity : t.initiativeMod;
  const ma = of(a);
  const mb = of(b);
  if (ma === mb) return 0;
  return mb > ma ? 1 : -1;
}

/**
 * Whose turn it is after this one. Wrapping past the end is the next round.
 *
 * A token that has since been deleted — or had its initiative cleared, which
 * takes it out of the fight just as surely — is no longer in the order, so
 * there is no "next" from it. Starting again from the top beats refusing.
 */
function nextInOrder(scene) {
  const order = turnOrder(scene);
  if (!order.length) return null;
  const i = order.findIndex((t) => t.id === scene.turnTokenId);
  return order[i < 0 ? 0 : (i + 1) % order.length].id;
}

/**
 * Turn mode belongs to the scene, so it is one shared fact rather than
 * something each client decides for itself: the tracker everyone sees is the
 * same tracker, and a player who reloads mid-fight rejoins it where it stands.
 *
 * Deliberately not part of sanitizeScene — an ordinary scene edit (a rename, a
 * new map) has no business ending combat, and a stale client PUT can't.
 */
router.put('/:id/turn', requireDm, async (req, res, next) => {
  try {
    const on = req.body?.on !== false;
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => ({
      ...current,
      turnMode: on,
      // Starting puts the highest initiative up first. Stopping forgets whose
      // turn it was, so the next fight doesn't open in the middle of the last.
      turnTokenId: on ? (turnOrder(current)[0]?.id ?? null) : null,
    }));
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

/**
 * Hand the turn to a particular token, rather than to whoever is next.
 *
 * The order is what a fight *usually* follows, not a rule it can't depart from:
 * someone readies an action, a creature is surprised, initiative gets rerolled
 * mid-round. This is the DM saying "it's yours now" and skipping the argument.
 *
 * Only a token already in the order may take it. One without an initiative
 * isn't in the fight, and giving it the turn would highlight a row that isn't
 * in the list and leave Next with nowhere to step from.
 */
router.put('/:id/turn/current', requireDm, async (req, res, next) => {
  try {
    const wanted = String(req.body?.tokenId || '');
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      if (!current.turnMode) throw new HttpError(409, 'Turn mode is not on.');
      const token = turnOrder(current).find((t) => t.id === wanted);
      if (!token) throw new HttpError(409, 'That token is not in the turn order.');
      return { ...current, turnTokenId: token.id };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/turn/next', requireDm, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      if (!current.turnMode) throw new HttpError(409, 'Turn mode is not on.');
      return { ...current, turnTokenId: nextInOrder(current) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', scene);
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/tokens/:tokenId', requireDm, async (req, res, next) => {
  try {
    const scene = await store.mutate(scenesOf(req), req.params.id, (current) => {
      tokenIn(current, req.params.tokenId); // 404 if it isn't there
      return { ...current, tokens: current.tokens.filter((t) => t.id !== req.params.tokenId) };
    });
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:remove', scene, { tokenId: req.params.tokenId });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
