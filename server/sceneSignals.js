'use strict';

/**
 * Pings and focus pulls — things one person does *to everyone's screen*.
 *
 * Neither is data. A ping is a coloured pulse at a spot on the map and a focus
 * moves everybody's camera there; a minute later there is nothing to have
 * saved. So they live entirely on the socket, like token dragging, and nothing
 * here touches the disk except to re-check that the sender is still at the
 * table.
 *
 * Positions travel in *unzoomed map pixels*, not cells and not screen
 * coordinates. Screen coordinates would mean everyone with a different window
 * size looks somewhere different, and cells stop being a unit at all when the
 * grid is off. Map pixels are the one frame of reference every client shares.
 *
 * The campaign comes from the socket's own state, never the payload — same rule
 * as tokenDrag.js. A message that could name its own campaign would be a way to
 * flash a ping on a table you aren't sitting at.
 */

const store = require('./store');
const { roleIn, CAMPAIGNS } = require('./campaigns');
const { roomFor } = require('./tokenDrag');

// Both signals are things a person does by hand, so anything faster than this
// is a loop rather than a player. Cheap insurance against a client that spams
// focus and pins everyone's view in place.
const MIN_GAP_MS = 250;

// Map pixels. Generous enough for any map anyone will use, small enough that a
// number outside it is a bug or a lie rather than a big battlemap.
const inBounds = (v) => Number.isFinite(v) && v >= -20000 && v <= 20000;

const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function registerSceneSignals(io) {
  io.on('connection', (socket) => {
    /**
     * Is this connection allowed to shout right now?
     *
     * Membership is re-read rather than trusted from join time: a socket can sit
     * open for hours after the DM has removed someone from the table. Returns
     * the campaign id to broadcast into, or null.
     */
    async function cleared() {
      const campaignId = socket.data.campaignId;
      if (!campaignId) return null;

      const now = Date.now();
      if (now - (socket.data.lastSignalAt || 0) < MIN_GAP_MS) return null;
      socket.data.lastSignalAt = now;

      const campaign = await store.get(CAMPAIGNS, campaignId);
      if (!roleIn(campaign, socket.data.actor)) return null;
      return campaignId;
    }

    /**
     * "Look here." A pulse at a point, for everyone at the table.
     *
     * Any member may ping. It draws a circle and disappears; the worst a bored
     * player can do with it is be briefly annoying, and that's a problem for the
     * table rather than for the server.
     */
    socket.on('scene:ping', async ({ sceneId, x, y, color } = {}) => {
      const campaignId = await cleared();
      if (!campaignId) return;
      if (typeof sceneId !== 'string' || !sceneId) return;
      if (!inBounds(Number(x)) || !inBounds(Number(y))) return;

      // The sender's name comes from the socket's identity, never the payload —
      // otherwise a ping could claim to be from anyone.
      io.to(roomFor(campaignId)).emit('scene:pinged', {
        sceneId,
        x: Number(x),
        y: Number(y),
        color: isHexColor(color) ? color : '#ffd479',
        by: socket.data.actor?.name || '',
      });
    });

    /**
     * "Everyone look here." Same point, plus the sender's zoom.
     *
     * Sent to the whole room including the sender, so one code path moves every
     * camera and the person who asked for it sees exactly what everyone else
     * sees. Clients that aren't on this scene ignore it — moving the viewport of
     * someone reading a different map would be motion with no meaning.
     */
    socket.on('scene:focus', async ({ sceneId, x, y, zoom } = {}) => {
      const campaignId = await cleared();
      if (!campaignId) return;
      if (typeof sceneId !== 'string' || !sceneId) return;
      if (!inBounds(Number(x)) || !inBounds(Number(y))) return;

      const level = Number(zoom);
      if (!Number.isFinite(level) || level <= 0 || level > 8) return;

      io.to(roomFor(campaignId)).emit('scene:focused', {
        sceneId,
        x: Number(x),
        y: Number(y),
        zoom: level,
        by: socket.data.actor?.name || '',
      });
    });
  });
}

module.exports = { registerSceneSignals };
