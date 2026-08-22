'use strict';

/**
 * A read-only window onto the D&D 5e SRD API, through this server.
 *
 * ## Why it is proxied rather than fetched from the browser
 *
 * Two reasons, and the first is decisive: this app sends
 * `Content-Security-Policy: connect-src 'self'`, so a browser here cannot fetch
 * anything from another host. The alternative to a proxy is widening that to
 * name dnd5eapi.co, which trades a rule that is easy to reason about - *this
 * page talks to its own server and nowhere else* - for a rule with an exception
 * in it. A tab that browses reference data is not worth that.
 *
 * The second is the rate limit. The upstream allows 100 requests per window per
 * *address*, and behind a tunnel every player at the table shares one. Six
 * people idly clicking through equipment categories could exhaust it between
 * them; proxied, the cache below means the second person to open Armor costs
 * nothing at all.
 *
 * ## What it will fetch
 *
 * Only paths under `/api/2014/`, and only on this one host. Not because the SRD
 * is sensitive - it is famously public - but because an endpoint that forwards
 * wherever it is pointed is a way to make this server fetch things on somebody
 * else's behalf, and that is worth closing off whether or not anyone would.
 */

const express = require('express');
const { requireUser } = require('../auth');

const router = express.Router();

const UPSTREAM = 'https://www.dnd5eapi.co';

/**
 * Only the shapes this app actually asks for.
 *
 * The three levels of the tree it walks - the list of categories, one category,
 * one piece of equipment - plus magic items, which is where a third of the
 * entries under those categories point.
 */
const ALLOWED = [
  /^\/api\/2014\/equipment-categories$/,
  /^\/api\/2014\/equipment-categories\/[a-z0-9-]+$/,
  /^\/api\/2014\/equipment\/[a-z0-9-]+$/,
  /^\/api\/2014\/magic-items\/[a-z0-9-]+$/,
  // Spells. The list takes a filter, which is how that shelf is divided up -
  // there is no endpoint listing the levels or the schools, so the app asks for
  // one of them at a time. Spelled out one filter at a time rather than
  // allowing any query string, so this stays a list of the exact requests the
  // app makes.
  /^\/api\/2014\/spells$/,
  /^\/api\/2014\/spells\?level=[0-9]$/,
  /^\/api\/2014\/spells\?school=[a-z]+$/,
  /^\/api\/2014\/spells\/[a-z0-9-]+$/,
];

/**
 * What has been fetched already.
 *
 * The SRD is a book: it does not change between one session and the next, so
 * anything fetched once can be answered from memory for a good long while. In
 * memory rather than on disk because losing it costs one refetch, and a restart
 * is exactly when a stale copy would be worth losing anyway.
 */
const cache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

// A ceiling, so a bad loop cannot grow this without bound. Far more than the
// whole equipment tree, which is about a thousand documents.
const MAX_ENTRIES = 2000;

function cached(path) {
  const hit = cache.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(path);
    return null;
  }
  return hit.body;
}

function remember(path, body) {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(path, { at: Date.now(), body });
}

/**
 * Fetch one document, or answer from what we already hold.
 *
 * The path arrives as a query parameter rather than in the URL, so that this
 * route can check it against the list above as one whole string - a path
 * assembled from segments is a path somebody can put `..` in.
 */
router.get('/', requireUser, async (req, res, next) => {
  try {
    const path = String(req.query.path || '');
    if (!ALLOWED.some((allowed) => allowed.test(path))) {
      return res.status(400).json({ error: 'Not a reference path this app reads.' });
    }

    const hit = cached(path);
    if (hit) return res.json(hit);

    const upstream = await fetch(UPSTREAM + path, {
      headers: { accept: 'application/json' },
      // The reference shelf is not worth hanging a request on. Long enough for
      // a slow morning, short enough that a player is told rather than left
      // watching a spinner that will never stop.
      signal: AbortSignal.timeout(12000),
    });

    if (upstream.status === 404) {
      return res.status(404).json({ error: 'There is no such entry.' });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ error: 'The reference site is busy. Try again in a moment.' });
    }
    if (!upstream.ok) {
      return res.status(502).json({ error: 'The reference site could not be reached.' });
    }

    const body = await upstream.json();
    remember(path, body);
    res.json(body);
  } catch (err) {
    // A timeout or a dead network is not this server being broken, and saying
    // so plainly is more use than a 500 nobody can act on.
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return res.status(504).json({ error: 'The reference site did not answer in time.' });
    }
    if (err instanceof TypeError) {
      return res.status(502).json({ error: 'The reference site could not be reached.' });
    }
    next(err);
  }
});

module.exports = router;
