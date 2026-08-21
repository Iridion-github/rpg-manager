'use strict';

/**
 * One place to emit live updates.
 *
 * Every broadcast carries `origin`, the writer's client id (see the client's
 * api.js). The writer already applied the change optimistically, so it uses
 * `origin` to skip its own echo rather than clobbering what it has typed since.
 * The exception is a knock-on change, which goes out with no origin at all
 * because the writer never applied it; see `originFor`.
 *
 * Everything here is scoped to a campaign. A socket announces which campaign it
 * is looking at (see index.js), and these functions only ever reach sockets
 * watching the same one - otherwise a chat line from one table would land in
 * another table's log. The HTTP side gets this from the URL; the socket side
 * has to be told, and until it has been, it receives nothing.
 */

const { roleIn } = require('./campaigns');

const originOf = (req) => req.get('x-client-id') || null;

/**
 * The origin to stamp on one broadcast.
 *
 * `origin` exists for exactly one purpose: a writer skips the echo of the
 * change it already applied optimistically, so what it has typed since is not
 * clobbered by its own round trip. That reasoning holds for the record the
 * writer actually wrote, and only for that one.
 *
 * A knock-on change is a different record: the sheet that a token's damage
 * moved, the token that a sheet's healing moved. The writer never touched it
 * and so never applied anything to it optimistically. Stamped with the writer's
 * client id it is thrown away by the one person who has both things on screen,
 * which is how applying damage on the map left the character sheet open beside
 * it showing the hit points from before the hit, until its reader reloaded.
 * Sent with no origin, it lands on the writer like it lands on everybody else.
 */
const originFor = (req, knockOn) => (knockOn ? null : originOf(req));

// Sockets currently watching this campaign.
function* watchers(io, campaignId) {
  if (!io || !campaignId) return;
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.campaignId === campaignId) yield socket;
  }
}

// Everyone at this table, same payload for all. `knockOn` marks a change the
// writer did not make itself; see originFor.
function broadcast(req, event, payload, { knockOn = false } = {}) {
  const io = req.app.get('io');
  const origin = originFor(req, knockOn);
  for (const socket of watchers(io, req.campaignId)) {
    socket.emit(event, { ...payload, origin });
  }
}

/**
 * Emit a *different* payload to each connection, decided by who's on the end of
 * it.
 *
 * `broadcast` reaches every member regardless of what they're allowed to see,
 * which is fine for public things like chat but wrong for anything
 * permissioned: one payload for everyone would hand a player the contents of a
 * sheet they can't open.
 *
 * `build(actor, role)` returns that connection's payload, or null to send it
 * nothing. `role` is recomputed from the campaign record on the request rather
 * than read from the socket, so a membership change that just landed is already
 * reflected instead of being one reconnect behind.
 *
 * `knockOn` marks a change the writer did not make itself; see originFor.
 */
function broadcastPerActor(req, event, build, { knockOn = false } = {}) {
  const io = req.app.get('io');
  const origin = originFor(req, knockOn);
  for (const socket of watchers(io, req.campaignId)) {
    const actor = socket.data.actor;
    const payload = build(actor, roleIn(req.campaign, actor));
    if (payload) socket.emit(event, { ...payload, origin });
  }
}

/**
 * Tell every connection of a given user something, wherever they're looking.
 *
 * Membership changes are the exception to campaign scoping: someone added to or
 * removed from a campaign needs to hear about it while looking at a *different*
 * campaign, or their list of tables is stale until they reload.
 */
function notifyUser(req, userId, event, payload) {
  const io = req.app.get('io');
  if (!io || !userId) return;
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.actor?.userId === userId) {
      socket.emit(event, { ...payload, origin: originOf(req) });
    }
  }
}

/**
 * Who is connected, and who is at this table right now.
 *
 * Three states, and the sockets already hold all of them: no connection is
 * offline, a connection looking elsewhere is online, and a connection that has
 * announced this campaign is present. Nothing is stored - presence is a fact
 * about live connections, and a stored copy would survive a crash as a lie.
 *
 * Present beats online when someone has two tabs open: one on the map and one
 * on the campaign directory is still a person sitting at this table.
 */
function presenceIn(io, campaignId) {
  const status = new Map();
  if (!io) return status;
  for (const socket of io.of('/').sockets.values()) {
    const userId = socket.data.actor?.userId;
    if (!userId) continue;
    if (socket.data.campaignId === campaignId) status.set(userId, 'present');
    else if (!status.has(userId)) status.set(userId, 'online');
  }
  return status;
}

/**
 * Everyone with a connection open, anywhere on this server.
 *
 * The same fact `presenceIn` reads, asked without a table in mind: the global
 * roster cares whether somebody is *here*, not which campaign they happen to be
 * looking at. Unstored for the same reason - a saved copy would survive a crash
 * as a list of people the server believes are connected to it.
 */
function onlineUserIds(io) {
  const online = new Set();
  if (!io) return online;
  for (const socket of io.of('/').sockets.values()) {
    const userId = socket.data.actor?.userId;
    if (userId) online.add(userId);
  }
  return online;
}

/**
 * Presence moved. Sent to everyone, with nothing in it.
 *
 * Any player list on screen is stale the moment someone connects, disconnects
 * or walks into a different campaign, and the ones who need to know are spread
 * across every table this person belongs to. An empty nudge lets each client
 * ask for the list it is allowed to see, rather than this having to work out
 * who may hear what.
 */
function announcePresence(io) {
  if (io) io.emit('presence:changed');
}

module.exports = {
  broadcast,
  broadcastPerActor,
  notifyUser,
  presenceIn,
  onlineUserIds,
  announcePresence,
};
