'use strict';

/**
 * One place to emit live updates.
 *
 * Every broadcast carries `origin`, the writer's client id (see the client's
 * api.js). The writer already applied the change optimistically, so it uses
 * `origin` to skip its own echo rather than clobbering what it has typed since.
 *
 * Everything here is scoped to a campaign. A socket announces which campaign it
 * is looking at (see index.js), and these functions only ever reach sockets
 * watching the same one — otherwise a chat line from one table would land in
 * another table's log. The HTTP side gets this from the URL; the socket side
 * has to be told, and until it has been, it receives nothing.
 */

const { roleIn } = require('./campaigns');

const originOf = (req) => req.get('x-client-id') || null;

// Sockets currently watching this campaign.
function* watchers(io, campaignId) {
  if (!io || !campaignId) return;
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.campaignId === campaignId) yield socket;
  }
}

// Everyone at this table, same payload for all.
function broadcast(req, event, payload) {
  const io = req.app.get('io');
  const origin = originOf(req);
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
 */
function broadcastPerActor(req, event, build) {
  const io = req.app.get('io');
  const origin = originOf(req);
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

module.exports = { broadcast, broadcastPerActor, notifyUser };
