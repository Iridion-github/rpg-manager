/**
 * How an HP bar is divided up, in one place.
 *
 * Three bars draw the same fact - the hover tooltip on the map, the turn
 * tracker down the side of it, and the character sheet - and they used to work
 * out their own widths from their own reading of the same two fields. That was
 * fine while the answer was one division. Temporary points make it three
 * segments and a decision about what to do when they overflow, and three
 * copies of that would be three chances for the same creature to look different
 * depending on which of them you happened to be looking at.
 *
 * **The track is the maximum plus whatever temporary points there are.** Not
 * the maximum alone. A creature at full health with ten temporary points has to
 * show them somewhere, and there is no room left inside a full bar - the
 * segment would be clipped to nothing at exactly the moment it is most worth
 * seeing. Widening the track means the green shrinks a little when a ward
 * lands, which looks briefly like a loss and is not; the alternative was a
 * cushion you could not see at all, which is worse.
 *
 * When there are no temporary points the track is the maximum and the maths is
 * what it always was, to the pixel. Nothing about an ordinary bar changes.
 *
 * **The order is green, blue, then the wound.** Damage comes off temporary
 * points first, so the blue sits against the green edge and is eaten before it
 * - which is what the bar then shows happening, rather than a gap opening
 * somewhere else.
 */

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `null` when there is nothing to draw, so a caller can ask one question
 * instead of two. A total of zero is a creature whose hit points nobody set up,
 * not one at death's door.
 */
export function hpBar(current, max, temp) {
  const total = Math.max(0, number(max));
  if (!total) return null;
  // Clamped for the bar's sake: a stored value can outlive the total it was
  // measured against if the DM lowers the maximum afterwards.
  const now = Math.max(0, Math.min(number(current), total));
  const spare = Math.max(0, number(temp));
  const span = total + spare;
  return {
    current: now,
    total,
    temp: spare,
    currentPercent: (now / span) * 100,
    tempPercent: (spare / span) * 100,
  };
}
