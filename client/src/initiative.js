/**
 * How initiative is ordered and how it reads.
 *
 * Shared because both places that show it - the turn tracker and the hover
 * tooltip - must say the same thing, and because the tie-break here has a
 * counterpart on the server (routes/scenes.js `byModifier`) that decides who
 * Next steps to. Three copies of one rule is two chances to disagree.
 */

/**
 * The tie-break: equal totals go to the bigger modifier.
 *
 * That's a fact about the creature rather than about the roll, which is exactly
 * what a tie needs. A token whose initiative was typed in as a bare total has
 * no modifier to compare and sorts below any that has one - it brought no
 * evidence to the contest.
 *
 * Compared rather than subtracted so that two unknowns come out equal instead
 * of NaN, which is what `-Infinity - -Infinity` gives and what would quietly
 * scramble the order around them.
 */
export function byModifier(a, b) {
  const of = (t) =>
    t.initiativeMod === null || t.initiativeMod === undefined ? -Infinity : t.initiativeMod;
  const ma = of(a);
  const mb = of(b);
  if (ma === mb) return 0;
  return mb > ma ? 1 : -1;
}

/** Everyone with an initiative, in the order they act. */
export function turnOrderOf(tokens) {
  return (tokens || [])
    .filter((t) => t.initiative !== null && t.initiative !== undefined)
    .sort((a, b) => b.initiative - a.initiative || byModifier(a, b));
}

/**
 * "25 (18+7)" - the total, and the roll it came from when that's known.
 *
 * The breakdown is what makes a tie readable: two creatures on 25 are in that
 * order for a reason, and this is where the reason shows. A negative modifier
 * prints as "18-1" rather than "18+-1".
 */
export function initiativeText(token) {
  const { initiative, initiativeDie: die, initiativeMod: mod } = token || {};
  const total = `${initiative}`;
  if (die === null || die === undefined || mod === null || mod === undefined) {
    return { total, breakdown: '' };
  }
  return { total, breakdown: `${die}${mod < 0 ? '' : '+'}${mod}` };
}
