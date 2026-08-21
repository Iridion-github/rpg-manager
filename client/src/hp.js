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
 *
 * **Non-lethal damage is laid over the top, from the left.** Not a segment
 * among the others: a bruise is not a fourth kind of hit point, it is a count
 * of how much of what the creature has left has been beaten out of it. So it
 * runs across whatever it covers - green, then blue - and the moment it reaches
 * the wound at the far end, the creature has been battered as far as it can go
 * and drops. `out` is that moment, said as a number rather than left to be
 * eyeballed off the pixels.
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
export function hpBar(current, max, temp, nonLethal) {
  const total = Math.max(0, number(max));
  if (!total) return null;
  // Clamped for the bar's sake: a stored value can outlive the total it was
  // measured against if the DM lowers the maximum afterwards.
  const now = Math.max(0, Math.min(number(current), total));
  const spare = Math.max(0, number(temp));
  const span = total + spare;
  // Not clamped to anything: a creature can take more of a beating than it has
  // left to give, and the bar saying so - grey running the whole way across -
  // is the picture of somebody thoroughly out cold.
  const bruises = Math.max(0, number(nonLethal));
  return {
    current: now,
    total,
    temp: spare,
    nonLethal: bruises,
    currentPercent: (now / span) * 100,
    tempPercent: (spare / span) * 100,
    nonLethalPercent: Math.min(100, (bruises / span) * 100),
    /**
     * Whether the bruises have caught up with what is left standing.
     *
     * The rule the picture draws: grey reaching the red means the creature has
     * taken as much battering as it had hit points to absorb it, and goes down
     * without dying. Temporary points count towards holding it up, because they
     * are what a blow lands on first.
     */
    out: bruises > 0 && bruises >= now + spare,
  };
}
