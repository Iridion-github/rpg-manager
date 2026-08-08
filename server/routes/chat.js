'use strict';

/**
 * Table chat.
 *
 * The whole log lives in a single record rather than one record per message, so
 * appending and trimming happen in one atomic write. A message per record would
 * mean a write to add and further writes to prune, with the log briefly over
 * its cap in between.
 *
 * Anyone who can reach the server may *read* the chat — spectators included,
 * since they can already see the table. Posting requires an identity: the GM or
 * a player holding an invite key.
 */

const express = require('express');
const crypto = require('node:crypto');
const store = require('../store');
const { broadcast } = require('../realtime');

const COLLECTION = 'chat';
const LOG_ID = 'log';
const MAX_MESSAGES = 300; // old talk isn't worth unbounded disk
const MAX_LENGTH = 500;

// A coin is just a two-sided die as far as the maths is concerned.
const DICE = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const COIN = 2;
const MAX_DICE = 50;
const MAX_MODIFIER = 99;

const router = express.Router();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function speakerFor(actor) {
  if (!actor) return null;
  // 'GM (dev mode)' is a useful startup log line but a silly chat name.
  if (actor.role === 'gm') return { author: 'GM', role: 'gm' };
  if (actor.role === 'player') return { author: actor.name || 'Player', role: 'player' };
  return null; // spectators can read, not speak
}

// Append + trim in one atomic write; creates the log on the very first message.
function appendMessage(message) {
  return store.mutate(
    COLLECTION,
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
// doesn't render the structured version — the offline cache included.
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

router.get('/', async (req, res, next) => {
  try {
    const log = await store.get(COLLECTION, LOG_ID);
    res.json(log?.messages || []);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const speaker = speakerFor(req.actor);
    if (!speaker) {
      return res.status(403).json({ error: 'Ask your GM for an invite link to join the chat.' });
    }
    const text = String(req.body?.text ?? '').trim().slice(0, MAX_LENGTH);
    if (!text) return res.status(400).json({ error: 'Nothing to send.' });

    // The author comes from the credential, never from the request body — you
    // cannot post as somebody else by asking nicely.
    const message = {
      id: crypto.randomUUID(),
      text,
      author: speaker.author,
      role: speaker.role,
      at: new Date().toISOString(),
    };

    await appendMessage(message);
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
 * crypto.randomInt, which is uniform — Math.random() * n + 1 is not.
 */
router.post('/roll', async (req, res, next) => {
  try {
    const speaker = speakerFor(req.actor);
    if (!speaker) {
      return res.status(403).json({ error: 'Ask your GM for an invite link to roll dice.' });
    }

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
    };

    await appendMessage(message);
    broadcast(req, 'chat:message', { message });
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
