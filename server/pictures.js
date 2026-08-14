'use strict';

/**
 * Where a profile picture or a character portrait is allowed to point.
 *
 * Both fields hold an address that every person looking at the account or the
 * sheet will have their browser fetch. An address on somebody else's server is
 * therefore a way to make the whole table call a machine you don't run: it sees
 * each of them arrive, and it chooses what comes back. The pictures this app
 * keeps are its own, so the rule is simply "a path on this server" - an upload
 * under /uploads, or the built-in artwork under /tokens.
 *
 * The content policy says the same thing one step later (img-src 'self', see
 * security.js), so a foreign address would be refused by the browser and draw
 * nothing at all. Saying it here means it can be said as an empty picture rather
 * than a broken one.
 */

// The same cap the scenes and tokens put on their own image fields.
const MAX = 500;

function pictureUrl(value) {
  const url = String(value ?? '').trim().slice(0, MAX);
  if (!url) return '';
  // One leading slash, and only one: "//elsewhere.example/x" is an address on
  // another host that reads like a path until you look at it twice.
  if (!url.startsWith('/') || url.startsWith('//')) return '';
  return url;
}

module.exports = { pictureUrl };
