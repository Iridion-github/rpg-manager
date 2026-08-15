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

/**
 * A block read off a character sheet is allowed to be longer than a line of
 * talk, and is capped separately.
 *
 * 500 is a sentence somebody types, and it is the right size for one. A shared
 * block is a section of a sheet - eighteen skills, or a feature and what it
 * does - and cutting one at 500 characters would post half a feature, which is
 * worse than not posting it. This is what the browser's own preview is measured
 * against, so nothing is ever silently trimmed on the way in.
 */
const MAX_SHARE_LENGTH = 1500;
const MAX_SHARE_TITLE = 120;

// A coin is just a two-sided die as far as the maths is concerned.
const DICE = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const COIN = 2;
const MAX_DICE = 50;
const MAX_MODIFIER = 99;
// How many named extras one roll may carry. A character sheet's global
// modifiers arrive this way - Bless, Rage, a magic weapon - and a table with
// more than a handful running at once is not a table, it is a mistake.
const MAX_EXTRAS = 8;

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

/**
 * The named things riding along on a roll, cleaned up.
 *
 * Each is some dice, some flat bonus, or both, with a name saying where it came
 * from. They are rolled here with the roll they belong to and folded into its
 * total, which is the whole point: an extra d4 sent as a second roll would be a
 * second line in the chat with a second total, and "add a d4 to the attack" is
 * one number, not two.
 *
 * Anything that adds nothing is dropped rather than rolled: an entry with no
 * dice and no bonus would print its name beside a contribution of zero, which
 * is a line about nothing.
 */
function pickExtras(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_EXTRAS)) {
    if (!item || typeof item !== 'object') continue;
    const sides = Number(item.sides);
    // A coin is not something you add to a total, so it is not offered here
    // even though the main roll may be one.
    const rolls = DICE.has(sides) && sides !== COIN;
    const count = rolls ? clamp(Math.round(Number(item.count) || 1), 1, MAX_DICE) : 0;
    const modifier = clamp(Math.round(Number(item.modifier) || 0), -MAX_MODIFIER, MAX_MODIFIER);
    if (!count && !modifier) continue;
    out.push({ label: String(item.label ?? '').trim().slice(0, 40), count, sides: count ? sides : 0, modifier });
  }
  return out;
}

/**
 * One extra, said in words, connector and all: "plus 1d4 Bless: 3", "minus 2
 * Curse".
 *
 * The connector belongs to the extra rather than to the sentence joining them,
 * because it is what carries the sign of a flat one. Written the other way
 * round, a penalty reads "plus -2" and a bonus reads "plus +2", and one of
 * those is wrong twice over.
 */
function describeExtra(extra) {
  const named = extra.label ? ` ${extra.label}` : '';
  if (extra.count) {
    // Dice always add; a modifier riding with them keeps its own sign, since
    // there is no room for a second connector in the middle of a notation.
    const sign = extra.modifier > 0 ? `+${extra.modifier}` : `${extra.modifier}`;
    const dice = `${extra.count}d${extra.sides}${extra.modifier ? sign : ''}`;
    return `plus ${dice}${named}: ${extra.rolls.join(', ')}`;
  }
  return extra.modifier < 0
    ? `minus ${Math.abs(extra.modifier)}${named}`
    : `plus ${extra.modifier}${named}`;
}

// Plain-text form of a roll, so a message still reads sensibly anywhere that
// doesn't render the structured version - the offline cache included.
function describeRoll({
  count,
  sides,
  modifier,
  rolls,
  total,
  advantage,
  disadvantage,
  label,
  extras = [],
}) {
  if (sides === COIN) {
    return `flipped ${count} coin${count === 1 ? '' : 's'}: ${rolls.map(coinFace).join(', ')}`;
  }
  const sign = modifier > 0 ? `+${modifier}` : `${modifier}`;
  const notation = `${count}d${sides}${modifier ? sign : ''}`;
  const what = label ? `${label} (${notation})` : notation;
  // Which of the two dice counted, named so the line explains its own total.
  const swing = advantage ? 'advantage' : disadvantage ? 'disadvantage' : '';
  const kept = swing ? ` → kept ${advantage ? Math.max(...rolls) : Math.min(...rolls)}` : '';
  // Each extra named where it lands, between the dice and the total, so the
  // sum can be followed: a number that grew by four should say what the four
  // was for.
  const plus = extras.map((e) => `, ${describeExtra(e)}`).join('');
  return `rolled ${what}${swing ? ` with ${swing}` : ''}: ${rolls.join(', ')}${kept}${plus} = ${total}`;
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
 * Show the table something off a character sheet.
 *
 * A route of its own rather than a long chat line, for two reasons. It is
 * allowed more room, because a section of a sheet is longer than a sentence;
 * and it arrives with its own heading, so the log can draw it as the block it
 * is - "Evol - Features & traits" over the features - instead of a wall of text
 * somebody has to work out the shape of.
 *
 * The text is composed in the browser, which is the only place that knows what
 * a sheet says: the server stores sheets as documents and has no opinion about
 * how a skill list reads. What it does insist on is the same thing it insists
 * on for every other message - the author is whoever's credential sent it, and
 * nothing in the body can change that.
 *
 * Nothing here checks that the sender may read the sheet they are quoting. It
 * would be a check about the wrong thing: this posts text the sender already
 * had on their screen, and anybody at this table can type the same words into
 * the chat box by hand. The sheet's own permissions are what decide who can see
 * it in the first place (routes/sheets.js).
 */
router.post('/share', async (req, res, next) => {
  try {
    const speaker = speakerFor(req);
    if (!speaker) return res.status(403).json({ error: 'You are not at this table.' });

    const title = String(req.body?.title ?? '').trim().slice(0, MAX_SHARE_TITLE);
    const text = String(req.body?.text ?? '').trim().slice(0, MAX_SHARE_LENGTH);
    if (!text) return res.status(400).json({ error: 'Nothing to send.' });

    const message = {
      id: crypto.randomUUID(),
      kind: 'sheet',
      title,
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

    /**
     * Advantage and disadvantage: a d20 thing, and the same mechanism twice
     * over. Two dice are rolled and one is kept - the better or the worse -
     * rather than summed, so this replaces the dice count instead of
     * multiplying it.
     *
     * Asking for both is not refused, because the game already answers it: they
     * cancel, and you roll one die like anybody else. Refusing would be this
     * inventing a rule to replace one that exists.
     */
    const wants = (key) => Boolean(req.body?.[key]) && sides === 20;
    const both = wants('advantage') && wants('disadvantage');
    const advantage = wants('advantage') && !both;
    const disadvantage = wants('disadvantage') && !both;
    const swings = advantage || disadvantage;
    const label = String(req.body?.label ?? '').trim().slice(0, 100);
    const rolled = swings ? 2 : count;

    // A roll the rest of the table doesn't get to see. The DM always does -
    // this hides a result from the other players, it isn't a way to roll where
    // the DM can't check.
    const secret = Boolean(req.body?.secret);

    // Rolled here with the roll they belong to, so they land in one total and
    // one line. Never on a coin flip, which has no total to add to.
    const extras = sides === COIN ? [] : pickExtras(req.body?.extras).map((extra) => ({
      ...extra,
      rolls: Array.from({ length: extra.count }, () => crypto.randomInt(1, extra.sides + 1)),
    }));
    const extraTotal = extras.reduce(
      (sum, e) => sum + e.modifier + e.rolls.reduce((a, b) => a + b, 0),
      0
    );

    const rolls = Array.from({ length: rolled }, () => crypto.randomInt(1, sides + 1));
    // The modifier lands on the total once, not on each die: 2d20+5 rolling
    // 5 and 15 is 25, not 30. With a swing on, one of the two dice is kept -
    // the higher for advantage, the lower for disadvantage - and the other is
    // still reported, so the table can see what it beat or what it escaped.
    let base;
    if (advantage) base = Math.max(...rolls);
    else if (disadvantage) base = Math.min(...rolls);
    else base = rolls.reduce((sum, r) => sum + r, 0);
    const total = base + modifier + extraTotal;

    const roll = {
      count: rolled,
      sides,
      modifier,
      rolls,
      total,
      advantage,
      // Absent on every roll made before this existed, which reads as false
      // wherever it is asked about.
      ...(disadvantage ? { disadvantage: true } : {}),
      label,
      // Carried only when there are any, so an ordinary roll keeps the shape it
      // has always had - including in a browser holding an older cached log.
      ...(extras.length ? { extras } : {}),
    };
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
