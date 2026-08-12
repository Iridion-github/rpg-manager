'use strict';

/**
 * Changes that have been asked for but not yet confirmed.
 *
 * A password or an address only moves once the person has answered a letter, so
 * between the asking and the answering the new value has to live somewhere. It
 * lives here, and it lives *only* here - the account itself is untouched until
 * the link is followed, which is the whole point: someone who gets at a signed-in
 * browser can start one of these, and the owner of the mailbox can simply not
 * finish it.
 *
 * Three rules make that safe:
 *
 *   - the token is the whole authorisation, so what's stored is its *hash*.
 *     Reading the database gets you nothing you could click.
 *   - a pending change expires, because a link in an old mail should not be a
 *     key that works forever.
 *   - asking again replaces the last one, so the letter that arrives most
 *     recently is the only one that still works.
 *
 * A password waiting here is already hashed. Nothing ever stores the plain one.
 */

const crypto = require('node:crypto');
const store = require('./store');

const PENDING = 'accountChanges';

// Long enough to walk to another room and open a mail client, short enough that
// an abandoned request isn't a key left under the mat.
const TTL_MS = 60 * 60 * 1000;

// What goes in the URL, and what goes in the database. Never the same string.
const newToken = () => crypto.randomBytes(32).toString('hex');
const fingerprint = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const isExpired = (record) => !record?.expiresAt || Date.parse(record.expiresAt) <= Date.now();

/**
 * Put a change on hold and return the token that will finish it.
 *
 * `kind` is 'password', 'email' or 'reset'; `change` is the fields to apply to
 * the user when it's confirmed - a `passwordHash`, or an `email`. Any earlier
 * request of the same kind by the same person is dropped: two live links to two
 * different new passwords is a question nobody wants to have to answer.
 *
 * 'reset' carries no change at all, and that is the point of it rather than an
 * omission. The other two are decisions already made, waiting to be agreed to;
 * a reset is only permission to make one, and what it becomes is typed on the
 * page the link opens. Storing a password *somebody who is not the owner* chose
 * would mean a letter whose click-through hands the account to whoever asked.
 */
async function holdChange(userId, kind, change) {
  const waiting = await store.list(PENDING);
  for (const record of waiting) {
    if ((record.userId === userId && record.kind === kind) || isExpired(record)) {
      await store.remove(PENDING, record.id);
    }
  }
  const token = newToken();
  await store.put(PENDING, {
    id: fingerprint(token),
    userId,
    kind,
    change,
    askedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  });
  return token;
}

/**
 * Take a token and hand back the change it stands for, once.
 *
 * The record is removed whether or not it had expired - a token that has been
 * presented is spent either way, and leaving an expired one to be presented
 * again is just a slower version of the same mistake. Returns null when there
 * is nothing to apply, which is the same answer for a token that never
 * existed, one already used and one too old: which of the three it was is not
 * information a stranger guessing at links should be given.
 *
 * `kinds` is the list this caller is willing to act on. A token of some other
 * kind is refused *without* being spent - it belongs to a route that hasn't
 * been asked yet, and burning somebody's live email-change link because they
 * hand-edited a query parameter would be a small cruelty for no gain. Only a
 * token this door can actually open is consumed by knocking on it.
 */
async function claimChange(token, kinds) {
  if (!token) return null;
  const id = fingerprint(token);
  const record = await store.get(PENDING, id);
  if (!record) return null;
  if (kinds && !kinds.includes(record.kind)) return null;
  await store.remove(PENDING, id);
  if (isExpired(record)) return null;
  return record;
}

/** Drop everything waiting for one person - on a password change, say. */
async function forgetChangesFor(userId) {
  const waiting = await store.list(PENDING);
  for (const record of waiting) {
    if (record.userId === userId) await store.remove(PENDING, record.id);
  }
}

module.exports = { holdChange, claimChange, forgetChangesFor, TTL_MS, PENDING };
