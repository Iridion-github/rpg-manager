'use strict';

/**
 * The people this server knows about - global, not per campaign.
 *
 * A list, not a place accounts are made. People arrive by registering
 * (routes/auth.js), and SIGNUP_CODE is what decides who may: an open
 * registration endpoint on a tunnel-exposed machine would let anyone who found
 * the URL mint an identity, and the code is the answer to that rather than
 * routing every arrival through the admin.
 *
 * What the admin still holds here is what isn't a person's own to decide:
 * renaming them, and removing them from the server. What each person can *do*
 * is decided by campaign membership, where the admin has no standing at all,
 * and how they get *in* is their own password.
 *
 * The roster is readable by any signed-in user, because a DM needs to pick from
 * a list of people to add to their campaign. It carries names and colours and
 * nothing else - publicUser decides that, and it is the only shape a user ever
 * leaves this file in.
 */

const express = require('express');
const store = require('../store');
const { notifyUser, onlineUserIds } = require('../realtime');
const { resetLink } = require('../links');
const { holdChange, TTL_MS } = require('../accountChanges');
const {
  USERS,
  requireUser,
  requireAdmin,
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

/**
 * Names and colours, for member pickers and token labels - plus who is here.
 *
 * `online` is read from the live sockets on every request rather than stored:
 * it is a fact about connections that exist right now, and the roster listens
 * for `presence:changed` to ask again. `lastSeenAt` is the stored half of the
 * same question, and the only one that can answer it about somebody who isn't
 * connected to hear it asked.
 */
router.get('/', requireUser, async (req, res, next) => {
  try {
    const users = await store.list(USERS);
    const online = onlineUserIds(req.app.get('io'));
    res.json(users.map((user) => ({ ...publicUser(user), online: online.has(user.id) })));
  } catch (err) {
    next(err);
  }
});

// No POST here on purpose. People arrive by registering - see routes/auth.js,
// and SIGNUP_CODE for who may. An account minted from the admin list was a name
// and an invite key with no username or password behind it, which made it a
// second kind of person: one who could be handed a link but could never sign
// in, change their own password, or hold an address. One way in is enough.

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

/**
 * A reset link for somebody the server cannot write to.
 *
 * The gap this fills: an account registered under a signup code was never made
 * to give an address, and /auth/forgot can only post a letter. Without this the
 * only remedy for a forgotten password is deleting the account, which takes
 * every campaign membership with it - a person losing their seat at four tables
 * because they mistyped something eight characters long.
 *
 * The link is handed back to the *admin* rather than sent anywhere, because
 * there is by definition nowhere to send it. They pass it on however they
 * already talk to that person, which is the same channel the signup code
 * travelled down.
 *
 * Worth being plain about what this is: for as long as it lasts, whoever holds
 * this link can set that account's password and sign in as them. That is not a
 * power the admin didn't already have - this database is a directory of JSON
 * files on a machine they own, and there is no arrangement of routes that
 * changes it - but a button is not the same as a text editor, so the screen
 * offering it says so out loud, and the link expires in an hour like every
 * other one.
 *
 * Deliberately not restricted to accounts with no address. A player whose
 * mailbox is the thing they've lost is exactly as stuck, and telling the admin
 * "delete them and start again" because the system disapproves of the reason
 * would be a rule serving itself.
 */
router.post('/:id/reset', requireAdmin, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.globalRole === 'admin') {
      return res.status(400).json({
        error: 'The admin password is server configuration - change ADMIN_PASSWORD instead.',
      });
    }
    const token = await holdChange(user.id, 'reset', {});
    res.json({ link: resetLink(req, token), minutes: Math.round(TTL_MS / 60000) });
  } catch (err) {
    next(err);
  }
});

// Nothing to rotate any more: an account is reached by signing in, and a
// password is the owner's to change (routes/auth.js). The admin's lever for a
// compromised account is to delete it, which takes its sessions with it - or,
// where the account is worth keeping, the reset link above.

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
    // A live session outlives its account otherwise - the token would still
    // resolve until it expired on its own.
    await destroySessionsFor(req.params.id);
    notifyUser(req, req.params.id, 'identity:changed', {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
