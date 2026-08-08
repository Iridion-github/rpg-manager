'use strict';

/**
 * Who is asking? — global identity, which is *not* the same thing as what you
 * may do.
 *
 * There are two separate questions in this app, and keeping them apart is the
 * point of this file:
 *
 *   1. Who are you?      — answered here. A user record, or nobody (anon).
 *   2. What are you here? — answered per campaign, in campaigns.js. The same
 *                           person is a DM at one table and a player at another.
 *
 * Three ways to prove who you are, checked in that order:
 *
 *   session      — you logged in. A random token, stored server-side, sent as
 *                  x-session. This is the normal path.
 *   admin password — ADMIN_PASSWORD, which authenticates as the seeded admin.
 *   invite key   — the older credential, a per-user secret in a link. Still
 *                  honoured so existing invites don't break.
 *
 * Global roles: admin (mints users), user, anon.
 *
 * Admin deliberately grants *nothing* inside a campaign. An admin who isn't a
 * member of your table sees exactly what a stranger sees.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);

// GM_PASSWORD is the old name, kept working so an existing setup doesn't break.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.GM_PASSWORD || '';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const gateEnabled = Boolean(ADMIN_PASSWORD);

/**
 * A code that registration demands, when set.
 *
 * Unset means anyone who can reach the server can sign up, which is what you
 * want on your own machine and emphatically not what you want on a hostname a
 * stranger can find. Set it before you open the tunnel; the startup banner says
 * so if you haven't.
 */
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const signupIsOpen = !SIGNUP_CODE;

const USERS = 'users';
const SESSIONS = 'sessions';

// Long enough that nobody sits logged out mid-campaign, short enough that a
// forgotten token on a shared machine doesn't last forever.
const SESSION_DAYS = 30;

const ANON = Object.freeze({ globalRole: 'anon', userId: null, name: '', username: '' });

// Distinct, readable-on-dark token colours.
const PALETTE = ['#e5534b', '#3fb950', '#58a6ff', '#d29922', '#bc8cff', '#39c5cf'];

// scrypt is in the standard library and is a real password KDF — unlike a plain
// hash, it's deliberately slow and memory-hard, so a stolen users.json can't be
// run through a wordlist at speed. No dependency needed for it.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

// Constant-time compare so a wrong secret can't be discovered byte by byte.
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, SCRYPT);
  // Scheme tagged so a future change of KDF can tell old hashes from new ones.
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const [scheme, saltPart, hashPart] = stored.split(':');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;
  const salt = Buffer.from(saltPart, 'base64url');
  const expected = Buffer.from(hashPart, 'base64url');
  const actual = await scrypt(password, salt, expected.length, SCRYPT);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const newUserKey = () => crypto.randomBytes(24).toString('base64url');
const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
const colorFor = (index) => PALETTE[index % PALETTE.length];

// Usernames and emails are compared lowercased so "Kira" and "kira" can't both
// exist — two accounts that look identical in a members list is a way to be
// impersonated, and two accounts on one address break recovery.
const normalizeUsername = (v) => String(v || '').trim().toLowerCase();
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

const USERNAME_RE = /^[a-z0-9_-]{4,30}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 30;
const MAX_NAME = 60;

/**
 * Good enough for a form, and no more.
 *
 * An address is only truly valid if mail sent to it arrives, which no pattern
 * can tell you — this exists to catch a typo, not to be a specification. RFC
 * 5322 in a regex would reject real addresses and still accept dead ones.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL = 254;

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 4–30 characters: letters, numbers, dash, underscore.';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters.`;
  }
  return null;
}

function validateProfile(name, email) {
  if (!name) return 'Tell us what to call you.';
  if (name.length > MAX_NAME) return `Shown name must be at most ${MAX_NAME} characters.`;
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return "That doesn't look like an email address.";
  }
  return null;
}

async function findUserByKey(key) {
  if (!key) return null;
  const users = await store.list(USERS);
  return users.find((u) => u.key && secretsMatch(u.key, key)) || null;
}

async function findUserByUsername(username) {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;
  const users = await store.list(USERS);
  return users.find((u) => normalizeUsername(u.username) === wanted) || null;
}

async function findUserByEmail(email) {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  // Accounts made before emails existed have none — they can't collide.
  const users = await store.list(USERS);
  return users.find((u) => u.email && normalizeEmail(u.email) === wanted) || null;
}

const actorFor = (user) => ({
  globalRole: user.globalRole === 'admin' ? 'admin' : 'user',
  userId: user.id,
  name: user.name,
  username: user.username || '',
});

// --- sessions ---

async function createSession(userId) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  // The token *is* the record id, so checking one is a lookup rather than a
  // scan of every session on the server.
  await store.create(SESSIONS, { id: token, userId, expiresAt });
  return { token, expiresAt };
}

async function userForSession(token) {
  if (!token) return null;
  const session = await store.get(SESSIONS, token);
  if (!session) return null;
  if (Date.parse(session.expiresAt || '') < Date.now()) return null; // expired
  const user = await store.get(USERS, session.userId);
  return user || null; // the account may have been deleted since
}

const destroySession = (token) => (token ? store.remove(SESSIONS, token) : Promise.resolve(false));

// Drop every session belonging to a user — used when their account is deleted
// or their credentials rotated, so a token issued earlier stops working.
async function destroySessionsFor(userId) {
  const sessions = await store.list(SESSIONS);
  for (const s of sessions) {
    if (s.userId === userId) await store.remove(SESSIONS, s.id);
  }
}

/**
 * The admin is a real user record, not just a password.
 *
 * It has to be: an admin who runs a campaign is its DM, and membership is a map
 * of user ids. A password alone has no id to put in that map. The password is
 * how you authenticate *as* the admin user, not the identity itself — which is
 * also why the admin can sign in through the normal login form, using
 * ADMIN_USERNAME and ADMIN_PASSWORD.
 */
async function ensureAdminUser() {
  const users = await store.list(USERS);
  const existing = users.find((u) => u.globalRole === 'admin');
  if (existing) {
    // Older admin records predate usernames; give it one so it can log in.
    if (!existing.username) {
      return store.update(USERS, existing.id, { username: ADMIN_USERNAME });
    }
    return existing;
  }
  return store.create(USERS, {
    name: process.env.ADMIN_NAME || 'Admin',
    username: ADMIN_USERNAME,
    color: colorFor(users.length),
    key: newUserKey(),
    globalRole: 'admin',
  });
}

/**
 * Turn whatever credentials came in into an identity.
 *
 * An explicit credential always wins, *including* in dev mode. Without that,
 * logging in as a player on an open-gate server would silently keep making you
 * the admin — which defeats the entire point of being able to test the roles.
 * Dev mode is the fallback for requests that present nothing at all.
 */
async function resolveActor({ adminPassword, userKey, session }) {
  if (session) {
    const user = await userForSession(session);
    if (user) return actorFor(user);
  }
  if (gateEnabled && secretsMatch(adminPassword, ADMIN_PASSWORD)) {
    return actorFor(await ensureAdminUser());
  }
  if (userKey) {
    const user = await findUserByKey(userKey);
    if (user) return actorFor(user);
  }
  if (!gateEnabled) {
    // Open gate (dev): an unauthenticated visitor is the admin, which keeps
    // local work frictionless. See index.js — every other way of starting the
    // server demands a password.
    const admin = await ensureAdminUser();
    return { ...actorFor(admin), name: `${admin.name} (dev mode)` };
  }
  return { ...ANON };
}

function credsFromRequest(req) {
  return {
    session: req.get('x-session'),
    // x-gm-password and x-player-key are the old header names, still accepted
    // so a browser holding a credential from before the rename keeps working.
    adminPassword: req.get('x-admin-password') || req.get('x-gm-password'),
    userKey: req.get('x-user-key') || req.get('x-player-key'),
  };
}

function attachActor(req, res, next) {
  resolveActor(credsFromRequest(req))
    .then((actor) => {
      req.actor = actor;
      next();
    })
    .catch(next);
}

function requireUser(req, res, next) {
  if (req.actor && req.actor.globalRole !== 'anon') return next();
  return res.status(401).json({ error: 'Sign in to do that.' });
}

function requireAdmin(req, res, next) {
  if (req.actor && req.actor.globalRole === 'admin') return next();
  return res.status(403).json({ error: 'Only the server admin can do that.' });
}

/**
 * Strip everything private before a record leaves the server.
 *
 * Email goes too. The user list is readable by any signed-in person so that a
 * DM can pick members from it — that's a reason to expose names, not the
 * address someone hands over to recover their account. You see your own on
 * /auth/me; the admin sees all of them on /users/keys.
 */
function publicUser(user) {
  if (!user) return null;
  const { key, passwordHash, email, ...rest } = user;
  return rest;
}

module.exports = {
  USERS,
  SESSIONS,
  ANON,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  gateEnabled,
  signupIsOpen,
  SIGNUP_CODE,
  resolveActor,
  credsFromRequest,
  attachActor,
  requireUser,
  requireAdmin,
  ensureAdminUser,
  newUserKey,
  publicUser,
  colorFor,
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
};
