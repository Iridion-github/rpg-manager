// The drawing layer's geometry, in one place.
//
// Shapes are stored in cells, like tokens, and drawn in map pixels - the SVG
// over the map carries a viewBox in map pixels, so one set of numbers works at
// every zoom and nothing here has to know what the zoom is. The only conversion
// is cells → map pixels, and it's the same one tokens make: the grid's own
// corner, plus so many cells of it.
//
// Four of the kinds are the ones every tabletop with a template tool settles on
// - a rectangle for a room, a circle for a burst, a cone for a breath weapon, a
// line for a lightning bolt - and they carry the same handful of numbers those
// tools do: a length, a direction, and how wide the cone opens.
//
// The fifth is the polygon, which is none of those: it is a list of corners,
// for the room that is not a box and the lake that is not a circle. It is drawn
// by clicking rather than dragging, and its corners are stored as offsets from
// its anchor so that everything which moves a shape by writing x and y - the
// drag, the undo of a drag - moves it without knowing what it is.

/** The tools, in the order they're offered. */
export const TOOLS = [
  {
    kind: 'rect',
    name: 'Rectangle',
    // Drawn as a box between two corners.
    hint: 'Drag from one corner to the other.',
  },
  {
    kind: 'circle',
    name: 'Circle',
    hint: 'Drag from the centre outwards - the radius follows the pointer.',
  },
  {
    kind: 'cone',
    name: 'Cone',
    hint: 'Drag from the point outwards. It opens towards the pointer.',
  },
  {
    kind: 'line',
    name: 'Line',
    hint: 'Drag from end to end. Its width is a slider.',
  },
  {
    kind: 'poly',
    name: 'Freehand polygon',
    // The only tool here that isn't a drag. See the note on `polygonFrom`.
    hint: 'Click each corner. Escape or the first corner again finishes it; right-click a corner to drop it.',
  },
];

export const toolNamed = (kind) => TOOLS.find((t) => t.kind === kind) || null;

/** What a new shape starts as, before the drag decides its size. */
export const DEFAULT_STYLE = {
  fill: '#58a6ff',
  stroke: '#9fb4ff',
  // Faint enough to read the map through, solid enough to see from across the
  // table. Every tabletop's template layer lands somewhere near a third.
  opacity: 35,
  strokeWidth: 2,
  // 53° is the angle a 5e cone template cuts, and what every VTT with a cone
  // tool defaults to.
  angle: 53,
  thickness: 1,
  label: '',
  // Drawing onto the squares rather than between them, which is what you want
  // whenever the map has a grid worth snapping to.
  snap: true,
};

// Which of the style fields each tool actually uses. The panel asks this rather
// than knowing it, so adding a tool doesn't mean editing the panel as well.
const TOOL_FIELDS = {
  rect: ['fill', 'stroke', 'opacity', 'strokeWidth', 'label', 'snap'],
  circle: ['fill', 'stroke', 'opacity', 'strokeWidth', 'label', 'snap'],
  cone: ['fill', 'stroke', 'opacity', 'strokeWidth', 'angle', 'label', 'snap'],
  line: ['fill', 'stroke', 'opacity', 'strokeWidth', 'thickness', 'label', 'snap'],
  // No size of its own: a polygon's shape *is* its corners, and there is no
  // number a slider could offer that would not be a worse way of saying where
  // one of them goes.
  poly: ['fill', 'stroke', 'opacity', 'strokeWidth', 'label', 'snap'],
};

export const usesField = (kind, field) => (TOOL_FIELDS[kind] || []).includes(field);

// The size fields a *drawn* shape offers for tuning afterwards, in the order
// they read best. Each is [field, label, min, max, step].
const TOOL_SIZES = {
  rect: [
    ['w', 'Width', 0.5, 60, 0.5],
    ['h', 'Height', 0.5, 60, 0.5],
    ['dir', 'Facing', 0, 359, 1],
  ],
  circle: [['r', 'Radius', 0.5, 60, 0.5]],
  cone: [
    ['r', 'Length', 0.5, 60, 0.5],
    ['angle', 'Spread', 5, 360, 1],
    ['dir', 'Facing', 0, 359, 1],
  ],
  line: [
    ['r', 'Length', 0.5, 60, 0.5],
    ['thickness', 'Width', 0.1, 10, 0.1],
    ['dir', 'Facing', 0, 359, 1],
  ],
};

export const sizeFields = (kind) => TOOL_SIZES[kind] || [];

const round2 = (v) => Math.round(v * 100) / 100;
const rad = (deg) => (deg * Math.PI) / 180;
const wrap = (deg) => ((deg % 360) + 360) % 360;

/** Turn a point about another, degrees clockwise (y runs down, as on screen). */
export function rotateAbout(p, c, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = rad(deg);
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Degrees from `c` to `p`, the same clockwise-from-east that `dir` speaks. */
export const angleTo = (c, p) => wrap((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);

export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * The point a shape turns about, in cells - and so where its centre mark goes.
 *
 * A rectangle turns about the middle of its box and a circle has nothing but a
 * middle, but a cone and a line turn about the point they come *out* of: that's
 * the mouth of the dragon and the caster's hand, and turning either of them
 * about their middle would swing that end away from where it belongs.
 */
export function shapePivot(shape) {
  if (shape.kind === 'rect') return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
  // A polygon's anchor is one of its corners, so the mark belongs in the middle
  // of what it covers rather than on the corner that happened to be clicked
  // first - which is often nowhere near the middle of anything.
  if (shape.kind === 'poly') return centroid(polygonPoints(shape));
  return { x: shape.x, y: shape.y };
}

/**
 * A map point in the shape's own frame - that is, with its turn undone.
 *
 * A rotated rectangle's edges aren't the box's edges any more, so every
 * question about them ("is this grab on the left side?") is asked here, where
 * they are again.
 */
export const localPoint = (shape, p) =>
  shape.kind === 'rect' && shape.dir ? rotateAbout(p, shapePivot(shape), -shape.dir) : p;

/**
 * Ink for the centre mark: whichever of black or white stands out furthest
 * from the fill it's drawn on.
 *
 * Judged by relative luminance rather than by hue, because that's what
 * contrast actually is - 0.179 is the point where black and white are equally
 * readable against a colour, so either side of it there's a clear winner. The
 * complement of a colour would be prettier and, for anything near mid-grey,
 * nearly invisible.
 */
export function contrastInk(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return '#ffffff';
  const n = parseInt(match[1], 16);
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

/**
 * The centre mark, in screen pixels - it's drawn inside a group scaled against
 * the zoom, so it stays this size however far in you are.
 *
 * The dot is 3px across, which is a mark rather than a blob: it's there to say
 * *where* the centre is, and a bigger one would cover the very spot it points
 * at. The turn around it is sized to that, close enough to read as one mark and
 * far enough out to clear the dot.
 */
export const TURN_R = 5.5;

/** Half a turn, drawn clockwise from the top of the mark to the bottom. */
export const turnArcPath = (r = TURN_R) => `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r}`;

/**
 * The head on the end of that arc. At the bottom of a clockwise turn the
 * travel is leftwards, so this points that way - which is the whole reason the
 * arc is there rather than a plain ring.
 */
export const turnHeadPath = (r = TURN_R) => `M -4 ${r} L 0.3 ${r - 2.6} L 0.3 ${r + 2.6} Z`;

/**
 * Which sides of a rectangle a grab took hold of, in the shape's own frame.
 *
 * `tol` is how close counts as "on the edge", in cells - the caller works it
 * out from the zoom, since what the hand was aiming at was a stroke a few
 * screen pixels wide. A grab that somehow lands on no side at all takes the
 * nearest one: the press already hit the outline, so doing nothing would be
 * the one wrong answer.
 */
export function edgesAt(shape, local, tol) {
  const left = shape.x;
  const right = shape.x + shape.w;
  const top = shape.y;
  const bottom = shape.y + shape.h;
  const held = {
    left: Math.abs(local.x - left) <= tol,
    right: Math.abs(local.x - right) <= tol,
    top: Math.abs(local.y - top) <= tol,
    bottom: Math.abs(local.y - bottom) <= tol,
  };
  if (!held.left && !held.right && !held.top && !held.bottom) {
    const near = [
      ['left', Math.abs(local.x - left)],
      ['right', Math.abs(local.x - right)],
      ['top', Math.abs(local.y - top)],
      ['bottom', Math.abs(local.y - bottom)],
    ].sort((a, b) => a[1] - b[1]);
    held[near[0][0]] = true;
  }
  return held;
}

// Nothing may be pulled smaller than this, or it becomes impossible to grab.
const MIN_SIDE = 0.2;

/**
 * The box a resize drag leaves behind, given the sides it's holding.
 *
 * The correction at the end is the part that isn't obvious. A rectangle turns
 * about the centre of its box, and moving one edge moves that centre - so
 * without putting the box back by the difference that shift makes, pulling one
 * side of a *rotated* rectangle would swing the opposite side away from where
 * you left it.
 */
export function resizeRect(shape, held, local, snapOn) {
  let left = shape.x;
  let right = shape.x + shape.w;
  let top = shape.y;
  let bottom = shape.y + shape.h;
  const at = { x: snapCell(local.x, snapOn), y: snapCell(local.y, snapOn) };
  if (held.left) left = Math.min(at.x, right - MIN_SIDE);
  if (held.right) right = Math.max(at.x, left + MIN_SIDE);
  if (held.top) top = Math.min(at.y, bottom - MIN_SIDE);
  if (held.bottom) bottom = Math.max(at.y, top + MIN_SIDE);

  const box = {
    x: round2(left),
    y: round2(top),
    w: round2(right - left),
    h: round2(bottom - top),
  };
  const dir = shape.dir || 0;
  if (!dir) return box;

  const was = shapePivot(shape);
  const now = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const drift = { x: now.x - was.x, y: now.y - was.y };
  const turned = rotateAbout(drift, { x: 0, y: 0 }, dir);
  return {
    ...box,
    x: round2(box.x + turned.x - drift.x),
    y: round2(box.y + turned.y - drift.y),
  };
}

/** Resizing anything that's measured from its middle: the radius follows. */
export const resizeRadius = (shape, point, snapOn) =>
  Math.max(0.1, snapCell(distance(shapePivot(shape), point), snapOn));

/**
 * Where a rotation drag has got to.
 *
 * Measured as "how far round from where you grabbed it", not "point at the
 * cursor", so the shape doesn't jump to meet the pointer the moment you touch
 * the mark. Snapping goes to fifteen degrees - a twenty-fourth of a turn, which
 * is fine enough to aim a cone and coarse enough to land on square.
 */
export function turnedTo(startDir, grabbedAt, nowAt, snapOn) {
  const dir = wrap(startDir + (nowAt - grabbedAt));
  return snapOn ? wrap(Math.round(dir / 15) * 15) : Math.round(dir);
}

/**
 * A point on the map, in cells, snapped or not.
 *
 * Snapping goes to the nearest half cell rather than the nearest whole one: a
 * circle centred on a cell *corner* is what a burst template wants, and one
 * centred in the middle of a square is what a creature standing there wants.
 * Halves give you both without a second toggle.
 */
export const snapCell = (value, on) => (on ? Math.round(value * 2) / 2 : round2(value));

/**
 * Build the shape a drag describes: where it started, where the pointer is now.
 *
 * `from` and `to` are in cells. Every kind reads the same two points - what
 * differs is what it makes of them, which is the whole of the difference
 * between these tools.
 */
export function shapeFromDrag(kind, from, to, style) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  // Degrees clockwise from east, which is how the stored `dir` reads.
  const dir = (((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360;

  if (kind === 'rect') {
    // Either corner may be the one you started from, so the box is the span
    // between them rather than a width and a height that could go negative.
    return {
      kind,
      x: round2(Math.min(from.x, to.x)),
      y: round2(Math.min(from.y, to.y)),
      w: Math.max(0.1, round2(Math.abs(dx))),
      h: Math.max(0.1, round2(Math.abs(dy))),
    };
  }
  if (kind === 'circle') {
    return { kind, x: round2(from.x), y: round2(from.y), r: Math.max(0.1, round2(length)) };
  }
  if (kind === 'cone') {
    return {
      kind,
      x: round2(from.x),
      y: round2(from.y),
      r: Math.max(0.1, round2(length)),
      dir: Math.round(dir),
      angle: style.angle,
    };
  }
  return {
    kind: 'line',
    x: round2(from.x),
    y: round2(from.y),
    r: Math.max(0.1, round2(length)),
    dir: Math.round(dir),
    thickness: style.thickness,
  };
}

/**
 * Build a polygon from the corners that were clicked, in cells.
 *
 * The first corner becomes the anchor and the rest are stored relative to it,
 * which is what lets a polygon be moved by the same drag that moves everything
 * else: `x` and `y` are the whole of where it sits, exactly as they are for a
 * rectangle. Absolute corners would have meant a second way of moving a shape,
 * and a second thing for undo to know about.
 */
export function polygonFrom(points) {
  const [first] = points;
  return {
    kind: 'poly',
    x: round2(first.x),
    y: round2(first.y),
    points: points.map((p) => ({ x: round2(p.x - first.x), y: round2(p.y - first.y) })),
  };
}

/** A polygon's corners in absolute cells, anchor included. */
export const polygonPoints = (shape) =>
  (shape.points || []).map((p) => ({ x: shape.x + p.x, y: shape.y + p.y }));

/** The middle of a set of points. Used for the label and the centre mark. */
export function centroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/**
 * Whether a gesture went far enough to have meant a shape at all.
 *
 * For a polygon that is three corners: two is a line drawn the long way round,
 * and one is a click on the map. Neither is a thing to leave on the board.
 */
export const isDrawn = (shape) => {
  if (shape.kind === 'poly') return (shape.points || []).length >= 3;
  return shape.kind === 'rect' ? shape.w > 0.15 && shape.h > 0.15 : shape.r > 0.15;
};

/**
 * The shape as SVG, in map pixels.
 *
 * `cell` is how many map pixels one cell spans and `origin` is where cell (0,0)
 * starts - the grid's own offset - so a shape sits on the squares it was drawn
 * on even after the grid has been slid across the picture.
 */
export function shapePath(shape, cell, origin = { x: 0, y: 0 }) {
  const px = (v) => v * cell;
  const cx = origin.x + px(shape.x);
  const cy = origin.y + px(shape.y);

  if (shape.kind === 'rect') {
    const w = px(shape.w);
    const h = px(shape.h);
    // Four corners rather than a run of h/v steps, because a rectangle can be
    // turned - and once it is, none of its sides is horizontal any more.
    const middle = { x: cx + w / 2, y: cy + h / 2 };
    const corners = [
      { x: cx, y: cy },
      { x: cx + w, y: cy },
      { x: cx + w, y: cy + h },
      { x: cx, y: cy + h },
    ].map((p) => rotateAbout(p, middle, shape.dir || 0));
    return `M ${corners.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
  }

  if (shape.kind === 'poly') {
    const corners = polygonPoints(shape).map((p) => ({
      x: origin.x + px(p.x),
      y: origin.y + px(p.y),
    }));
    if (!corners.length) return '';
    return `M ${corners.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
  }

  if (shape.kind === 'circle') {
    const r = px(shape.r);
    // Two arcs rather than a <circle>, so every kind is one <path> and the
    // renderer has one thing to draw instead of a switch over four.
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }

  if (shape.kind === 'cone') {
    const r = px(shape.r);
    const half = rad(shape.angle) / 2;
    const mid = rad(shape.dir);
    const ax = cx + r * Math.cos(mid - half);
    const ay = cy + r * Math.sin(mid - half);
    const bx = cx + r * Math.cos(mid + half);
    const by = cy + r * Math.sin(mid + half);
    // The arc's "large" flag has to follow the spread, or a cone wider than a
    // half turn would draw as the slice it isn't.
    const large = shape.angle > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${ax} ${ay} A ${r} ${r} 0 ${large} 1 ${bx} ${by} Z`;
  }

  // A line is a rectangle laid along its direction: it has a width, so it can
  // be filled and outlined like everything else here rather than being the one
  // kind that's a stroke.
  const r = px(shape.r);
  const half = px(shape.thickness) / 2;
  const a = rad(shape.dir);
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  // The normal to the direction, which is where the width goes.
  const nx = -uy * half;
  const ny = ux * half;
  const ex = cx + ux * r;
  const ey = cy + uy * r;
  return `M ${cx + nx} ${cy + ny} L ${ex + nx} ${ey + ny} L ${ex - nx} ${ey - ny} L ${cx - nx} ${cy - ny} Z`;
}

/** Where to hang a shape's label: the middle of what it covers. */
export function shapeAnchor(shape, cell, origin = { x: 0, y: 0 }) {
  const cx = origin.x + shape.x * cell;
  const cy = origin.y + shape.y * cell;
  if (shape.kind === 'rect') return { x: cx + (shape.w * cell) / 2, y: cy + (shape.h * cell) / 2 };
  if (shape.kind === 'circle') return { x: cx, y: cy };
  if (shape.kind === 'poly') {
    const mid = centroid(polygonPoints(shape));
    return { x: origin.x + mid.x * cell, y: origin.y + mid.y * cell };
  }
  // A cone or a line reads best from halfway along it rather than from the
  // point it comes out of, which is usually under a token.
  const a = rad(shape.dir);
  return { x: cx + Math.cos(a) * shape.r * cell * 0.5, y: cy + Math.sin(a) * shape.r * cell * 0.5 };
}

/** What the shape measures, for the readout while you draw it. */
export function shapeSize(shape) {
  const n = (v) => (Math.round(v * 10) / 10).toString();
  if (shape.kind === 'rect') return `${n(shape.w)} × ${n(shape.h)}`;
  if (shape.kind === 'circle') return `r ${n(shape.r)}`;
  if (shape.kind === 'cone') return `${n(shape.r)} · ${Math.round(shape.angle)}°`;
  if (shape.kind === 'poly') {
    const count = (shape.points || []).length;
    return `${count} ${count === 1 ? 'corner' : 'corners'}`;
  }
  return `${n(shape.r)} long`;
}
