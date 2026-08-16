// Fog of war, in the browser: how far each creature sees, and where that puts
// the edge of the dark.
//
// The same arithmetic the server keeps in server/fog.js, and it has to stay the
// same: the server decides which tokens a person is *sent*, and this decides
// what their screen is painted with. If the two drift apart the board shows a
// lit square with nothing standing in it, or a monster standing in the dark.
//
// Everything is in cells, like the ruler and like a token's position. Feet and
// metres are how the numbers are written down in the settings window, which is
// a property of the scene rather than of the creature - see the conversions at
// the bottom.

/** What a scene carries when nobody has ever opened the fog window on it. */
export const NO_FOG = { on: false, unit: 'feet', perCell: 5 };

export const fogOf = (scene) => ({ ...NO_FOG, ...(scene?.fog || {}) });

const field = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * What a token can see, in cells: `{ clear, dim }`, either of which may be
 * Infinity.
 *
 * Both blank means limitless perfect sight, which is what a row the DM never
 * filled in has to mean - arming the fog must not blind every creature nobody
 * has got round to describing. Past that, a blank field is "no limit on this
 * band": clear 30 with the far edge blank sees sharply to 30 feet and dimly for
 * ever after, and a far edge with no clear distance is a creature that never
 * sees anything sharply.
 */
export function visionOf(token = {}) {
  const clear = field(token.visionClear);
  const dim = field(token.visionDim);
  if (clear === null && dim === null) return { clear: Infinity, dim: Infinity };
  const far = dim === null ? Infinity : dim;
  return { clear: Math.min(clear === null ? 0 : clear, far), dim: far };
}

/** Whether a token has anything to say about sight at all. */
export const seesEverything = (token) => visionOf(token).dim === Infinity;

/**
 * The lit circles, in screen pixels, for one band of sight.
 *
 * `band` is 'clear' or 'dim'. Returns null when *any* of these eyes sees without
 * limit, which is the caller's cue to draw no darkness at all rather than a
 * circle the size of a continent.
 *
 * Centred on the middle of the token's own footprint, because that is where a
 * creature is, and radius in cells scaled to the screen - so the lit patch grows
 * and shrinks with the zoom, exactly like everything else drawn on the board.
 */
export function discsFor(eyes, band, { cellPx, offXPx, offYPx, positions = {} }) {
  const discs = [];
  for (const token of eyes) {
    const radius = visionOf(token)[band];
    if (!Number.isFinite(radius)) return null;
    const at = positions[token.id] || token;
    const size = token.size || 1;
    discs.push({
      cx: offXPx + (at.x + size / 2) * cellPx,
      cy: offYPx + (at.y + size / 2) * cellPx,
      // Never smaller than the creature itself. A character with no sight at
      // all still knows where it is standing, and a board that swallowed your
      // own token would be one you could not play from.
      r: Math.max(radius, size / 2) * cellPx,
    });
  }
  return discs;
}

/**
 * How far the edge of a lit circle is softened, as a fraction of its radius.
 *
 * Not for prettiness alone: a hard edge reads as a drawn line on the map, which
 * invites the eye to treat it as a wall. A gradient says "this is as far as I
 * can make out", which is what it is.
 */
const FEATHER = 0.12;

/**
 * A CSS mask that covers everything *except* these circles.
 *
 * One radial gradient per circle, each transparent inside its own circle and
 * opaque everywhere else, intersected - so a pixel survives only where every
 * gradient kept it, which is exactly "outside all of them". That is the union
 * of the holes, written the only way CSS can write a union.
 *
 * An empty list is a mask that hides nothing, which is what a person with no
 * eyes on the board gets: the layer covers the lot.
 */
export function maskOf(discs) {
  if (!discs?.length) return null;
  const layers = discs.map(
    (d) =>
      `radial-gradient(circle ${Math.round(d.r)}px at ${Math.round(d.cx)}px ${Math.round(d.cy)}px, ` +
      `transparent 0 ${Math.round(d.r * (1 - FEATHER))}px, #000 ${Math.round(d.r)}px)`
  );
  return {
    maskImage: layers.join(', '),
    WebkitMaskImage: layers.join(', '),
    maskComposite: 'intersect',
    WebkitMaskComposite: 'source-in',
  };
}

/**
 * The same sight, counted in squares: which whole cells a creature can see.
 *
 * On a board with a grid, sight is read off the grid like everything else on
 * it. A smooth circle is the truth about the distance and a bad answer to the
 * question anybody at the table is actually asking - "can I see that square?" -
 * because half a lit square is a square two people will read differently. So
 * the range stays a circle and what it *lights* is whole cells.
 *
 * A cell is lit when any part of it is within the radius. That is not an
 * arbitrary choice of rounding: it is exactly the rule the server uses to
 * decide whether a creature may be seen at all (the nearest point of its
 * footprint, in fog.js on the server), so a token that is sent to somebody is
 * always standing on a square their board has lit. Rounding the other way -
 * lighting a cell only when its centre is in range - would put creatures in the
 * dark that the server had already handed over.
 *
 * Rows rather than squares: for one eye the lit cells of a row are a single run,
 * so each row is one rectangle instead of fifteen. Runs from several creatures
 * are merged, which keeps the shape a *union* - overlapping holes cancel each
 * other out under the even-odd rule the mask is drawn with, and two players
 * standing together would punch a hole in their own light.
 *
 * Returns null when any of these eyes sees without limit, like discsFor.
 */
export function litCellsFor(eyes, band, { cellPx, offXPx, offYPx, positions = {}, bounds }) {
  // row index -> the column runs lit on it, as [from, to] inclusive
  const runs = new Map();
  for (const token of eyes) {
    const radius = visionOf(token)[band];
    if (!Number.isFinite(radius)) return null;
    const at = positions[token.id] || token;
    const size = token.size || 1;
    // The middle of the creature, and never a radius smaller than the creature
    // itself - the reasoning discsFor gives for the same clamp.
    const cx = at.x + size / 2;
    const cy = at.y + size / 2;
    const r = Math.max(radius, size / 2);

    const firstRow = Math.max(Math.ceil(cy - r - 1), bounds?.minRow ?? -Infinity);
    const lastRow = Math.min(Math.floor(cy + r), bounds?.maxRow ?? Infinity);
    for (let row = firstRow; row <= lastRow; row += 1) {
      // How far this row is from the eye, vertically: zero for the row it is
      // standing in, since that row's cells reach it.
      const dy = Math.max(row - cy, 0, cy - (row + 1));
      const span = r * r - dy * dy;
      if (span < 0) continue;
      const reach = Math.sqrt(span);
      const from = Math.max(Math.ceil(cx - reach - 1), bounds?.minCol ?? -Infinity);
      const to = Math.min(Math.floor(cx + reach), bounds?.maxCol ?? Infinity);
      if (to < from) continue;
      const found = runs.get(row);
      if (found) found.push([from, to]);
      else runs.set(row, [[from, to]]);
    }
  }

  const rects = [];
  for (const [row, spans] of runs) {
    spans.sort((a, b) => a[0] - b[0]);
    let [from, to] = spans[0];
    for (const [start, end] of spans.slice(1)) {
      // Touching counts as overlapping: two runs that meet at a column edge are
      // one rectangle, and leaving them as two would draw a seam of fog between
      // squares that are both lit.
      if (start <= to + 1) to = Math.max(to, end);
      else {
        rects.push(cellRect(from, to, row, { cellPx, offXPx, offYPx }));
        [from, to] = [start, end];
      }
    }
    rects.push(cellRect(from, to, row, { cellPx, offXPx, offYPx }));
  }
  return rects;
}

const cellRect = (from, to, row, { cellPx, offXPx, offYPx }) => ({
  x: Math.round(offXPx + from * cellPx),
  y: Math.round(offYPx + row * cellPx),
  w: Math.round((to - from + 1) * cellPx),
  h: Math.round(cellPx),
});

/**
 * A CSS mask that covers everything *except* these rectangles.
 *
 * One image rather than one gradient per hole: a lit area of two hundred
 * squares is a mask CSS gradients cannot write, and this is redrawn on every
 * frame of a drag. The trick is the even-odd fill rule - the page-sized
 * rectangle is filled, each lit rectangle inside it is a crossing, and a
 * crossing turns the fill off. Which is why the rectangles must not overlap;
 * see the merging in litCellsFor.
 */
export function maskOfRects(rects, width, height) {
  if (!rects?.length) return null;
  const w = Math.round(width);
  const h = Math.round(height);
  const holes = rects
    .map((r) => `M${r.x} ${r.y}H${r.x + r.w}V${r.y + r.h}H${r.x}Z`)
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<path fill="#fff" fill-rule="evenodd" d="M0 0H${w}V${h}H0Z${holes}"/></svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return {
    maskImage: url,
    WebkitMaskImage: url,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
  };
}

// --- writing distances down ---

/**
 * Cells to the unit the scene is written in, and back.
 *
 * Rounded to a tenth on the way out so a scale of 1.5 metres a cell doesn't put
 * six decimal places in a number field, and left alone on the way in.
 */
export const toUnit = (cells, perCell) =>
  cells === null || cells === undefined ? '' : Math.round(cells * perCell * 10) / 10;

export const toCells = (value, perCell) => {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / perCell) * 1000) / 1000;
};
