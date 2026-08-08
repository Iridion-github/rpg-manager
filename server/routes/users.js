'use strict';

/**
 * The people this server knows about — global, not per campaign.
 *
 * Creating a user mints a credential, and that is the one act reserved to the
 * admin. Everything else about what a person can do is decided by campaign
 * membership, where the admin has no standing at all.
 *
 * Users still never self-register. An open registration endpoint on a
 * tunnel-exposed machine would let anyone who found the URL mint an identity —
 * the reason hasn't changed, only the name of the person who does the minting.
 *
 * The roster *without* keys is readable by any signed-in user, because a DM
 * needs to pick from a list of people to add to their campaign. Keys are
 * admin-only and are stripped from every other response.
 */

const express = require('express');
const store = require('../store');
const { notifyUser } = require('../realtime');
const {
  USERS,
  requireUser,
  requireAdmin,
  newUserKey,
  publicUser,
  colorFor,
  destroySessionsFor,
} = require('../auth');

const router = express.Router();

function sanitize(body = {}, existingCount = 0) {
  const { name = 'Player', color } = body;
  return {
    name: String(name).trim().slice(0, 60) || 'Player',
    color: /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color) : colorFor(existingCount),
  };
}

// Who am I? The client calls this on boot to learn its global identity.
router.get('/me', (req, res) => {
  res.json(req.actor);
});

// Names and colours, for member pickers and token labels. Never keys.
router.get('/', requireUser, async (req, res, next) => {
  try {
    const users = await store.list(USERS);
    res.json(users.map(publicUser));
  } catch (err) {
    next(err);
  }
});

// Admin-only: the roster including invite keys, for building share links.
router.get('/keys', requireAdmin, async (req, res, next) => {
  try {
    res.json(await store.list(USERS));
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const existing = await store.list(USERS);
    const record = await store.create(USERS, {
      ...sanitize(req.body, existing.length),
      key: newUserKey(),
      globalRole: 'user', // admin is seeded at boot, never minted here
    });
    res.status(201).json(record); // includes the key — the admin needs it once
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await store.list(USERS);
    const record = await store.update(USERS, req.params.id, sanitize(req.body, existing.length));
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(publicUser(record));
  } catch (err) {
    next(err);
  }
});

// Rotate a leaked key without losing anything the user owns (the id is stable,
// and tokens and sheet access both point at the id).
router.post('/:id/rotate-key', requireAdmin, async (req, res, next) => {
  try {
    const record = await store.update(USERS, req.params.id, { key: newUserKey() });
    if (!record) return res.status(404).json({ error: 'Not found' });
    // Their old key stops working the moment this lands; tell them so their
    // browser can stop pretending it's still signed in.
    notifyUser(req, req.params.id, 'identity:changed', {});
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.globalRole === 'admin') {
      // Deleting the admin would leave a server whose password authenticates as
      // nobody, and no way to mint the user who could fix it.
      return res.status(400).json({ error: 'The admin account cannot be deleted.' });
    }
    await store.remove(USERS, req.params.id);
    // A live session outlives its account otherwise — the token would still
    // resolve until it expired on its own.
    await destroySessionsFor(req.params.id);
    notifyUser(req, req.params.id, 'identity:changed', {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
