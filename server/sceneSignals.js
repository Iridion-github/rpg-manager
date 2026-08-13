'use strict';

/**
 * Pings and focus pulls - things one person does *to everyone's screen*.
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
 * The campaign comes from the socket's own state, never the payload - same rule
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

/**
 * A ruler is measured in *cells*, not map pixels - the same coordinates tokens
 * stand on. Wider bounds than a map has cells, since a measurement is allowed
 * to run off the edge of the picture.
 */
const inCells = (v) => Number.isFinite(v) && v >= -500 && v <= 500;

// Ceilings on the shape of the thing, since this is relayed rather than stored
// and so has no schema anywhere else to stop it growing. Generous next to any
// real use - a dozen chains of fifty points is far past the point where a
// board becomes unreadable - and small enough that the worst a crafted client
// can put on somebody else's screen is a mess they can clear by leaving.
const MAX_CHAINS = 12;
const MAX_POINTS = 50;

/**
 * The measurements as they may be passed on, or null if they may not be.
 *
 * Null rather than an empty list for a malformed payload: empty is a real and
 * meaningful state - it is how a ruler gets taken down - and answering a bad
 * message with it would let a garbled packet wipe the sender's own board.
 */
function sanitizeMeasurements(list) {
  if (!Array.isArray(list) || list.length > MAX_CHAINS) return null;
  const clean = [];
  for (const item of list) {
    const points = item?.points;
    if (!Array.isArray(points) || points.length > MAX_POINTS) return null;
    const kept = [];
    for (const p of points) {
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!inCells(x) || !inCells(y)) return null;
      kept.push({ x, y });
    }
    // A chain of one point is a click somebody hasn't finished; it draws
    // nothing and is worth carrying, so the far end sees it appear as it grows.
    if (kept.length) clean.push({ id: String(item?.id || '').slice(0, 40), points: kept });
  }
  return clean;
}

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

      // The sender's name comes from the socket's identity, never the payload -
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
     * sees. Clients that aren't on this scene ignore it - moving the viewport of
     * someone reading a different map would be motion with no meaning.
     */
    /**
     * "Here is what I am measuring." A ruler somebody has left on the board.
     *
     * The third ephemeral signal, and the one that lasts longest: a ping is a
     * flash and a focus is a jump, but a shared measurement stands on other
     * people's screens until its owner takes it down. It is still not data -
     * nobody wants yesterday's tape measure restored with the map - so it lives
     * here with the other two and never reaches the disk.
     *
     * The whole set travels on every change rather than one point at a time.
     * There are at most a handful of points, and a stream of increments is a
     * stream that can arrive out of order or with a gap in the middle, leaving
     * a line on somebody's screen that was never drawn on anyone's. Sending the
     * state instead of the change makes a lost message a frame of staleness
     * rather than a lasting disagreement.
     *
     * How it is read and how it is drawn travel with it, so a shared ruler says
     * the same thing on every screen it appears on. `unit` and `perCell`
     * because two people at one table can have the panel set differently, and a
     * ruler that said 15 ft to one of them and 4.5 m to the other would be two
     * different claims about one line. `movement` for the same reason and a
     * sharper one: it decides whether diagonals are counted flat or 5, 10, 5,
     * and those are different numbers for the same line rather than the same
     * number in different words. `color` and `thickness` because a line
     * somebody deliberately drew thick and red is one they are pointing at.
     */
    socket.on(
      'scene:measure',
      async ({ sceneId, measurements, unit, perCell, movement, color, thickness } = {}) => {
        const campaignId = socket.data.campaignId;
        if (!campaignId) return;
        if (typeof sceneId !== 'string' || !sceneId) return;

        // Not run through `cleared()`. That gate exists to stop a loop flashing
        // pings faster than a hand could, and it drops what it refuses - which
        // for a stream of states would mean silently keeping an old ruler on
        // screen after the newer one that replaced it was thrown away. Dragging
        // a pointer across the map legitimately produces changes faster than
        // four a second, so this is capped by shape instead: a short list of
        // short lists, and no disk touched whatever arrives.
        const campaign = await store.get(CAMPAIGNS, campaignId);
        if (!roleIn(campaign, socket.data.actor)) return;

        const clean = sanitizeMeasurements(measurements);
        if (clean === null) return;

        // Remembered so a dropped connection can take the ruler down with it.
        socket.data.measuring = clean.length ? { campaignId, sceneId } : null;

        socket.to(roomFor(campaignId)).emit('scene:measured', {
          sceneId,
          // The sender's own id, so a viewer can key one ruler per person and
          // replace it rather than accumulating every state ever sent. From the
          // socket's identity, never the payload - a measurement that could name
          // its own author would be a way to wipe somebody else's off the board.
          userId: socket.data.actor?.userId || '',
          by: socket.data.actor?.name || '',
          measurements: clean,
          unit: typeof unit === 'string' ? unit.slice(0, 12) : 'cells',
          perCell: Number.isFinite(Number(perCell)) ? Number(perCell) : 1,
          movement: movement === true,
          color: isHexColor(color) ? color : '#ffd479',
          // Clamped to the range the panel offers rather than trusted: this
          // number becomes a stroke width on somebody else's screen, and a
          // ruler drawn ten thousand pixels wide is a ruler over their map.
          thickness: Math.min(12, Math.max(1, Number(thickness) || 2)),
        });
      }
    );

    /**
     * Take it down: on unsharing, on leaving the mode, and on dropping off.
     *
     * The last is why this is a function rather than three copies of an emit.
     * Somebody whose laptop closes mid-measurement would otherwise leave a
     * ruler on everybody else's board with nobody left who could clear it.
     */
    const stopMeasuring = () => {
      const measuring = socket.data.measuring;
      if (!measuring) return;
      socket.data.measuring = null;
      socket.to(roomFor(measuring.campaignId)).emit('scene:measured', {
        sceneId: measuring.sceneId,
        userId: socket.data.actor?.userId || '',
        by: socket.data.actor?.name || '',
        measurements: [],
      });
    };

    socket.on('scene:measure:end', stopMeasuring);
    socket.on('disconnect', stopMeasuring);

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
