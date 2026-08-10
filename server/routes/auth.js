'use strict';

/**
 * Register, log in, log out.
 *
 * Sessions are bearer tokens rather than cookies: the app already sends its
 * credentials as headers and the socket sends them in its handshake, so a token
 * fits both without cookie plumbing or CSRF handling. The tradeoff is that a
 * token in localStorage is readable by any script that gets injected into the
 * page — worth knowing, and the reason a session expires rather than lasting
 * forever.
 *
 * Registration is open unless SIGNUP_CODE is set. On your own machine that's
 * the convenient default; on a hostname a stranger can find it is not, which is
 * why the startup banner nags about it.
 */

const express = require('express');
const store = require('../store');
const limits = require('../rateLimit');
const {
  USERS,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  gateEnabled,
  signupIsOpen,
  SIGNUP_CODE,
  hashPassword,
  verifyPassword,
  secretsMatch,
  validateCredentials,
  validateProfile,
  normalizeUsername,
  normalizeEmail,
  findUserByUsername,
  findUserByEmail,
  createSession,
  destroySession,
  destroySessionsFor,
  ensureAdminUser,
  credsFromRequest,
  publicUser,
  newUserKey,
  colorFor,
} = require('../auth');

const router = express.Router();

const cleanName = (v) => String(v || '').trim();

/**
 * When they last signed in, for the campaign's player list.
 *
 * Written on the way past a successful login rather than tracked per request:
 * this answers "when were you last here", which is a different question from
 * "are you here now" — presence answers that, and it comes from the live
 * sockets rather than from anything stored.
 */
const markLogin = (userId) =>
  store.update(USERS, userId, { lastLoginAt: new Date().toISOString() });

// What the client needs to know about itself after a successful sign-in.
const sessionPayload = (user, session) => ({
  token: session.token,
  expiresAt: session.expiresAt,
  actor: {
    globalRole: user.globalRole === 'admin' ? 'admin' : 'user',
    userId: user.id,
    name: user.name,
    username: user.username || '',
  },
});

// Lets the sign-in screen say whether registration is even available, rather
// than offering a form that will be refused.
router.get('/config', (req, res) => {
  res.json({ signupIsOpen, signupNeedsCode: !signupIsOpen, writeGate: gateEnabled });
});

router.post('/register', async (req, res, next) => {
  try {
    const from = limits.addressOf(req);
    const blocked = limits.signup.retryAfter(from);
    if (blocked) return limits.refuse(res, blocked);

    if (!signupIsOpen && !secretsMatch(String(req.body?.code || ''), SIGNUP_CODE)) {
      // Guessing the code is the only failure counted here. A password that's
      // too short is a typo, and holding that against someone would lock out
      // the one honest user fumbling the form.
      limits.signup.fail(from);
      return res.status(403).json({ error: 'That signup code is not right.' });
    }

    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? '');
    const name = cleanName(req.body?.name);
    const email = normalizeEmail(req.body?.email);

    const problem = validateCredentials(username, password) || validateProfile(name, email);
    if (problem) return res.status(400).json({ error: problem });

    if (username === ADMIN_USERNAME || (await findUserByUsername(username))) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    // Both are unique, and both say so plainly. This is an account-enumeration
    // leak by construction — a signup form that accepts duplicates isn't a
    // signup form, and a vaguer message would only make it harder to use
    // without making it harder to probe.
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const users = await store.list(USERS);
    const record = await store.create(USERS, {
      username,
      name,
      email,
      passwordHash: await hashPassword(password),
      color: colorFor(users.length),
      // Still gets an invite key, so the admin can hand out a link to this
      // account the same way as any other.
      key: newUserKey(),
      globalRole: 'user',
    });

    // Registering signs you in — an account you then have to log into
    // separately is a form for its own sake.
    const session = await createSession(record.id);
    limits.signup.clear(from);
    res.status(201).json(sessionPayload(record, session));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? '');

    // Both keys, because one address trying every account and every address
    // trying one account are both brute force. Checked before the password is,
    // so a blocked attempt costs no hashing.
    const keys = [limits.addressOf(req), `user:${username}`];
    for (const key of keys) {
      const blocked = limits.login.retryAfter(key);
      if (blocked) return limits.refuse(res, blocked);
    }
    const failed = () => keys.forEach((k) => limits.login.fail(k));

    /**
     * The admin signs in with ADMIN_PASSWORD rather than a stored hash.
     *
     * That password is the server's own configuration — the thing that says
     * "whoever runs this machine". Copying it into the user file at first login
     * would mean two places to change it and one of them silently winning.
     */
    if (username === ADMIN_USERNAME) {
      if (!gateEnabled || !secretsMatch(password, ADMIN_PASSWORD)) {
        failed();
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      const admin = await ensureAdminUser();
      const session = await createSession(admin.id);
      await markLogin(admin.id);
      keys.forEach((k) => limits.login.clear(k));
      return res.json(sessionPayload(admin, session));
    }

    const user = await findUserByUsername(username);
    // Same message either way: which half was wrong is not information a
    // stranger guessing at accounts should be given.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      failed();
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    const session = await createSession(user.id);
    await markLogin(user.id);
    keys.forEach((k) => limits.login.clear(k));
    res.json(sessionPayload(user, session));
  } catch (err) {
    next(err);
  }
});

// Logging out destroys the token server-side, so a copy of it that leaked
// somewhere stops working too — not merely forgotten by this browser.
router.post('/logout', async (req, res, next) => {
  try {
    await destroySession(credsFromRequest(req).session);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Change your own password. Knowing the current one is required even though you
// are already signed in: a session left open on someone else's machine should
// not be enough to lock you out of your own account.
router.post('/password', async (req, res, next) => {
  try {
    if (!req.actor || req.actor.globalRole === 'anon') {
      return res.status(401).json({ error: 'Sign in to do that.' });
    }
    const user = await store.get(USERS, req.actor.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.globalRole === 'admin') {
      return res.status(400).json({
        error: 'The admin password is server configuration — change ADMIN_PASSWORD instead.',
      });
    }

    // A stolen session shouldn't become a way to guess the password at leisure.
    const key = `pw:${user.id}`;
    const blocked = limits.login.retryAfter(key);
    if (blocked) return limits.refuse(res, blocked);

    const next_ = String(req.body?.password ?? '');
    const problem = validateCredentials(user.username || 'placeholder', next_);
    if (problem) return res.status(400).json({ error: problem });
    if (!(await verifyPassword(String(req.body?.current ?? ''), user.passwordHash))) {
      limits.login.fail(key);
      return res.status(401).json({ error: 'That current password is not right.' });
    }
    limits.login.clear(key);

    await store.update(USERS, user.id, { passwordHash: await hashPassword(next_) });
    // Everywhere else is signed out. Changing a password usually means someone
    // else has one of these, and a new password that leaves their session alive
    // has not taken the account back. The browser doing the asking keeps its
    // own, so this isn't self-defeating.
    await destroySessionsFor(user.id, { except: credsFromRequest(req).session });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Who am I? The client calls this on boot.
router.get('/me', async (req, res, next) => {
  try {
    if (!req.actor || req.actor.globalRole === 'anon') return res.json(req.actor);
    const user = await store.get(USERS, req.actor.userId);
    // publicUser strips email because other people don't get to see it — but
    // this is you looking at yourself, so it comes back.
    res.json({ ...req.actor, user: { ...publicUser(user), email: user?.email || '' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
