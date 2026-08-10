'use strict';

/**
 * Attempt limiting for the endpoints where guessing pays.
 *
 * Without this, a signup code or a password is only as strong as it is long,
 * because an attacker can try as fast as the server can answer — a four-digit
 * code is ten thousand requests, which is minutes. With it, the same code costs
 * days and gets noticed.
 *
 * In memory, deliberately. A restart forgets who was being blocked, which is
 * the right trade for a server that a handful of friends use: the alternative
 * is a table of failed logins on disk, and the thing being defended is already
 * behind a password. It also means the limiter can't be the reason the app
 * fails to start.
 *
 * Only *failures* count. A busy evening of legitimate use never trips it,
 * because success clears the counter.
 */

// Sweep interval for entries nobody has touched. unref() so a quiet server can
// still exit — a cleanup timer should never be the reason a process lingers.
const SWEEP_MS = 5 * 60_000;

function createLimiter({ max, windowMs, name }) {
  const attempts = new Map(); // key -> { count, firstAt, blockedUntil }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of attempts) {
      if (entry.firstAt < cutoff && (entry.blockedUntil || 0) < Date.now()) attempts.delete(key);
    }
  }, SWEEP_MS);
  sweep.unref();

  return {
    name,

    /**
     * Is this key allowed another try? Returns seconds to wait, or 0.
     *
     * Checked before the credential is, so a blocked caller costs nothing to
     * refuse — no password hashing, no database read.
     */
    retryAfter(key) {
      const entry = attempts.get(key);
      if (!entry?.blockedUntil) return 0;
      const left = entry.blockedUntil - Date.now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },

    fail(key) {
      const now = Date.now();
      const entry = attempts.get(key);
      // A window that has aged out starts over rather than accumulating
      // forever, so occasional fumbles across a week never add up to a block.
      if (!entry || now - entry.firstAt > windowMs) {
        attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
        return;
      }
      entry.count += 1;
      if (entry.count >= max) entry.blockedUntil = now + windowMs;
    },

    clear(key) {
      attempts.delete(key);
    },
  };
}

/**
 * Ten wrong passwords in fifteen minutes is someone guessing, not someone
 * typing badly. Keyed by address *and* by account: one address trying many
 * accounts and many addresses trying one account are both brute force.
 */
const login = createLimiter({ max: 10, windowMs: 15 * 60_000, name: 'login' });

// Registration is rarer, and the only failure worth counting is a wrong signup
// code — a rejected password length is a typo, not an attack.
const signup = createLimiter({ max: 10, windowMs: 60 * 60_000, name: 'signup' });

/**
 * A ceiling on *all* requests, not just the ones that failed.
 *
 * The limiters above defend secrets — they only count wrong answers, because a
 * thousand correct logins are not an attack. This counts everything, because
 * the thing it defends is the machine: a script that never guesses wrong can
 * still fill a disk with uploads or keep the process pinned.
 *
 * A fixed window rather than a sliding one. It lets through up to twice the
 * quota across a boundary, which for a ceiling this loose does not matter, and
 * it costs one integer per caller instead of a list of timestamps.
 */
function createThrottle({ max, windowMs, name }) {
  const hits = new Map(); // key -> { count, windowStart }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) if (entry.windowStart < cutoff) hits.delete(key);
  }, SWEEP_MS);
  sweep.unref();

  return {
    name,
    /** Spend one. Returns seconds to wait, or 0 if there was room. */
    take(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.windowStart > windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return 0;
      }
      entry.count += 1;
      if (entry.count <= max) return 0;
      return Math.ceil((entry.windowStart + windowMs - now) / 1000);
    },
  };
}

/**
 * Generous on purpose. A table in full flow — dropping tokens, rolling dice,
 * typing in chat — is a handful of writes a second at worst, and this sits an
 * order of magnitude above that. It is here to stop a script, not to pace a
 * game, and the failure it prevents (one player's browser locking the table
 * out) is worse than the one it allows.
 */
const api = createThrottle({ max: 600, windowMs: 60_000, name: 'api' });

// Uploads are the expensive write: 20 MB each, onto a disk you are paying for.
const uploads = createThrottle({ max: 40, windowMs: 60 * 60_000, name: 'uploads' });

/**
 * Which bucket a request counts against.
 *
 * The account first, the address second. A household behind one address is one
 * bucket if you go by address alone, and four friends at one table would spend
 * each other's quota; signed in, everybody carries their own.
 */
const bucketOf = (req) =>
  req.actor && req.actor.globalRole !== 'anon' ? `user:${req.actor.userId}` : `ip:${addressOf(req)}`;

/**
 * Who is asking?
 *
 * Behind a proxy — Render's router, or a Cloudflare Tunnel — every request
 * arrives from the same address unless Express is told to trust the forwarding
 * header. Getting that wrong doesn't fail quietly here: it would put the whole
 * table in one bucket and let one person's bad password lock everybody out. See
 * TRUST_PROXY in index.js.
 */
const addressOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

// One refusal, worded the same wherever it's used.
function refuse(res, seconds) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
  });
}

module.exports = {
  createLimiter,
  createThrottle,
  login,
  signup,
  api,
  uploads,
  bucketOf,
  addressOf,
  refuse,
};
