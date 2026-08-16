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
const { fogOn, reaches } = require('./fog');

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

/**
 * Everybody's tokens on this scene, by whose they are.
 *
 * Only the ones with an owner: a monster has no eyes to lend anybody, and a
 * token nobody owns can watch nothing. Read once at the start of a drag.
 */
function eyesIn(scene) {
  const eyes = new Map();
  for (const token of scene.tokens || []) {
    if (!token.ownerId) continue;
    const mine = eyes.get(token.ownerId) || [];
    mine.push(token);
    eyes.set(token.ownerId, mine);
  }
  return eyes;
}

/**
 * Whether this connection may watch that ghost move.
 *
 * The DM watches everything. A player watches their own token wherever it goes,
 * and anybody else's only while it is within sight of one of theirs. Somebody
 * with nothing on the board watches nothing, which is the same answer the scene
 * itself gives them.
 */
function canWatch(other, drag, ghost) {
  if (other.data.campaignRole === 'dm') return true;
  const userId = other.data.actor?.userId;
  if (!userId) return false;
  if (drag.ownerId && drag.ownerId === userId) return true;
  const mine = drag.eyes?.get(userId) || [];
  const at = { x: ghost.x, y: ghost.y, size: drag.size };
  return mine.some((eye) => reaches(eye, at));
}

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
        /**
         * And, on a board played in the dark, whose sight the ghost has to
         * pass before it may be shown.
         *
         * The eyes are read once, here, with the scene already in hand: they
         * are the *watchers'* tokens, which are standing still while somebody
         * else drags. The dragged token is what moves, so the test is redone
         * per frame against a position that changes - which is what lets a
         * monster walk into somebody's torchlight and appear as it arrives.
         */
        const dark = fogOn(scene);
        socket.data.drag = {
          campaignId,
          sceneId,
          tokenId,
          hidden: token.visible === false,
          dark,
          size: token.size || 1,
          ownerId: token.ownerId || null,
          eyes: dark ? eyesIn(scene) : null,
        };
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
      const ghost = {
        sceneId: drag.sceneId,
        tokenId: drag.tokenId,
        x: Number(x),
        y: Number(y),
        by: socket.data.actor?.name || '',
      };
      /**
       * In the dark the room is the wrong unit: who may watch a token move is
       * a question about where *they* are standing, and the answer differs
       * from one player to the next. So the frame is offered to each socket in
       * turn and most of them are told nothing.
       *
       * A hidden token is still settled by the room above this - it is hidden
       * from everyone whatever the fog says - and this only runs when it isn't.
       */
      if (drag.dark && !drag.hidden) {
        for (const other of io.of('/').sockets.values()) {
          if (other === socket) continue; // the dragger renders their own pointer
          if (other.data.campaignId !== drag.campaignId) continue;
          if (canWatch(other, drag, ghost)) other.emit('token:dragging', ghost);
        }
        return;
      }
      // To everyone at *this table* except the dragger, who is already
      // rendering their own pointer - or, for a token the players cannot see,
      // to the other people running the table and nobody else.
      socket.to(ghostRoom(drag)).emit('token:dragging', ghost);
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
