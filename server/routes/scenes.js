'use strict';

/**
 * Scenes — a map image plus the tokens standing on it.
 *
 * Token coordinates are stored in *grid cells*, not pixels, so the same scene
 * renders correctly at any zoom or canvas size. Snapping is the client's job.
 *
 * Permissions: the GM owns the scene (image, grid, which tokens exist and who
 * they belong to). A player may only move a token whose ownerId is theirs.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast } = require('../realtime');
const { requireGm, canMoveToken } = require('../auth');

const COLLECTION = 'scenes';
const router = express.Router();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sanitizeScene(body = {}) {
  const { name = 'New Scene', imageUrl = '', gridSize = 70, cols = 20, rows = 14 } = body;
  return {
    name: String(name).slice(0, 120),
    imageUrl: String(imageUrl).slice(0, 500),
    gridSize: clamp(num(gridSize, 70), 10, 400), // px per cell at 100% zoom
    cols: clamp(Math.round(num(cols, 20)), 1, 200),
    rows: clamp(Math.round(num(rows, 14)), 1, 200),
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

// Find a token or fail with the right status.
function tokenIn(scene, tokenId) {
  const token = (scene.tokens || []).find((t) => t.id === tokenId);
  if (!token) throw new HttpError(404, 'Token not found');
  return token;
}

// ---- Scenes ----

router.get('/', async (req, res, next) => {
  try {
    res.json(await store.list(COLLECTION));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const scene = await store.get(COLLECTION, req.params.id);
    if (!scene) return res.status(404).json({ error: 'Not found' });
    res.json(scene);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireGm, async (req, res, next) => {
  try {
    const record = await store.create(COLLECTION, { ...sanitizeScene(req.body), tokens: [] });
    announce(req, 'create', record);
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireGm, async (req, res, next) => {
  try {
    // Merge scene fields only — tokens have their own endpoints, so a stale
    // client PUT can't wipe the board.
    const record = await store.update(COLLECTION, req.params.id, sanitizeScene(req.body));
    if (!record) return res.status(404).json({ error: 'Not found' });
    announce(req, 'update', record);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireGm, async (req, res, next) => {
  try {
    const ok = await store.remove(COLLECTION, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    announce(req, 'delete', { id: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Tokens ----

router.post('/:id/tokens', requireGm, async (req, res, next) => {
  try {
    const token = { id: crypto.randomUUID(), ...sanitizeToken(req.body) };
    const scene = await store.mutate(COLLECTION, req.params.id, (current) => ({
      ...current,
      tokens: [...(current.tokens || []), token],
    }));
    if (!scene) return res.status(404).json({ error: 'Not found' });
    announce(req, 'token:add', scene, { token });
    res.status(201).json(token);
  } catch (err) {
    next(err);
  }
});

// Full token edit (label, colour, owner, size) — GM only.
router.put('/:id/tokens/:tokenId', requireGm, async (req, res, next) => {
  try {
    const scene = await store.mutate(COLLECTION, req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      const updated = { ...existing, ...sanitizeToken(req.body, existing) };
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
    const scene = await store.mutate(COLLECTION, req.params.id, (current) => {
      const existing = tokenIn(current, req.params.tokenId);
      if (!canMoveToken(req.actor, existing)) {
        throw new HttpError(403, 'You can only move your own token.');
      }
      const moved = { ...existing, x: num(req.body?.x, existing.x), y: num(req.body?.y, existing.y) };
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

router.delete('/:id/tokens/:tokenId', requireGm, async (req, res, next) => {
  try {
    const scene = await store.mutate(COLLECTION, req.params.id, (current) => {
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
