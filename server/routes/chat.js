'use strict';

/**
 * Table chat, within one campaign.
 *
 * The whole log lives in a single record rather than one record per message, so
 * appending and trimming happen in one atomic write. A message per record would
 * mean a write to add and further writes to prune, with the log briefly over
 * its cap in between.
 *
 * Every member of the campaign may read and post; a campaign you aren't in has
 * no chat you can reach at all, which is handled before this file runs.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast, broadcastPerActor } = require('../realtime');
const { scoped } = require('../campaigns');

const COLLECTION = 'chat';
const LOG_ID = 'log';
const MAX_MESSAGES = 300; // old talk isn't worth unbounded disk
const MAX_LENGTH = 500;

// A coin is just a two-sided die as far as the maths is concerned.
const DICE = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const COIN = 2;
const MAX_DICE = 50;
const MAX_MODIFIER = 99;

const router = express.Router({ mergeParams: true });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const chatOf = (req) => scoped(req.campaignId, COLLECTION);

// The name on a message is the name of whoever's credential sent it, and the
// role is the one they hold *at this table* - the same person is "DM" in one
// campaign's log and themselves in another's.
function speakerFor(req) {
  if (!req.campaignRole) return null;
  if (req.campaignRole === 'dm') return { author: 'DM', role: 'dm' };
  return { author: req.actor.name || 'Player', role: 'player' };
}

/**
 * May this connection see this line?
 *
 * A secret roll is for the person who made it and the DM, nobody else. The rule
 * is enforced on the way out as well as on the way in: everyone else is never
 * *sent* it, rather than sent it and asked not to look - a hidden line in the
 * payload is a hidden line the dev tools will happily show.
 *
 * `secretFor` is the roller's user id, recorded at the time. A player without
 * one (an invite key, no account) can't be matched, so their secret rolls are
 * the DM's alone - which is the safe way for that to be wrong.
 */
const canSeeMessage = (message, actor, role) =>
  !message.secret || role === 'dm' || Boolean(actor?.userId && actor.userId === message.secretFor);

// Append + trim in one atomic write; creates the log on the very first message.
function appendMessage(req, message) {
  return store.mutate(
    chatOf(req),
    LOG_ID,
    (current) => ({
      ...current,
      messages: [...(current.messages || []), message].slice(-MAX_MESSAGES),
    }),
    { createIfMissing: { messages: [] } }
  );
}

const coinFace = (v) => (v === 1 ? 'Heads' : 'Tails');

// Plain-text form of a roll, so a message still reads sensibly anywhere that
// doesn't render the structured version - the offline cache included.
function describeRoll({ count, sides, modifier, rolls, total, advantage, label }) {
  if (sides === COIN) {
    return `flipped ${count} coin${count === 1 ? '' : 's'}: ${rolls.map(coinFace).join(', ')}`;
  }
  const sign = modifier > 0 ? `+${modifier}` : `${modifier}`;
  const notation = `${count}d${sides}${modifier ? sign : ''}`;
  const what = label ? `${label} (${notation})` : notation;
  const kept = advantage ? ` → kept ${Math.max(...rolls)}` : '';
  return `rolled ${what}${advantage ? ' with advantage' : ''}: ${rolls.join(', ')}${kept} = ${total}`;
}

/**
 * Post a line the table didn't type - "the DM shared a handout", and friends.
 *
 * It's attributed to the DM rather than to a nameless system voice because it
 * only ever reports something the DM just did, and an unattributed line in a
 * chat log invites the question of who's talking.
 */
async function postSystemMessage(req, text) {
  const message = {
    id: crypto.randomUUID(),
    kind: 'system',
    text: String(text).slice(0, MAX_LENGTH),
    author: 'DM',
    role: 'dm',
    at: new Date().toISOString(),
  };
  await appendMessage(req, message);
  broadcast(req, 'chat:message', { message });
  return message;
}

router.get('/', async (req, res, next) => {
  try {
    const log = await store.get(chatOf(req), LOG_ID);
    const messages = log?.messages || [];
    res.json(messages.filter((m) => canSeeMessage(m, req.actor, req.campaignRole)));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const speaker = speakerFor(req);
    if (!speaker) return res.status(403).json({ error: 'You are not at this table.' });
    const text = String(req.body?.text ?? '').trim().slice(0, MAX_LENGTH);
    if (!text) return res.status(400).json({ error: 'Nothing to send.' });

    // The author comes from the credential, never from the request body - you
    // cannot post as somebody else by asking nicely.
    const message = {
      id: crypto.randomUUID(),
      text,
      author: speaker.author,
      role: speaker.role,
      at: new Date().toISOString(),
    };

    await appendMessage(req, message);
    broadcast(req, 'chat:message', { message });
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * Roll dice.
 *
 * Rolled here, not in the browser: a client-side roll is a client-side result,
 * and at a table that's the one number nobody should be able to choose. Uses
 * crypto.randomInt, which is uniform - Math.random() * n + 1 is not.
 */
router.post('/roll', async (req, res, next) => {
  try {
    const speaker = speakerFor(req);
    if (!speaker) return res.status(403).json({ error: 'You are not at this table.' });

    const sides = Number(req.body?.sides);
    if (!DICE.has(sides)) {
      return res.status(400).json({ error: 'Unknown die.' });
    }
    const count = clamp(Math.round(Number(req.body?.count) || 1), 1, MAX_DICE);
    // A coin has no numeric value to modify.
    const modifier =
      sides === COIN
        ? 0
        : clamp(Math.round(Number(req.body?.modifier) || 0), -MAX_MODIFIER, MAX_MODIFIER);

    // Advantage is a d20 thing: roll two and keep the better one, rather than
    // summing them. It replaces the dice count instead of multiplying it.
    const advantage = Boolean(req.body?.advantage) && sides === 20;
    const label = String(req.body?.label ?? '').trim().slice(0, 100);
    const rolled = advantage ? 2 : count;

    // A roll the rest of the table doesn't get to see. The DM always does -
    // this hides a result from the other players, it isn't a way to roll where
    // the DM can't check.
    const secret = Boolean(req.body?.secret);

    const rolls = Array.from({ length: rolled }, () => crypto.randomInt(1, sides + 1));
    // The modifier lands on the total once, not on each die: 2d20+5 rolling
    // 5 and 15 is 25, not 30.
    const base = advantage ? Math.max(...rolls) : rolls.reduce((sum, r) => sum + r, 0);
    const total = base + modifier;

    const roll = { count: rolled, sides, modifier, rolls, total, advantage, label };
    const message = {
      id: crypto.randomUUID(),
      kind: 'roll',
      text: describeRoll(roll),
      roll,
      author: speaker.author,
      role: speaker.role,
      at: new Date().toISOString(),
      // Only carried when it means something, so an ordinary roll keeps the
      // shape it has always had - including in browsers holding an older
      // cached copy of the log.
      ...(secret ? { secret: true, secretFor: req.actor?.userId || null } : {}),
    };

    await appendMessage(req, message);
    // Per connection rather than to the room: the same line goes to some people
    // and to nobody else, which is a decision `broadcast` can't express.
    broadcastPerActor(req, 'chat:message', (actor, role) =>
      canSeeMessage(message, actor, role) ? { message } : null
    );
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, postSystemMessage };
