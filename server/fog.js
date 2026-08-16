'use strict';

/**
 * Fog of war: how far a creature can see, and what that means for the board.
 *
 * A scene with fog on is one where the map is dark and each token lights its own
 * patch of it. Two numbers per token say how big that patch is:
 *
 *   clear   - out to here everything is seen normally
 *   dim     - out to here it is seen, greyed and drained of colour
 *             (past it there is nothing at all)
 *
 * Both are stored **in cells**, on the token, because that is what a token's
 * position is stored in and because sight belongs to the creature rather than to
 * the map it is standing on: bench a character with darkvision and place it on
 * another scene and it still has darkvision. Feet and metres are a way of
 * *writing* those cells down, which is a property of the scene (a map may be
 * drawn at five feet to the square or at ten), and that is why the unit and the
 * scale live on the scene while the distances do not.
 *
 * **The distances are enforced, not merely drawn.** A token nobody can see is
 * filtered out of the scene on its way to that person, exactly as a token the DM
 * has hidden is - see sceneAsSeenBy in campaigns.js. Painting the darkness in
 * the browser alone would put every monster's position in the page for anybody
 * who opened the dev tools, which is the one thing fog exists to prevent.
 *
 * What it does *not* do is model walls. Sight here is a radius and nothing else,
 * so a creature sees through the wall it is standing against. That is a bigger
 * feature with a different shape (line of sight against a drawn map), and this
 * one is honest about being a lantern rather than a floor plan.
 *
 * The client keeps the same arithmetic, in client/src/fog.js, because it draws
 * the darkness from the same numbers. If one of them changes the other has to
 * change with it, or the board will show a lit square the server says is dark.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The three ways of writing a distance down, and what one cell is worth in each. */
const UNITS = new Map([
  ['cells', 1],
  ['feet', 5],
  ['meters', 1.5],
]);

/**
 * The fog settings a scene carries. Absent reads as off, which is what every
 * scene made before this existed was.
 *
 * Takes the three fields either bare - which is what the fog route is sent - or
 * wrapped in a `fog` key, which is how they arrive inside a whole scene. What is
 * missing falls back to what is stored rather than to the defaults, so a request
 * about one field cannot quietly reset the other two.
 */
function sanitizeFog(body = {}, existing = {}) {
  const asked = body && typeof body.fog === 'object' && body.fog !== null ? body.fog : body || {};
  const current = existing.fog || {};
  const unit = UNITS.has(asked.unit) ? asked.unit : UNITS.has(current.unit) ? current.unit : 'feet';
  return {
    // Anything but an explicit true is off. A malformed value must never be
    // what plunges a table into darkness mid-session.
    on: 'on' in asked ? asked.on === true : current.on === true,
    unit,
    // How much of the unit one cell is worth. Editable because a map drawn at
    // ten feet to the square is a normal thing to be handed; bounded because a
    // scale of zero would make every distance infinite.
    perCell: clamp(num(asked.perCell, num(current.perCell, UNITS.get(unit))), 0.1, 1000),
  };
}

/** One field of a token's sight, in cells: a number, or null for "not said". */
const sightField = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? clamp(n, 0, 500) : null;
};

/**
 * What a token can see, in cells.
 *
 * Both fields blank is the one case the DM will meet most often - a row they
 * never filled in - and it means limitless perfect sight, so arming the fog does
 * not blind every creature nobody has got round to describing yet.
 *
 * Otherwise a blank field is "no limit on this band": sight clear to 30 with the
 * far edge left blank is a creature that sees clearly to 30 feet and dimly for
 * ever after. A far edge with no clear distance is a creature that perceives
 * dimly and never sharply, which is what a blank clear field can only mean.
 *
 * `clear` is held to `dim`, so a row typed the wrong way round dims rather than
 * lighting more than it should.
 */
function visionOf(token = {}) {
  const clear = sightField(token.visionClear);
  const dim = sightField(token.visionDim);
  if (clear === null && dim === null) return { clear: Infinity, dim: Infinity };
  const far = dim === null ? Infinity : dim;
  return { clear: Math.min(clear === null ? 0 : clear, far), dim: far };
}

/** Where a token's sight is measured from: the middle of the square it stands on. */
const centreOf = (token) => {
  const size = num(token.size, 1) || 1;
  return { x: num(token.x, 0) + size / 2, y: num(token.y, 0) + size / 2 };
};

/**
 * How far a point is from a token, in cells - to the nearest part of it rather
 * than to its middle.
 *
 * A dragon covers four squares, and the corner of it standing in your torchlight
 * is a dragon you can see. Measuring to its centre would hide half of a large
 * creature that is plainly in front of you, and would disagree with the lit
 * circle drawn on the map, which is the thing the eye is judging it against.
 */
function distanceTo(from, token) {
  const size = num(token.size, 1) || 1;
  const dx = Math.max(num(token.x, 0) - from.x, 0, from.x - (num(token.x, 0) + size));
  const dy = Math.max(num(token.y, 0) - from.y, 0, from.y - (num(token.y, 0) + size));
  return Math.hypot(dx, dy);
}

/** Whether this viewer's sight reaches that token at all - clear or dim, both count. */
const reaches = (viewer, target) => distanceTo(centreOf(viewer), target) <= visionOf(viewer).dim;

/**
 * Whether the fog is what decides this scene's tokens.
 *
 * Off, or on a scene with no fog block at all, everything else here is skipped
 * and the board is the board.
 */
const fogOn = (scene) => scene?.fog?.on === true;

/**
 * Which tokens this person may see through the fog.
 *
 * Your own, always: a fog that hid your own character from you would be a fog
 * you could not play through. Everything else has to be within reach of one of
 * them - and somebody with no tokens on the board sees an empty map, which is
 * the honest answer for a spectator at a table playing in the dark.
 *
 * The DM is not filtered here at all; that decision is made by the caller, since
 * it is the same one that decides about hidden tokens.
 */
function tokensSeenThroughFog(scene, actor) {
  const tokens = scene.tokens || [];
  const userId = actor?.userId;
  const mine = userId ? tokens.filter((t) => t.ownerId && t.ownerId === userId) : [];
  if (!mine.length) return [];
  // A creature with limitless sight makes the whole question moot, and skipping
  // the rest is the common case on a table that has only described a few rows.
  if (mine.some((t) => visionOf(t).dim === Infinity)) return tokens;
  return tokens.filter(
    (token) =>
      (token.ownerId && token.ownerId === userId) || mine.some((eye) => reaches(eye, token))
  );
}

module.exports = {
  UNITS,
  sanitizeFog,
  visionOf,
  centreOf,
  distanceTo,
  reaches,
  fogOn,
  tokensSeenThroughFog,
};
