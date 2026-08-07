'use strict';

/**
 * Who is asking? — three roles, resolved from credentials.
 *
 *   gm     — knows GM_PASSWORD. Can do anything.
 *   player — presents a player key from the roster. Can move tokens they own.
 *   anon   — anyone else. Read-only.
 *
 * Dev mode: if GM_PASSWORD is unset the gate is open and everyone is treated as
 * the GM, which keeps `npm run dev` frictionless. Set GM_PASSWORD in real use
 * so friends coming through the tunnel get the role you actually gave them.
 *
 * Players never self-register: the GM creates them and hands out the key. An
 * open registration endpoint on a tunnel-exposed box would let anyone who finds
 * the URL mint themselves an identity.
 */

const crypto = require('node:crypto');
const store = require('./store');

const GM_PASSWORD = process.env.GM_PASSWORD || '';
const gateEnabled = Boolean(GM_PASSWORD);

const PLAYERS = 'players';

const ANON = Object.freeze({ role: 'anon', playerId: null, name: '' });

// Constant-time compare so a wrong password can't be discovered byte by byte.
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function newPlayerKey() {
  return crypto.randomBytes(24).toString('base64url');
}

async function findPlayerByKey(key) {
  if (!key) return null;
  const players = await store.list(PLAYERS);
  return players.find((p) => secretsMatch(p.key, key)) || null;
}

// The one place roles are decided. Both HTTP requests and socket handshakes
// funnel through here so they can't drift apart.
async function resolveActor({ gmPassword, playerKey }) {
  if (!gateEnabled) return { role: 'gm', playerId: null, name: 'GM (dev mode)' };
  if (secretsMatch(gmPassword, GM_PASSWORD)) {
    return { role: 'gm', playerId: null, name: 'GM' };
  }
  const player = await findPlayerByKey(playerKey);
  if (player) return { role: 'player', playerId: player.id, name: player.name };
  return { ...ANON };
}

function credsFromRequest(req) {
  return { gmPassword: req.get('x-gm-password'), playerKey: req.get('x-player-key') };
}

// Populates req.actor for every request.
function attachActor(req, res, next) {
  resolveActor(credsFromRequest(req))
    .then((actor) => {
      req.actor = actor;
      next();
    })
    .catch(next);
}

function requireGm(req, res, next) {
  if (req.actor && req.actor.role === 'gm') return next();
  return res.status(403).json({ error: 'Read-only: GM password required to make changes.' });
}

/**
 * The ownership rule, in one place: the GM may move any token, a player may
 * move only a token assigned to them, and nobody else may move anything.
 * Both the HTTP route and the socket drag handler call this — if they each had
 * their own copy, one of them would eventually be wrong.
 */
function canMoveToken(actor, token) {
  if (!actor || !token) return false;
  if (actor.role === 'gm') return true;
  return actor.role === 'player' && Boolean(token.ownerId) && token.ownerId === actor.playerId;
}

// Strip the secret before a record leaves the server.
function publicPlayer(player) {
  if (!player) return null;
  const { key, ...rest } = player;
  return rest;
}

module.exports = {
  PLAYERS,
  gateEnabled,
  resolveActor,
  credsFromRequest,
  attachActor,
  requireGm,
  canMoveToken,
  newPlayerKey,
  publicPlayer,
};
