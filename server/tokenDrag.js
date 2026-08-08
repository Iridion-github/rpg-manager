'use strict';

/**
 * Live token dragging — the ephemeral half of token movement.
 *
 * A drag produces dozens of positions a second. Persisting each one would mean
 * a disk read-modify-write per frame through the store's serialized queue, so
 * we split the problem:
 *
 *   during the drag — socket only, nothing touches the disk (this file)
 *   on drop         — one HTTP PUT .../position, which persists and broadcasts
 *
 * Permission is checked once, at `token:drag:start`, and remembered on the
 * socket. Re-reading the scene on every frame just to re-answer "do you own
 * this?" would put the disk back in the hot path. The drop still goes through
 * the HTTP route, which re-checks ownership from disk — so a lie told over the
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

// Cheap sanity bounds: a drag position is in grid cells.
const inBounds = (v) => Number.isFinite(v) && v >= -500 && v <= 500;

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
        socket.data.drag = { campaignId, sceneId, tokenId };
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
      // rendering their own pointer.
      socket.to(roomFor(drag.campaignId)).emit('token:dragging', {
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
      socket.to(roomFor(drag.campaignId)).emit('token:drag:ended', {
        sceneId: drag.sceneId,
        tokenId: drag.tokenId,
      });
    };

    socket.on('token:drag:end', endDrag);
    socket.on('disconnect', endDrag); // dropped mid-drag: don't strand the ghost
  });
}

module.exports = { registerTokenDrag, roomFor };
