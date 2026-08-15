'use strict';

/**
 * Live token dragging - the ephemeral half of token movement.
 *
 * A drag produces dozens of positions a second. Persisting each one would mean
 * a disk read-modify-write per frame through the store's serialized queue, so
 * we split the problem:
 *
 *   during the drag - socket only, nothing touches the disk (this file)
 *   on drop         - one HTTP PUT .../position, which persists and broadcasts
 *
 * Permission is checked once, at `token:drag:start`, and remembered on the
 * socket. Re-reading the scene on every frame just to re-answer "do you own
 * this?" would put the disk back in the hot path. The drop still goes through
 * the HTTP route, which re-checks ownership from disk - so a lie told over the
 * socket moves a ghost on other people's screens but never gets saved.
 *
 * The campaign is taken from the socket's own state, never from the drag
 * payload: the socket said which table it was sitting at when it joined, and
 * letting a later message name a different one would be a way to reach into a
 * campaign you aren't in.
 */

const store = require('./store');
const { scoped, roleIn, canMoveToken, CAMPAIGNS } = require('./campaigns');

const SCENES = 'scenes';

const roomFor = (campaignId) => `campaign:${campaignId}`;

/**
 * The same table, DMs only.
 *
 * Joined at `campaign:enter` (see index.js), and used for exactly one thing: a
 * token the DM has hidden still has to be draggable, and the ghost that follows
 * the pointer must not appear on the players' boards. They were never sent the
 * token, so a ghost of it would be a monster announcing itself by moving.
 */
const dmRoomFor = (campaignId) => `campaign:${campaignId}:dm`;

// Cheap sanity bounds: a drag position is in grid cells.
const inBounds = (v) => Number.isFinite(v) && v >= -500 && v <= 500;

// Where a drag's ghost is allowed to be seen: the whole table, or the people
// running it when the token is one the players were never sent.
const ghostRoom = (drag) =>
  drag.hidden ? dmRoomFor(drag.campaignId) : roomFor(drag.campaignId);

function registerTokenDrag(io) {
  io.on('connection', (socket) => {
    socket.on('token:drag:start', async ({ sceneId, tokenId } = {}, ack) => {
      try {
        const campaignId = socket.data.campaignId;
        if (!campaignId) return ack?.({ ok: false, error: 'No campaign open.' });

        // Re-read membership rather than trusting what it was at join time: a
        // drag lasts seconds, but a socket can sit open for hours after the DM
        // has removed someone from the table.
        const campaign = await store.get(CAMPAIGNS, campaignId);
        const role = roleIn(campaign, socket.data.actor);
        if (!role) return ack?.({ ok: false, error: 'You are not at this table.' });

        const scene = await store.get(scoped(campaignId, SCENES), sceneId);
        const token = scene && (scene.tokens || []).find((t) => t.id === tokenId);
        if (!token) return ack?.({ ok: false, error: 'Token not found' });
        if (!canMoveToken(socket.data.actor, role, token)) {
          return ack?.({ ok: false, error: 'You can only move your own token.' });
        }
        // Whether the ghost this drag produces may be shown to the table.
        // Decided here, with the token in hand, and remembered for the same
        // reason permission is: a drag is dozens of frames a second and none of
        // them should cost a disk read. A token hidden mid-drag keeps showing
        // its ghost until the drag ends, which is a fraction of a second and
        // the price of not re-reading the scene per frame.
        socket.data.drag = { campaignId, sceneId, tokenId, hidden: token.visible === false };
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: 'Could not start drag' });
      }
    });

    socket.on('token:drag:move', ({ x, y } = {}) => {
      const drag = socket.data.drag;
      // No authorized drag in progress → ignore. This is what stops a crafted
      // client from shoving other people's tokens around.
      if (!drag) return;
      if (!inBounds(Number(x)) || !inBounds(Number(y))) return;
      // To everyone at *this table* except the dragger, who is already
      // rendering their own pointer - or, for a token the players cannot see,
      // to the other people running the table and nobody else.
      socket.to(ghostRoom(drag)).emit('token:dragging', {
        sceneId: drag.sceneId,
        tokenId: drag.tokenId,
        x: Number(x),
        y: Number(y),
        by: socket.data.actor?.name || '',
      });
    });

    const endDrag = () => {
      const drag = socket.data.drag;
      if (!drag) return;
      socket.data.drag = null;
      // Tell others the ghost is gone; the authoritative position arrives via
      // the scenes:changed broadcast from the persisted PUT.
      // The same room the ghost went to, or the message that clears it would
      // never reach the screens showing it.
      socket.to(ghostRoom(drag)).emit('token:drag:ended', {
        sceneId: drag.sceneId,
        tokenId: drag.tokenId,
      });
    };

    socket.on('token:drag:end', endDrag);
    socket.on('disconnect', endDrag); // dropped mid-drag: don't strand the ghost
  });
}

module.exports = { registerTokenDrag, roomFor, dmRoomFor };
