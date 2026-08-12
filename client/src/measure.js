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
