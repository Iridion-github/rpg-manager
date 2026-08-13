// The ruler: what a distance across the board comes to, and how to say it.
//
// Kept apart from the tabletop for the usual reason - it is arithmetic, and
// arithmetic is the part worth being able to check without a browser. Nothing
// here knows about React, the socket or the map.
//
// Everything is in **cells**. Not pixels: the grid is the thing being counted,
// tokens are already stored in cells, and a measurement that travelled in
// pixels would mean something different to two people at different zooms. A
// point is `{ x, y }` in the same cell coordinates a token uses, so the centre
// of the cell at column 3, row 4 is `{ x: 3.5, y: 4.5 }`.

/**
 * The three units, and what one cell is worth in each by default.
 *
 * Feet at 5 and metres at 1.5 are the two scales D&D is written in - a 5-foot
 * square, and the metric conversion the translated books use, which is 1.5 and
 * not the 1.524 the arithmetic would give you. Cells at 1 is the identity: it
 * is the unit for a table that counts squares and doesn't care what they'd be
 * in the world.
 *
 * `perCell` is only the default. It is editable, because a map drawn at ten
 * feet to the square is a normal thing to be handed.
 */
export const UNITS = [
  { id: 'cells', name: 'Cells', suffix: 'cells', perCell: 1 },
  { id: 'feet', name: 'Feet', suffix: 'ft', perCell: 5 },
  { id: 'meters', name: 'Meters', suffix: 'm', perCell: 1.5 },
];

export const unitNamed = (id) => UNITS.find((u) => u.id === id) || UNITS[0];

/**
 * How many cells apart two points are.
 *
 * The 5e rule: a diagonal step costs exactly what a straight one does, so the
 * distance is the longer of the two spans rather than the hypotenuse. Three
 * across and two down is three cells, not 3.6 - which is why a fireball's range
 * reaches further on the diagonal than a tape measure says it should, and why
 * every table that plays 5e counts it this way.
 *
 * Points land on cell centres, so both spans are whole numbers and so is this.
 * It still does the right thing if they ever aren't.
 */
export const cellsBetween = (a, b) => Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));

/** The chain's legs, in cells: one number per segment, so n points give n-1. */
export const legsOf = (points = []) =>
  points.slice(1).map((point, i) => cellsBetween(points[i], point));

/** Everything walked, in cells. A chain of fewer than two points is zero. */
export const totalCells = (points = []) => legsOf(points).reduce((sum, leg) => sum + leg, 0);

/**
 * What a route *costs to walk*, which is not the same as how long it is.
 *
 * `cellsBetween` above is the rule for a distance: how far apart two things are,
 * which is what a spell's range or a bow shot is measured against. This is the
 * rule for a move, and 5e prices the two differently. It is the fix for the flat
 * rule's oddity, where a creature that walks in a zig-zag covers half again as
 * much ground as one that walks straight for the same money.
 *
 * The rule is about diagonals taken *in a row*, and it is the "in a row" that
 * does all the work here:
 *
 *   the first diagonal costs one cell;
 *   a second one immediately after it costs two;
 *   and that pays the debt off, so the next diagonal is back to one.
 *
 * Any straight step clears the slate. Diagonal, straight, diagonal, straight is
 * four steps and four cells, because no diagonal ever followed another.
 *
 * Which is why this walks the route one step at a time instead of counting
 * diagonals and multiplying. A leg is a straight line across the board, so it is
 * some number of diagonal steps and some number of straight ones, and *the order
 * they are taken in changes the price*. Five across and two down can be walked
 * as two diagonals then three straights, which pays the surcharge once, or by
 * spacing the two diagonals apart, which pays nothing. Both end on the same
 * square. Nobody at a table walks the expensive one on purpose, so this takes a
 * straight step whenever there is a diagonal waiting to be doubled and a
 * straight left to spend, and runs the diagonals together only when it has run
 * out of straights to separate them with.
 *
 * The debt carries across corners, because a corner is not a rest: two diagonal
 * legs meeting at a point are still two diagonal steps in a row.
 *
 * The answer is in cells, and a cell is five feet or a metre and a half like
 * everywhere else here - so a first diagonal reads 5 ft and a doubled one 10 ft.
 *
 * Returns the legs and their sum together, because the legs have to be walked in
 * order to be priced at all and doing it twice would be doing it twice.
 */
export function movementWalk(points = []) {
  const legs = [];
  let total = 0;
  // Whether a diagonal is standing unpaired, so the next one taken straight
  // after it is the one that costs double.
  let pending = false;

  for (let i = 1; i < points.length; i += 1) {
    // Points sit on cell centres, so both spans are whole numbers of cells and
    // these two counts are whole numbers of steps.
    const dx = Math.abs(points[i].x - points[i - 1].x);
    const dy = Math.abs(points[i].y - points[i - 1].y);
    // As many diagonals as the leg allows, with the overshoot walked straight.
    // Maximising diagonals is always right: a diagonal costs one cell, or two
    // at worst, and the two straight steps it replaces always cost two.
    let diagonals = Math.min(dx, dy);
    let straights = Math.abs(dx - dy);
    let cost = 0;

    while (diagonals > 0 || straights > 0) {
      // Spend a straight step when it buys something - either it breaks up a
      // pair that would otherwise cost double, or there are no diagonals left
      // to take anyway.
      if (straights > 0 && (pending || diagonals === 0)) {
        straights -= 1;
        cost += 1;
        pending = false;
      } else {
        diagonals -= 1;
        cost += pending ? 2 : 1;
        pending = !pending;
      }
    }

    legs.push(cost);
    total += cost;
  }

  return { legs, total };
}

/**
 * The two rules, behind one pair of names.
 *
 * Which one is in force is a checkbox in the measuring panel, and past this
 * point nothing else in the app has to know that: the map draws legs and totals
 * without asking what they were counted by. `movement` false is the flat 5e
 * count, which is what a range is measured in; true is the walking count above.
 */
export const legsBy = (points, movement) =>
  movement ? movementWalk(points).legs : legsOf(points);

export const totalBy = (points, movement) =>
  movement ? movementWalk(points).total : totalCells(points);

/**
 * Say a distance the way the panel is set to say it.
 *
 * Rounded to one decimal and then trimmed, so whole numbers read as "15 ft"
 * rather than "15.0 ft" - but a half cell at 1.5 metres to the square, which is
 * a real thing to measure, still reads as 0.8 rather than 1.
 */
export function formatDistance(cells, unit, perCell) {
  const { suffix } = unitNamed(unit);
  const value = cells * (Number.isFinite(perCell) ? perCell : unitNamed(unit).perCell);
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${suffix}`;
}

/**
 * Is this point one of the chain's own, and which?
 *
 * `within` is a radius in cells. Returns the index, or -1 - the right-click
 * menu asks this to tell "on a point" from "on the line between two", which are
 * two different offers.
 */
export function pointIndexAt(points = [], at, within) {
  let best = -1;
  let bestDist = within;
  points.forEach((p, i) => {
    // True distance here, not the 5e count: this is about what the hand landed
    // on, which is a question about the screen rather than about the board.
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/** How far `at` is from the segment a→b, in cells. */
function distanceToSegment(a, b, at) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  // A zero-length leg - two points in one cell - is just the point itself.
  if (lengthSq === 0) return Math.hypot(at.x - a.x, at.y - a.y);
  // How far along the segment the nearest spot is, clamped so a point beyond
  // either end measures to that end rather than to the infinite line.
  const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / lengthSq));
  return Math.hypot(at.x - (a.x + t * dx), at.y - (a.y + t * dy));
}

/** Is `at` on this measurement at all - a point of it, or a leg between two? */
export function touches(points = [], at, within) {
  if (pointIndexAt(points, at, within) >= 0) return true;
  for (let i = 1; i < points.length; i += 1) {
    if (distanceToSegment(points[i - 1], points[i], at) <= within) return true;
  }
  return false;
}

/**
 * Where a leg's label wants to sit: the middle of it, nudged clear of the line.
 *
 * Perpendicular to the leg rather than always above it, so a label never lies
 * along the line it is describing - which at a diagonal is what makes the two
 * unreadable together.
 */
export function labelSpot(a, b, offset = 0.35) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (!length) return { x: mx, y: my - offset };
  // The normal, always chosen to point upward on screen, so labels on the legs
  // of one chain don't flip from one side to the other as it doubles back.
  const nx = -dy / length;
  const ny = dx / length;
  const flip = ny > 0 ? -1 : 1;
  return { x: mx + nx * offset * flip, y: my + ny * offset * flip };
}

/**
 * The cell centre a click landed in.
 *
 * Points snap here rather than to the pointer, which is what makes every
 * distance a whole number of cells: with the 5e count the question is only ever
 * *which cell*, so the answer may as well be unambiguous. `+ 0.5` is the middle
 * of that cell in the coordinates tokens already use.
 */
export const cellCentre = (px, py) => ({
  x: Math.floor(px) + 0.5,
  y: Math.floor(py) + 0.5,
});
