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

function sanitizeToken(body = {}, existing = {}) {
  const {
    label = existing.label ?? 'Token',
    color = existing.color ?? '#58a6ff',
    x = existing.x ?? 0,
    y = existing.y ?? 0,
    size = existing.size ?? 1,
    ownerId = existing.ownerId ?? null,
    sheetId = existing.sheetId ?? null,
  } = body;
  return {
    label: String(label).slice(0, 60),
    color: /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color) : '#58a6ff',
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
      // token to the first free one instead, so "+ Alice, + Bob, + Goblin"
      // doesn't stack three tokens on 0,0.
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
