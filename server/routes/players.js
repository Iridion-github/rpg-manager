'use strict';

/**
 * The player roster.
 *
 * The GM adds a player, the server mints a secret key, and the GM shares it as
 * an invite link (?key=…). The key is the player's whole identity — it is
 * returned exactly once at creation and on an explicit re-read by the GM, and
 * is stripped from every public response.
 */

const express = require('express');
const store = require('../store');
const { broadcast } = require('../realtime');
const { PLAYERS, requireGm, newPlayerKey, publicPlayer } = require('../auth');

const router = express.Router();

// Distinct, readable-on-dark token colours.
const PALETTE = ['#e5534b', '#3fb950', '#58a6ff', '#d29922', '#bc8cff', '#39c5cf'];

function sanitize(body = {}, existingCount = 0) {
  const { name = 'Player', color } = body;
  return {
    name: String(name).trim().slice(0, 60) || 'Player',
    color: /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color) : PALETTE[existingCount % PALETTE.length],
  };
}

// Who am I? The client calls this on boot to learn its role.
router.get('/me', (req, res) => {
  res.json(req.actor);
});

// Public roster — needed to label tokens with their owner. Never includes keys.
router.get('/', async (req, res, next) => {
  try {
    const players = await store.list(PLAYERS);
    res.json(players.map(publicPlayer));
  } catch (err) {
    next(err);
  }
});

// GM-only: the roster including invite keys, for building share links.
router.get('/keys', requireGm, async (req, res, next) => {
  try {
    res.json(await store.list(PLAYERS));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireGm, async (req, res, next) => {
  try {
    const existing = await store.list(PLAYERS);
    const record = await store.create(PLAYERS, {
      ...sanitize(req.body, existing.length),
      key: newPlayerKey(),
    });
    broadcast(req, 'players:changed', { action: 'create', record: publicPlayer(record) });
    res.status(201).json(record); // includes the key — the GM needs it once
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireGm, async (req, res, next) => {
  try {
    const existing = await store.list(PLAYERS);
    const record = await store.update(PLAYERS, req.params.id, sanitize(req.body, existing.length));
    if (!record) return res.status(404).json({ error: 'Not found' });
    broadcast(req, 'players:changed', { action: 'update', record: publicPlayer(record) });
    res.json(publicPlayer(record));
  } catch (err) {
    next(err);
  }
});

// Rotate a leaked key without losing the player's tokens (id stays the same).
router.post('/:id/rotate-key', requireGm, async (req, res, next) => {
  try {
    const record = await store.update(PLAYERS, req.params.id, { key: newPlayerKey() });
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireGm, async (req, res, next) => {
  try {
    const ok = await store.remove(PLAYERS, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    broadcast(req, 'players:changed', { action: 'delete', record: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
