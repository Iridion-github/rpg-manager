import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import TokenModal from './TokenModal.jsx';
import TokenTooltip from './TokenTooltip.jsx';
import InitiativeModal from './InitiativeModal.jsx';
import SpawnModal from './SpawnModal.jsx';
import PasteTokenModal from './PasteTokenModal.jsx';
import SceneManager from './SceneManager.jsx';
import ShapeTools from './ShapeTools.jsx';
import MeasureTools from './MeasureTools.jsx';
import PinIcon from './PinIcon.jsx';
import PinModal from './PinModal.jsx';
import PinWindow from './PinWindow.jsx';
import FogSettings from './FogSettings.jsx';
import { discsFor, fogOf, litCellsFor, maskOf, maskOfRects } from './fog.js';
import GridSettings from './GridSettings.jsx';
import {
  cellCentre,
  formatDistance,
  labelSpot,
  legsBy,
  pointIndexAt,
  totalBy,
  touches,
  unitNamed,
} from './measure.js';
import {
  DEFAULT_STYLE,
  angleTo,
  contrastInk,
  distance,
  edgesAt,
  isDrawn,
  polygonFrom,
  polygonPoints,
  localPoint,
  resizeRadius,
  resizeRect,
  shapeAnchor,
  shapeFromDrag,
  shapePath,
  shapePivot,
  shapeSize,
  snapCell,
  turnArcPath,
  turnHeadPath,
  turnedTo,
} from './shapes.js';
import { initiativeText, turnOrderOf } from './initiative.js';
import { canRedo, canUndo, forget, record, redo, subscribe, undo } from './history.js';
import {
  matches,
  pick,
  recordSceneEdit,
  recordShapeAdd,
  recordShapeDelete,
  recordShapeEdit,
  recordShapesCleared,
  recordTokenAdd,
  recordTokenBench,
  recordTokenDelete,
  recordTokenEdit,
  recordTokenMove,
  recordTokenPaste,
  recordTokenSpawn,
} from './sceneHistory.js';
import HpBar, { hpBar } from './HpBar.jsx';

// ~30 position updates a second is smooth to the eye and a fraction of the
// frames a pointer actually produces.
const DRAG_EMIT_MS = 33;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Where this browser remembers whether the map's tools panel is rolled up.
const TOOLS_MIN_KEY = 'rpg:map-tools-min';

// And what the drawing tools were last set to. A colour and an opacity are how
// *you* draw rather than anything about the table, so they live here beside the
// panel's fold - and reaching for the same tool twice in one evening shouldn't
// mean setting it up twice.
const SHAPE_STYLE_KEY = 'rpg:shape-style';

// How long a shape's sliders settle before the change is saved. The same
// bargain the grid slider makes: one write per adjustment, not per pixel.
const SHAPE_SAVE_MS = 400;

// How the ruler was last set up: the unit, the scale, how it is drawn and
// whether it counts a move or a distance. Which unit a table counts in is a
// fact about the campaign that doesn't change from one evening to the next, so
// having to say it again every time the box is opened would be a small tax on
// every use - and the same goes for the rest of it.
const MEASURE_KEY = 'rpg:measure-setup';

// Thick enough to find over a busy map, not so thick that the arrowhead stops
// being an arrowhead. Screen pixels, so the ruler reads the same at any zoom.
const MEASURE_THICK_MIN = 1;
const MEASURE_THICK_MAX = 12;

/**
 * How much board a nameplate needs, in cells.
 *
 * Not the plate's real height: that is fixed in pixels and so covers more of
 * the board the further you zoom out. This is the strip of *board* the plate is
 * treated as sitting over when deciding whether it lands on top of something,
 * and half a cell is the honest answer at the zooms anybody plays at.
 */
const PLATE_STRIP = 0.5;

/**
 * The mark on a token only the DM can see: an eye with a line through it.
 *
 * Drawn rather than written, and drawn as an SVG rather than set as an emoji:
 * there is no dependable character for a crossed-out eye, and the ones that
 * come close render as a different picture on every second machine. This is
 * two strokes and a circle, and it is the same shape at any zoom.
 *
 * It sits where the nameplate sits, and in front of the name when there is one,
 * because it qualifies everything else the plate says: what follows is a name
 * nobody else is reading.
 */
function HiddenEye() {
  return (
    <svg
      className="token-hidden-eye"
      viewBox="0 0 24 24"
      role="img"
      aria-label="Hidden from players"
    >
      <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3.2" />
      <line x1="3.5" y1="20.5" x2="20.5" y2="3.5" />
    </svg>
  );
}

/**
 * Which side of its token a nameplate sits on.
 *
 * Above and centred is the default, and it stays there unless there is a reason
 * to move: a caption that wandered from token to token as the board filled up
 * would be a caption nobody could find twice.
 *
 * The two reasons are the edge of the board and another token. A plate above
 * the top row hangs over nothing and can be scrolled out of reach; a plate on
 * top of the figure standing behind hides that figure, which is the thing the
 * map is for. Either sends it under the token instead - and if under is no
 * better, it goes back above, because it has to go somewhere and above is where
 * people will look for it.
 *
 * Positions are the live ones, drags included. A plate that dodged the square a
 * token has already left would be dodging nothing.
 */
function plateSide(token, pos, others, minRow, maxRow) {
  const size = token.size || 1;
  // Does anything stand on the strip whose top edge is here? Measured against
  // the token's own column, which is what "above it" means - a figure standing
  // diagonally back and to the left is not something the plate covers.
  const taken = (top) =>
    others.some((other) => {
      if (other.id === token.id) return false;
      const s = other.size || 1;
      return (
        other.x < pos.x + size &&
        other.x + s > pos.x &&
        other.y < top + PLATE_STRIP &&
        other.y + s > top
      );
    });

  // The board's own top and bottom, not zero and a count: on a nudged grid the
  // first row is a negative number - see minRow where it is worked out.
  if (pos.y - PLATE_STRIP < minRow) return 'below';
  if (!taken(pos.y - PLATE_STRIP)) return 'above';
  if (pos.y + size + PLATE_STRIP > maxRow + 1) return 'above';
  return taken(pos.y + size) ? 'above' : 'below';
}

/**
 * How much screen a pin takes up, and how much room its title needs.
 *
 * Screen pixels rather than map ones, because a pin does not scale with the
 * board: it is a marker *on* the picture, like a nameplate, and a pin that
 * shrank to nothing as you zoomed out would be a pin you could no longer find.
 * These four numbers are the same ones the stylesheet draws with, and they are
 * here because the code that decides which side the title goes on has to know
 * how much room the title takes.
 */
const PIN_PX = 30; // the head and its point, tip to top
const PIN_LABEL_PX = 20; // the title above or below it
// How near two pins have to be, side to side, for one's title to be in the
// other's way. Wider than a pin, because a title is wider than a pin.
const PIN_CLEAR_PX = 90;

/**
 * Which side of its pin the title sits on.
 *
 * Above by default, for the reason a nameplate is above its token: a caption
 * that wandered as the board filled up would be a caption nobody could find
 * twice. It moves for the two reasons a nameplate moves - the edge of the
 * board, and something else already there - and here the something else is
 * another pin's own head, which a title landing on top of would hide.
 *
 * Measured in screen pixels at the current zoom, since that is what both the
 * pin and the title are sized in.
 */
function pinLabelSide(pin, others, zoom) {
  const top = pin.y * zoom - (PIN_PX + PIN_LABEL_PX);
  if (top < 0) return 'below';
  const covered = others.some((other) => {
    if (other.id === pin.id) return false;
    if (Math.abs(other.x - pin.x) * zoom > PIN_CLEAR_PX) return false;
    const above = (pin.y - other.y) * zoom;
    return above > 0 && above < PIN_PX + PIN_LABEL_PX;
  });
  return covered ? 'below' : 'above';
}

// How near a right-click has to land, in cells, to be about a measurement
// rather than about the bare map - and, inside that, to be about one of its
// points rather than the line between two. The point radius is the smaller
// because it sits *on* the line: a hand aiming at the line near a point would
// otherwise always be told it meant the point.
const MEASURE_GRAB = 0.4;
const MEASURE_POINT_GRAB = 0.25;

// The same again, for a polygon's corners: how near a click has to land to be
// about the dot rather than about the map under it. Shared value, because they
// are the same gesture aimed at the same size of mark.
const POLY_CLOSE_GRAB = MEASURE_POINT_GRAB;

// How wide a shape's outline is to *grab*, in screen pixels, as against the one
// or two it may be drawn as. A border you have to hit exactly is a border you
// end up dragging the whole shape by, so the band that answers to the hand is
// far wider than the one the eye sees.
const GRIP_PX = 14;

// And how solid the turn tracker is. Like the panel's fold and the window's own
// box, this says nothing about the table - only how much of this screen its
// owner wants the map to have - so it lives in the browser, not the scene.
const TURNS_OPACITY_KEY = 'rpg:turns-opacity';

// The turn tracker holds a short list, not a character sheet, so it may be
// pulled far below the floor a FloatingWindow keeps by default. A constant
// rather than an inline object: a fresh one each render would be a new prop
// every time the map moves.
const TURNS_MIN = { w: 190, h: 120 };


/**
 * Pin cards sit in their own band, below the popped-out notes (402-440) and the
 * character sheets (40 up).
 *
 * A band each rather than one shared range, for the reason Notes.jsx gives at
 * the same spot: neither component can see the other's windows, so a shared
 * range would let two of them hold the same z with no way to bring the one
 * behind forward. Everything here stays under the map's right-click menu (450)
 * and the dialogs (500), so choosing Edit pin never opens a form behind the
 * card it was chosen on.
 */
const PIN_Z_BASE = 300;
const PIN_Z_CEILING = 340;

/**
 * Zoom bounds, shared by the slider and the wheel so the two can't disagree.
 *
 * The floor is 0.2 rather than the 0.4 it was: at 0.4 a large map still ran off
 * the screen, and the thing anybody actually wants from the far end of the
 * slider is the whole board at once - where the party is in the dungeon rather
 * than what is written on the door. Halving it halves the map's width and height
 * again, which is a quarter of the area and enough to hold any map this app can
 * be given.
 *
 * The ceiling is left where it is. Past 2 the picture is bigger than the picture
 * has detail for, and every map goes soft.
 */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
// Grid bounds, shared by its slider and the wheel for the same reason.
const GRID_MIN = 16;
const GRID_MAX = 240;
// Per wheel notch. The slider steps by one pixel, which is the precision you
// want when lining cells up to a drawn map but a long way to travel by wheel;
// four is fine enough to land on and coarse enough to cross the range.
const GRID_WHEEL_STEP = 4;

// Roughly one mouse-wheel notch. Trackpads emit many small deltas instead, so we
// accumulate and only step once this much has gone by - otherwise a light
// two-finger flick would rocket through the whole zoom range.
const WHEEL_NOTCH = 100;

// A right-click is a menu; a right-drag is a pan. Under this much travel the
// gesture is still a click - which is what lets "press, release, don't really
// move" open the menu instead of panning the map by three pixels and
// suppressing it. No pointer is perfectly still for the length of a click.
const PAN_SLOP = 5;

// How long a ping stays on screen: long enough for someone looking at their
// character sheet to glance up and still catch it.
const PING_MS = 2400;

// Roughly the menu's own size, used only to stop it opening past the edge of
// the window. Approximate on purpose - measuring it properly means rendering it
// somewhere invisible first, for a few pixels nobody will ever notice. Sized
// for the longest of the four menus, which is the map's own: seven items and a
// rule, once there is something on the bench to spawn and a pin to be made. The
// shorter ones open a little further from the bottom edge than they strictly
// need to, which nobody has ever complained about.
const MENU_W = 140;
const MENU_H = 206;

/**
 * One shape on the board: a fill, an outline, and its name if it was given one.
 *
 * Everything is measured in map pixels because the layer's viewBox is, so this
 * knows nothing about the zoom except for the two things that must *not* follow
 * it - the outline, which would thin to nothing zoomed out, and the lettering,
 * which is meant to be read rather than scaled.
 */
function ShapeMark({ shape, cell, origin, zoom, selected, sketching }) {
  const d = shapePath(shape, cell, origin);
  const at = shapeAnchor(shape, cell, origin);
  const caption = sketching ? shapeSize(shape) : shape.label;
  // The centre mark, in map pixels - where the shape turns about.
  const pivot = shapePivot(shape);
  const middle = { x: origin.x + pivot.x * cell, y: origin.y + pivot.y * cell };
  const ink = contrastInk(shape.fill);
  // A circle looks the same whichever way it faces, so it has no rotation at
  // all: no arrow promising a turn, and no handle to start one with - a grip
  // that quietly wrote a new facing nobody could see would still be a change,
  // a broadcast and an entry in everyone's undo. It keeps the dot, which says
  // where the burst is centred. Everything else can be pointed somewhere.
  // A polygon joins it: its corners are where they were clicked, and a facing
  // would have to turn them all about a centre nobody chose.
  const turnable = shape.kind !== 'circle' && shape.kind !== 'poly';

  return (
    <g
      className={`shape${selected ? ' selected' : ''}${sketching ? ' sketching' : ''}`}
      // What the press handler reads back to know which shape was hit. The one
      // being dragged out isn't one yet, and has nothing to be picked by.
      data-shape-id={sketching ? undefined : shape.id}
    >
      <path
        d={d}
        data-grip="move"
        fill={shape.fill}
        fillOpacity={(shape.opacity ?? 35) / 100}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
      {/* The outline again, unpainted and far thicker, purely as something for
          the hand to catch. Laid over the fill so that near an edge it's the
          edge you get, which is what "grab the border" has to mean. */}
      {!sketching && (
        <path
          className="shape-edge"
          data-grip="resize"
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={GRIP_PX}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* A second pass over the same outline rather than a box around it: a
          dashed ring on the shape itself says which one is selected without
          claiming a rectangle of map that isn't part of it. */}
      {selected && (
        <path className="shape-ring" d={d} fill="none" vectorEffect="non-scaling-stroke" />
      )}
      {caption && (
        <text x={at.x} y={at.y} fontSize={13 / zoom} vectorEffect="non-scaling-stroke">
          {caption}
        </text>
      )}
      {/* Scaled against the zoom so the mark is the same size on screen at any
          magnification - which is what lets everything inside it be written in
          plain pixels. Drawn last, so it's the mark you get when it overlaps
          anything else the shape offers. */}
      {!sketching && (
        <g className="shape-pivot" transform={`translate(${middle.x} ${middle.y}) scale(${1 / zoom})`}>
          {turnable && (
            <>
              <path className="shape-turn" d={turnArcPath()} stroke={ink} />
              <path className="shape-turn-head" d={turnHeadPath()} fill={ink} />
            </>
          )}
          {/* Three pixels across. A centre mark that covers the centre is no
              longer telling you where it is. */}
          <circle r="1.5" fill={ink} />
          {/* Far bigger than the mark it sits on, and invisible: what you aim
              at is the arrow, what catches you is a circle around the whole of
              it, because a three-pixel target is one nobody hits. */}
          {turnable && <circle className="shape-grab" data-grip="rotate" r="9" />}
        </g>
      )}
    </g>
  );
}

/**
 * A polygon part-way through being clicked out.
 *
 * Deliberately not a ShapeMark: that draws a shape, and this draws a decision
 * being made. The outline is left open at the end - the last corner is not
 * joined back to the first - because that is exactly what is true of it, and a
 * closed outline would say the thing was finished when a click is still owed.
 *
 * The corners are what the right-click menu is aimed at, so they are drawn at
 * the size a hand can find, scaled against the zoom like the ruler's own. The
 * whole layer is inert to the pointer; the hit-testing is done in cells by the
 * menu handler, for the reason given there.
 */
function PolygonSketch({ points, cell, origin, zoom, style }) {
  const at = (p) => ({ x: origin.x + p.x * cell, y: origin.y + p.y * cell });
  const screen = points.map(at);
  const scale = 1 / zoom;
  // Open, not closed: `M a L b L c` and no Z. With three corners or more the
  // fill still shows what is being enclosed, which is what you are judging.
  const d = `M ${screen.map((p) => `${p.x} ${p.y}`).join(' L ')}`;

  return (
    <g className="poly-sketch">
      <path
        d={points.length > 2 ? `${d} Z` : d}
        fill={points.length > 2 ? style.fill : 'none'}
        fillOpacity={((style.opacity ?? 35) / 100) * 0.6}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
      {screen.map((p, i) => (
        <circle
          key={i}
          // The first is the one that closes the polygon, so it is drawn a
          // little larger: it is a target as well as a corner.
          className={`poly-dot${i === 0 ? ' first' : ''}`}
          cx={p.x}
          cy={p.y}
          r={(i === 0 ? 4.5 : 3) * scale}
          strokeWidth={1.5 * scale}
        />
      ))}
    </g>
  );
}

/**
 * One leg of a measurement: a shaft, and a head on the end of it.
 *
 * The head is what makes a ruler readable as a route rather than as a shape
 * left on the map. It is drawn as a polygon rather than an SVG marker so it can
 * keep its size on screen: a marker inherits the stroke's units, and at half
 * zoom a marker-drawn head on a two-pixel line is a smudge. The shaft stops
 * short of the tip by the head's own length, so the two meet flush instead of
 * the line running out through the point.
 *
 * A leg going nowhere - the pointer still in the cell the last point was
 * dropped in - is drawn as nothing at all. There is no direction to point a
 * head in, and one pointing at an arbitrary angle would be the ruler guessing.
 */
function ArrowLeg({ from, to, width, head, className }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.01) return null;
  const ux = dx / length;
  const uy = dy / length;
  // Never longer than the leg itself, so a step into the next cell still shows
  // a head rather than one drawn back past where the leg began.
  const size = Math.min(head, length);
  const baseX = to.x - ux * size;
  const baseY = to.y - uy * size;
  // The head's half-width, across the line rather than along it.
  const nx = -uy * size * 0.42;
  const ny = ux * size * 0.42;
  return (
    <g className={className}>
      <line
        className="measure-shaft"
        x1={from.x}
        y1={from.y}
        x2={baseX}
        y2={baseY}
        strokeWidth={width}
      />
      <polygon
        className="measure-head"
        points={`${to.x},${to.y} ${baseX + nx},${baseY + ny} ${baseX - nx},${baseY - ny}`}
      />
    </g>
  );
}

// Fields that a Delete or a Ctrl+Z belongs to before it belongs to the map.
/**
 * One measured chain: the line, its points, and what each leg comes to.
 *
 * Drawn in cells and scaled into map pixels here, so the numbers it is handed
 * are the numbers that travel between clients. Everything that should keep its
 * size on screen - the stroke, the dots, the type - is divided by the zoom,
 * because the layer it sits in is scaled as a whole and a ruler whose lettering
 * grew with the map would be unreadable at both ends of the range.
 *
 * `pending` is the leg still following the pointer. It simply joins the chain
 * for as long as it is out there - drawn like the others but faded, and priced
 * like the others, since the number you are about to commit to is the one you
 * are actually reading. Under the movement count it could not be priced any
 * other way: a leg costs what it costs given the diagonals already spent, so it
 * has no figure of its own until it is on the end of the route.
 */
function MeasureMark({
  chain,
  cell,
  origin,
  zoom,
  color,
  thickness,
  unit,
  perCell,
  movement,
  pending,
}) {
  const at = (p) => ({ x: origin.x + p.x * cell, y: origin.y + p.y * cell });
  const scale = 1 / zoom;
  const width = thickness * scale;
  // Grown with the line rather than fixed, so a heavy ruler doesn't end in a
  // head the shaft is wider than.
  const head = (9 + thickness * 2.2) * scale;

  const walked = pending ? [...chain.points, pending] : chain.points;
  const legs = legsBy(walked, movement);
  const points = walked.map(at);
  // How many of those are the chain's own. The rest - at most one - is the
  // pointer, which is drawn but never dotted: it is not a point yet.
  const settled = chain.points.length;

  return (
    <g className="measure-mark" style={{ '--ink': color }}>
      {legs.map((_, i) => (
        <ArrowLeg
          key={`leg-${i}`}
          from={points[i]}
          to={points[i + 1]}
          width={width}
          head={head}
          className={pending && i === legs.length - 1 ? 'measure-pending' : undefined}
        />
      ))}

      {points.slice(0, settled).map((p, i) => (
        <circle
          key={i}
          className="measure-dot"
          cx={p.x}
          cy={p.y}
          r={(2 + thickness) * scale}
          strokeWidth={1.5 * scale}
        />
      ))}

      {/* One label per leg, beside the line rather than along it. A chain that
          doubles back would otherwise stack two numbers in the same place. */}
      {legs.map((leg, i) => {
        const px = at(labelSpot(walked[i], walked[i + 1]));
        return (
          <text
            key={`label-${i}`}
            className="measure-text"
            x={px.x}
            y={px.y}
            fontSize={13 * scale}
            strokeWidth={3 * scale}
          >
            {formatDistance(leg, unit, perCell)}
          </text>
        );
      })}

      {/* The chain's own running total, at its far end - the answer to "how far
          have I come", which for a route with a corner in it is not any of the
          leg numbers. Of the points settled on, like the panel's own total, so
          the two never disagree while the pointer is moving. Only once there is
          more than one leg to add up. */}
      {settled > 2 && (
        <text
          className="measure-text measure-sum"
          x={points[settled - 1].x}
          y={points[settled - 1].y - 12 * scale}
          fontSize={14 * scale}
          strokeWidth={3.5 * scale}
        >
          {formatDistance(totalBy(chain.points, movement), unit, perCell)}
        </text>
      )}
    </g>
  );
}

const TEXT_ENTRY = /^(|text|search|url|email|tel|password|number)$/;

/**
 * Whether a keystroke was aimed at something being *typed into*.
 *
 * Deliberately not "is the focus in a field of any kind". A press on the map
 * calls preventDefault - that's what stops a drag selecting text as it goes -
 * and a prevented press also stops the browser moving the focus. So the focus
 * stays on whatever was last touched in a panel, which after any use of the
 * drawing box is a slider or a colour well. Reading that as typing meant a
 * slider nobody was holding quietly swallowed every shortcut afterwards.
 *
 * A range, a checkbox and a colour well have no use for either key. A text box
 * has, and keeps them.
 */
function isTyping(target) {
  const el = target?.closest?.('textarea, [contenteditable], input');
  if (!el) return false;
  if (el.tagName !== 'INPUT') return true;
  return TEXT_ENTRY.test(el.getAttribute('type') || '');
}

const round1 = (v) => Math.round(v * 10) / 10;
// Free placement still gets rounded, just far more finely than to a cell -
// there's no sense storing a token position to fifteen decimal places.
const round2 = (v) => Math.round(v * 100) / 100;

// Mirrors SAME_SPOT in server/routes/scenes.js: how close counts as "the same
// place" once there's no grid to define one. If these two drift apart, the
// client's red outline stops predicting what the server will refuse.
const SAME_SPOT = 0.02;

// Ask the browser how big an image actually is. A scene stores the map's real
// pixel size so the grid can be retuned against it without the map resizing.
function imageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('That image could not be loaded.'));
    img.src = url;
  });
}

export default function Tabletop({ actor, players, offline }) {
  const [scenes, setScenes] = useState([]);
  const [maps, setMaps] = useState([]); // built-in maps from public/maps
  const [activeId, setActiveId] = useState('');
  const [zoom, setZoom] = useState(1);
  /**
   * The grid as the DM is currently tuning it, or null.
   *
   * Non-null means the Grid settings window is open, and this *is* that window:
   * there is no second flag, because a draft with nowhere to be edited and an
   * editor with nothing to edit are both states nobody wants to reason about.
   *
   * Everything in it is local. A grid being retuned passes through every wrong
   * answer on the way to the right one, and the rest of the table should not
   * have to watch that happen over the map they are playing on - so the scene
   * is not written until Save, and Cancel simply drops this.
   *
   * It also holds the offset, which is set by right-dragging the map rather
   * than by a control in the window. Same rule: drafted while open, saved with
   * everything else.
   */
  const [gridDraft, setGridDraft] = useState(null);
  // What the wheel drives is no longer a choice anybody makes: it is the zoom,
  // unless Grid settings is open, in which case it is the cell size. See the
  // wheel handler, which reads `gridDraft` for that.
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Where other people's tokens are *right now*, mid-drag. Never persisted.
  const [ghosts, setGhosts] = useState({});
  // Our own in-flight drag, so the token follows the pointer smoothly.
  const [drag, setDrag] = useState(null);
  // The right-click menu: where on screen to draw it, and the map point it was
  // opened on. Null when closed.
  const [menu, setMenu] = useState(null);
  // Pings currently pulsing. Ephemeral by nature - never persisted, and dropped
  // wholesale when the scene changes.
  const [pings, setPings] = useState([]);
  // The token form: either { x, y } for a new token at that spot, or { token }
  // for one being edited. Held here rather than in the modal because the menu
  // that decided it is closed by the time the modal opens - the choice has to
  // outlive the thing that made it.
  const [tokenForm, setTokenForm] = useState(null);
  // Every token of this campaign the viewer may touch: the DM's whole cast, or
  // your own. Each carries the scene it stands on, or null for one waiting to
  // be placed. Filtered by the server, so nothing here is unusable.
  const [roster, setRoster] = useState([]);
  // The campaign's character sheets, for tokens linked to one. See loadSheets.
  const [sheets, setSheets] = useState([]);
  // Where a token is about to be put back, in cells. Non-null means the picker
  // is open; the spot was decided by the right-click that opened it, exactly as
  // it is for a brand new token.
  const [spawnAt, setSpawnAt] = useState(null);
  /**
   * The token on this browser's clipboard, if any: a snapshot of what Copy
   * token was chosen on.
   *
   * Here rather than on the server, because "what did I copy" is a fact about
   * one person at one keyboard - two people at the same table copy different
   * things at the same time, and neither wants the other's. It survives pasting,
   * so a copied goblin can be laid out four times in four right-clicks, and it
   * is replaced when something else is copied. What it holds is a picture for
   * the confirmation dialog to show; the paste itself sends the id and lets the
   * server read the token as it actually stands.
   */
  // Whether the Scene Manager is open over the board. The DM's window, and the
  // only way in to everything that used to live along the top of the map.
  const [managing, setManaging] = useState(false);
  const [clipboard, setClipboard] = useState(null);
  // Where a copy is about to be pasted, in cells, once the dialog is answered.
  const [pasteAt, setPasteAt] = useState(null);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState('');
  // The token whose initiative is being set, if any.
  const [initiativeFor, setInitiativeFor] = useState(null);
  // The token the pointer is resting on, with the element to hang its tooltip
  // on. The element is kept rather than looked up again because the event that
  // told us about the hover is holding it already.
  const [hovered, setHovered] = useState(null);
  // Whether the tools panel is rolled up to its square. A local preference -
  // it says nothing about the table, only about how much of this screen its
  // owner wants the map to have - so it lives in this browser and is read back
  // on mount, since leaving the tab unmounts the map entirely.
  const [toolsMin, setToolsMin] = useState(() => localStorage.getItem(TOOLS_MIN_KEY) === '1');
  // The token whose row in the turn tracker the pointer is over, lit up on the
  // map so you can find it without reading names. Local to this screen: it says
  // where *you* are looking, which is nobody else's business.
  const [spotlight, setSpotlight] = useState(null);
  // What a confirmation dialog is currently asking about: { kind, id, name }.
  // One piece of state for both kinds, because only ever one of them is open.
  const [confirmDelete, setConfirmDelete] = useState(null);
  // How solid the turn tracker is, 10–100. Read back on mount because leaving
  // the tab unmounts the map, and a preference that forgot itself every time
  // you looked at your character sheet would not be much of one.
  const [turnsOpacity, setTurnsOpacity] = useState(() => {
    const saved = Number(localStorage.getItem(TURNS_OPACITY_KEY));
    // Clamped rather than rejected: a value saved under an older, lower floor
    // is still an answer to "how faint do you want this", and snapping someone
    // from a tenth to fully solid is a worse reading of it than 20%.
    return Number.isFinite(saved) && saved > 0 ? clamp(saved, OPACITY_MIN, 100) : 100;
  });

  const surfaceRef = useRef(null);
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const pannedRef = useRef(false);
  // The drawing drag in flight: either a new shape being pulled out, or one
  // being pushed around. A ref for the same reason the token drag is one -
  // pointer handlers must see the current values, not a render's idea of them.
  const drawRef = useRef(null);
  // Slider changes waiting to be written, and what the shape looked like before
  // the first of them - which is what Undo has to put back.
  const shapeEdit = useRef(null);
  const shapeTimer = useRef(null);
  const wheelAcc = useRef(0);
  const zoomAnchor = useRef(null);
  const pendingFocus = useRef(null);
  const pingTimers = useRef(new Set());
  const menuRef = useRef(null);
  // What the right button is doing to the map right now: 'pan' to move the
  // view, 'grid' to move the grid over it, null between gestures. One piece of
  // state rather than two flags, because it is only ever doing one of them.
  const [gesture, setGesture] = useState(null);
  // Bumped to force a render after a focus arrives, so the scroll is applied by
  // a layout effect that runs *after* the new zoom is on screen. Without it a
  // focus that doesn't change the zoom would re-render nothing and never scroll.
  const [focusTick, setFocusTick] = useState(0);
  // Whether there is anything of yours left to take back, or to put again. Held
  // as state rather than read at render because the stack is a plain module -
  // it changes without React being told, so it says so instead.
  const [history, setHistory] = useState(() => ({ undo: canUndo(), redo: canRedo() }));

  // --- the drawing layer ---
  // Whether the drawing box is open, and which tool it's holding. A tool in
  // hand *is* drawing mode: there is no third state where the box is open and
  // the map does nothing.
  const [shapeWindow, setShapeWindow] = useState(false);
  const [shapeTool, setShapeTool] = useState(null);
  // What the next shape will be drawn as. Read back from this browser, since a
  // colour is a habit rather than a fact about the table.
  const [shapeStyle, setShapeStyle] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SHAPE_STYLE_KEY) || 'null');
      // Spread over the defaults rather than trusted whole: a style saved by an
      // older version is missing whatever has been added since.
      return saved && typeof saved === 'object' ? { ...DEFAULT_STYLE, ...saved } : DEFAULT_STYLE;
    } catch {
      return DEFAULT_STYLE;
    }
  });
  // The shape the panel is pointing at, and the drag drawing one right now.
  const [selectedShapeId, setSelectedShapeId] = useState(null);
  /**
   * The polygon being clicked out, in absolute cells - or null.
   *
   * Every other shape is drawn by a drag, which begins and ends inside one
   * gesture and needs nothing kept between them. A polygon is a run of separate
   * clicks, so the corners so far have to live somewhere; this is that place.
   * Local until it is finished, exactly as a measurement is local: a half-drawn
   * outline broadcast corner by corner would put a shape on everybody's board
   * that its author had not decided on yet, and would write to the server once
   * per click.
   */
  const [polyPoints, setPolyPoints] = useState(null);
  const [sketch, setSketch] = useState(null);

  // --- the ruler ---
  /**
   * Measuring mode: the box being open, exactly as drawing mode is.
   *
   * Nothing it produces is saved and nothing it produces is a change to the
   * board. A measurement is a question somebody is asking out loud - "can I
   * reach him from here?" - and the answer stops being interesting the moment
   * it has been given, so it lives in this component's state and dies with it.
   */
  const [measureWindow, setMeasureWindow] = useState(false);
  /**
   * The ruler: the chains on the board and which one is still taking points.
   *
   * One piece of state holding both, because every change touches both - a
   * click that starts a chain also makes it the open one, and deleting the open
   * chain closes it. As two they could be updated out of step, and the code
   * that had to keep them in step would be every caller.
   *
   * Points are in cells: `{ id, points: [{ x, y }] }`, the same coordinates a
   * token stands on. Escape is what clears `openChainId`; see the key handler.
   */
  const [ruler, setRuler] = useState({ measurements: [], openChainId: null });
  /**
   * The same thing, readable *now*.
   *
   * Two clicks inside one frame - a double-click, or an impatient tap-tap - are
   * both handled before React has re-rendered, so both would read the same
   * stale state from their closure and the second would overwrite the first
   * rather than extend it. That cost a point every time somebody clicked
   * quickly. The ref is written synchronously, so each click sees the one
   * before it however fast they come.
   */
  const rulerRef = useRef(ruler);
  const { measurements, openChainId } = ruler;
  const applyRuler = useCallback((next) => {
    rulerRef.current = next;
    setRuler(next);
  }, []);
  // Where the pointer is, in cells, so the leg being drawn can follow it before
  // its far end has been decided. Null when the pointer is off the map.
  const [measureAt, setMeasureAt] = useState(null);
  /**
   * How the ruler is set up: what it counts in, what it counts by, and how it
   * is drawn. Remembered per browser - except for Shared, which is deliberately
   * not: showing the table your working is a decision about *this* measurement,
   * and one that silently persisted from a fortnight ago is one nobody made.
   *
   * `color: null` is not an absent colour but a deliberate one: it means "the
   * colour I am at this table", which is only known once the players have
   * loaded and is different in a different campaign. Choosing one writes it here
   * and it stays chosen; leaving it alone keeps your rulers the colour that says
   * they are yours on everybody else's screen. See rulerColor.
   */
  const [measureSetup, setMeasureSetup] = useState(() => {
    const fallback = { unit: 'cells', perCell: 1, color: null, thickness: 2, movement: false };
    try {
      const saved = JSON.parse(localStorage.getItem(MEASURE_KEY) || 'null');
      // Spread over the defaults rather than trusted whole, like the drawing
      // tools': a setup saved by an older version is missing whatever has been
      // added since, and half a setup is worse than none.
      return saved && typeof saved === 'object' ? { ...fallback, ...saved } : fallback;
    } catch {
      return fallback;
    }
  });
  const [measureShared, setMeasureShared] = useState(false);
  // Other people's shared rulers, keyed by whose they are. One each: a fresh
  // set from somebody replaces the last one they sent rather than joining it.
  const [remoteMeasures, setRemoteMeasures] = useState({});

  // --- pins ---
  /**
   * Whether pins are on screen at all.
   *
   * Off by default and off again next time the map is opened, exactly like the
   * drawing box and the ruler: a pin is something you go and look at, and a
   * board wearing every note anybody has ever stuck in it is a board you cannot
   * see. This is not a mode in the sense those two are - it takes nothing away
   * from the map, and you can play with the pins showing.
   */
  const [showPins, setShowPins] = useState(false);
  /**
   * Which pins *this person* has opened, oldest first.
   *
   * Local, and deliberately not shared with anybody. Opening a pin is reading
   * it, and reading is not a move: somebody else opening the same pin changes
   * nothing on your screen, which is exactly unlike a token. The order is the
   * order they were last reached for, which is what paints them in a sensible
   * stack.
   */
  const [openPinIds, setOpenPinIds] = useState([]);
  // The pin form: `{ at }` for a new pin at that point on the map, or `{ pin }`
  // for one being changed. Held here rather than in the modal for the reason
  // the token form is - the menu that decided it is closed by the time the
  // form opens, so the choice has to outlive it.
  const [pinForm, setPinForm] = useState(null);
  /**
   * Where the map's own top-left corner is on screen, or null.
   *
   * An open pin's card hangs over its pin, and a pin is at a point on a picture
   * that scrolls and zooms under the window. So the card's anchor has to be
   * worked out in viewport coordinates, which means knowing where the picture
   * currently is - measured, because scrolling moves it without changing
   * anything React knows about. Only measured while a card is open; see the
   * effect below.
   */
  const [surfaceBox, setSurfaceBox] = useState(null);
  /**
   * Moving pins mode: the map given over to putting pins where they belong.
   *
   * Its own mode rather than "drag a pin whenever it is showing", because the
   * ordinary press on a pin is how you *read* it, and a board where reading a
   * note sometimes nudged it three pixels off the doorway would be a board
   * nobody could trust. Entered from a pin's own right-click menu, left by
   * answering the bar it puts on screen, and while it is on the rest of the app
   * is held still - see the `pins-moving` class in the stylesheet.
   */
  const [movingPins, setMovingPins] = useState(false);
  /**
   * Where pins have been dragged *so far*, by id: `{ x, y }` in map pixels.
   *
   * Nothing here has been written. A pin being placed passes through every
   * wrong spot on the way to the right one, and the rest of the table should
   * not watch that happen over the map they are playing on - the same bargain
   * the grid draft makes. Confirm writes them; Cancel drops them.
   */
  const [pinMoves, setPinMoves] = useState({});
  /**
   * Undo and redo, for this sitting and nothing else.
   *
   * Deliberately not the app's own stack (history.js). Everything in that one
   * is a change the table has already seen, and a Ctrl+Z in here must not reach
   * past the pin you have just dragged to take back a token move from ten
   * minutes ago. Both stacks are dropped when the mode ends, whichever way it
   * ends - nothing in them survives to be reversed later, because by then the
   * moves are either saved or forgotten.
   */
  const [pinUndo, setPinUndo] = useState({ done: [], undone: [] });
  // Whether the moves are being written right now, so Confirm can't be pressed
  // twice and the bar can say what it is doing.
  const [savingPins, setSavingPins] = useState(false);
  // The pin drag in flight. A ref for the reason the token drag is one: the
  // pointer handlers must see the current values rather than a render's idea
  // of them.
  const pinDragRef = useRef(null);

  // --- fog of war ---
  // Whether the fog window is open. The DM's, and it says nothing about whether
  // the fog is *on*: the window is where that is decided, and it can be read
  // and edited with the lights either way.
  const [fogWindow, setFogWindow] = useState(false);
  /**
   * The token whose eyes the DM is borrowing, or null.
   *
   * Local to this screen and sent nowhere: looking through somebody's eyes
   * changes nothing about the board, and the table has no business knowing the
   * DM is checking what the wizard can see from the doorway.
   */
  const [povTokenId, setPovTokenId] = useState(null);

  const isDm = actor?.role === 'dm';
  /**
   * The scene the table is looking at: the one the DM has set for everybody.
   *
   * Null on a campaign where nobody has set one - every scene made before this
   * existed - and the first scene stands in, which is what those tables were
   * already seeing.
   */
  const tableScene = scenes.find((s) => s.selected) || null;
  /**
   * The scene on screen, which is not merely "the one whose id is selected".
   *
   * Two different questions, depending on who is asking. A player is shown the
   * table's scene and has no way to ask for another: the board is a thing the
   * table looks at together, and somebody who could wander off to the map of
   * the next dungeon would be reading the DM's prep. The DM has a picker, and it
   * is theirs alone - it moves their own screen and nobody else's, which is what
   * lets them set the next scene up while the table is still on this one.
   *
   * A DM's selection can stop resolving - they deleted that scene, or another DM
   * did. Falling back means an id pointing at nothing costs a selection rather
   * than the whole view: the alternative is rendering the empty state while
   * scenes plainly exist, and since the picker lives below that branch there'd
   * be no way back.
   */
  const rawScene =
    (isDm ? scenes.find((s) => s.id === activeId) : null) || tableScene || scenes[0] || null;
  // Everything downstream - the picker, the draft, the wheel handler - follows
  // what's actually shown, so the id and the view can't disagree.
  const selectedId = rawScene?.id || '';
  // Tokens are always an array from here on, whatever the server sent.
  const scene = rawScene ? { ...rawScene, tokens: rawScene.tokens || [] } : null;

  const canMove = useCallback(
    (token) => {
      if (offline) return false;
      if (isDm) return true;
      return actor?.role === 'player' && token.ownerId && token.ownerId === actor.userId;
    },
    [actor, isDm, offline]
  );

  const refresh = useCallback(async () => {
    try {
      const data = await api.listScenes();
      setScenes(data);
      // Where the DM's own picker starts: on the scene the table is looking at,
      // which is where they are looking too until they say otherwise.
      setActiveId((cur) =>
        data.some((s) => s.id === cur)
          ? cur
          : data.find((s) => s.selected)?.id || data[0]?.id || ''
      );
    } catch (e) {
      // Offline is handled by the shell; don't shout about it here.
      if (!offline) setError(e.message);
    }
  }, [offline]);

  /**
   * The campaign's cast, as this person may see it.
   *
   * Re-read whenever the board changes, because the two move together: a token
   * stops being placeable exactly when it arrives on a scene. A failure is
   * silent - the map is the point of this screen, and a list we couldn't read
   * is simply not offered.
   */
  const loadRoster = useCallback(async () => {
    if (offline) return;
    try {
      setRoster(await api.listCampaignTokens());
    } catch {
      /* the map still works without it */
    }
  }, [offline]);

  /**
   * The characters, for the attacks a linked token borrows from one.
   *
   * A token holding a character shows that character's attacks as well as its
   * own - in the hover bubble, and in its own edit form where they are listed
   * without being editable. Read from here rather than sent down with the
   * scene, because the scene is broadcast on every token drag and a copy of
   * every sheet riding along with it would be the wrong thing to make cheap.
   *
   * Permissions come for free: the endpoint only ever answers with the sheets
   * this person is allowed to open, so a player cannot learn what is on a sheet
   * by hovering the figure that holds it. Failures are swallowed - being unable
   * to read the characters costs the borrowed attacks, not the map.
   */
  const loadSheets = useCallback(async () => {
    if (offline) return;
    try {
      setSheets(await api.listSheets());
    } catch {
      setSheets([]);
    }
  }, [offline]);

  useEffect(() => {
    refresh();
    loadRoster();
    loadSheets();
    api.listMaps().then(setMaps).catch(() => setMaps([]));
  }, [refresh, loadRoster, loadSheets]);

  /**
   * The characters this person may put on a figure.
   *
   * The DM may link any of them; anybody else may link the ones they have been
   * given edit rights on. The same rule the Tokens tab uses, because it is the
   * same question - and the server asks it again on the way in, so this decides
   * what is offered rather than what is allowed.
   */
  const linkableSheets = useMemo(
    () => sheets.filter((x) => isDm || x.access?.[actor?.userId] === 'edit'),
    [sheets, isDm, actor?.userId]
  );

  /**
   * Those characters as the picker wants them, with what each is standing on.
   *
   * The note is said before the choice rather than after it: a character is on
   * one figure at a time, so picking one that is already somewhere takes it off
   * there, and that is worth knowing before you click rather than after.
   */
  const sheetOptionsFor = useCallback(
    (token) =>
      linkableSheets.map((x) => {
        const holder = roster.find((other) => other.sheetId === x.id && other.id !== token?.id);
        return {
          id: x.id,
          name: x.name || 'Unnamed',
          note: holder ? `currently ${holder.label}` : '',
        };
      }),
    [linkableSheets, roster]
  );

  /**
   * Couple a figure to a character, or uncouple it.
   *
   * One call: the route releases whatever else held that character, so moving
   * one from figure to figure has no moment in between where two of them claim
   * it. The board and the roster are both re-read afterwards, because the
   * coupling copies the character's hit points and initiative onto the figure
   * and this screen draws both.
   */
  const linkTokenSheet = useCallback(
    async (tokenId, sheetId) => {
      await api.linkTokenSheet(tokenId, sheetId);
      await Promise.all([refresh(), loadRoster()]);
    },
    [refresh, loadRoster]
  );

  /**
   * The character a token holds, or null - for nothing linked, for a link
   * pointing at a sheet that has since been deleted, and for a sheet this
   * person is not allowed to open, which arrives here as simply absent.
   */
  const sheetFor = useCallback(
    (token) => (token?.sheetId ? sheets.find((x) => x.id === token.sheetId) || null : null),
    [sheets]
  );

  // A character edited elsewhere changes what its figure can do, so the list is
  // kept fresh the same way everything else on this screen is.
  useEffect(() => {
    if (offline) return undefined;
    socket.on('sheets:changed', loadSheets);
    socket.on('connect', loadSheets);
    return () => {
      socket.off('sheets:changed', loadSheets);
      socket.off('connect', loadSheets);
    };
  }, [loadSheets, offline]);

  // --- undo and redo ---
  // The stack outlives this component - it's a module, so walking off to the
  // notes and back doesn't cost you your history - which is exactly why the
  // buttons have to be told when it changes.
  useEffect(() => subscribe(() => setHistory({ undo: canUndo(), redo: canRedo() })), []);

  /**
   * Take back your last action, or put it again.
   *
   * Whatever happens, the board is re-read afterwards. On success because the
   * server broadcast our own change back to everyone but us; on failure because
   * a failure usually means the board is already not what this client thought.
   */
  const runHistory = useCallback(
    async (direction) => {
      // Nothing here can be written while the server is unreachable, and the
      // shell already says as much.
      if (offline) return;
      if (!(direction === 'undo' ? canUndo() : canRedo())) return;
      setError('');
      try {
        const entry = direction === 'undo' ? await undo() : await redo();
        // Look at what moved. An undo that changes a scene you aren't watching
        // is otherwise a button that appears to do nothing at all.
        if (entry?.sceneId) setActiveId(entry.sceneId);
      } catch (e) {
        setError(e.message);
      } finally {
        refresh();
      }
    },
    [offline, refresh]
  );

  // A draft belongs to the scene it was made on, and so does a pulse on the
  // map. Changing scene therefore closes Grid settings rather than carrying a
  // half-tuned grid onto a different board.
  useEffect(() => {
    setGridDraft(null);
    setPings([]);
    setMenu(null);
    // A shape belongs to the scene it was drawn on, so a selection can't
    // survive a change of scene either. The tool stays in your hand: it's about
    // what you're doing, not about which board you're looking at.
    setSelectedShapeId(null);
    setSketch(null);
    // Same for an open pin's card, which is anchored to a spot on a map that is
    // no longer on screen. Whether pins are *shown* is like the tool in your
    // hand and stays as you left it.
    setOpenPinIds([]);
    setPinForm(null);
    // Borrowed eyes belong to a creature on the board you have just left.
    setPovTokenId(null);
  }, [selectedId]);

  // Pings outlive the component if nobody stops them: each one is a pending
  // timer holding a setState.
  useEffect(
    () => () => {
      for (const timer of pingTimers.current) clearTimeout(timer);
      pingTimers.current.clear();
    },
    []
  );

  // --- live updates ---
  useEffect(() => {
    const onSceneChange = ({ action, record, origin }) => {
      if (origin === clientId) return; // our own echo, already applied
      // Not every message on this channel carries a scene. A roster nudge names
      // a token or a sheet, and taking its id for a scene id put a nameless
      // entry in the scene list that nothing could open. `loadRoster` below is
      // what those are for.
      if (!record?.id || (action !== 'delete' && !Array.isArray(record.tokens))) return;
      setScenes((prev) => {
        if (action === 'delete') return prev.filter((s) => s.id !== record.id);
        const i = prev.findIndex((s) => s.id === record.id);
        if (i === -1) return [...prev, record];
        // Don't yank a token out from under our own drag.
        const dragging = dragRef.current?.tokenId;
        const incoming = dragging
          ? {
            ...record,
            tokens: (record.tokens || []).map((t) =>
              t.id === dragging ? (prev[i].tokens || []).find((p) => p.id === dragging) || t : t
            ),
          }
          : record;
        const next = prev.slice();
        next[i] = incoming;
        return next;
      });
    };

    const onDragging = ({ tokenId, x, y, by }) => {
      setGhosts((g) => ({ ...g, [tokenId]: { x, y, by } }));
    };
    const onDragEnded = ({ tokenId }) => {
      setGhosts((g) => {
        if (!(tokenId in g)) return g;
        const next = { ...g };
        delete next[tokenId];
        return next;
      });
    };

    socket.on('scenes:changed', onSceneChange);
    // A token leaving the bench is a token arriving on a scene, and the other
    // way about - so whatever moved the board may have moved the bench too.
    socket.on('scenes:changed', loadRoster);
    socket.on('token:dragging', onDragging);
    socket.on('token:drag:ended', onDragEnded);
    return () => {
      socket.off('scenes:changed', loadRoster);
      socket.off('scenes:changed', onSceneChange);
      socket.off('token:dragging', onDragging);
      socket.off('token:drag:ended', onDragEnded);
    };
  }, [loadRoster]);

  // --- pings and focus pulls ---
  // Both are ignored unless they're about the scene on screen: a pulse on a map
  // nobody here is reading, or a camera move for a place they can't see, is
  // motion with no meaning attached.
  useEffect(() => {
    const onPinged = ({ sceneId, x, y, color, by }) => {
      if (sceneId !== selectedId) return;
      const id = `${Date.now()}-${Math.random()}`;
      setPings((prev) => [...prev, { id, x, y, color, by }]);
      const timer = setTimeout(() => {
        pingTimers.current.delete(timer);
        setPings((prev) => prev.filter((p) => p.id !== id));
      }, PING_MS);
      pingTimers.current.add(timer);
    };

    const onFocused = ({ sceneId, x, y, zoom: level }) => {
      if (sceneId !== selectedId) return;
      // The scroll can't be set here: the zoom below changes the size of the
      // thing being scrolled, so the target only exists after layout. Leave the
      // point for the layout effect and bump the tick so there is a render for
      // it to run after, even when the zoom is already what we were sent.
      pendingFocus.current = { mx: x, my: y };
      setZoom(clamp(round1(level), ZOOM_MIN, ZOOM_MAX));
      setFocusTick((n) => n + 1);
    };

    socket.on('scene:pinged', onPinged);
    socket.on('scene:focused', onFocused);
    return () => {
      socket.off('scene:pinged', onPinged);
      socket.off('scene:focused', onFocused);
    };
  }, [selectedId]);

  // Reconnecting means we may have missed changes while away.
  useEffect(() => {
    const onConnect = () => {
      setGhosts({}); // any ghost we remember is stale now
      refresh();
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [refresh]);

  // --- geometry ---
  // The map keeps its own size; the grid is laid over it. So the surface is
  // sized from the image and only the *cell* size follows the grid slider -
  // sliding right makes cells bigger and therefore fewer, not the map larger.
  /**
   * The grid as it should be drawn *for this person, right now*.
   *
   * The scene's own settings, unless this is the DM with the Grid settings
   * window open - in which case it is their draft, and only theirs. One place
   * that decides, so no part of the map can end up measuring against a
   * different grid from the one on screen.
   */
  const sceneGrid = {
    gridSize: scene?.gridSize ?? 70,
    gridOffsetX: scene?.gridOffsetX ?? 0,
    gridOffsetY: scene?.gridOffsetY ?? 0,
    gridColor: scene?.gridColor ?? '#ffffff',
    gridOpacity: scene?.gridOpacity ?? 13,
    gridThickness: scene?.gridThickness ?? 1,
    gridContrast: scene?.gridContrast === true,
  };
  const grid = gridDraft ?? sceneGrid;
  const gridSize = grid.gridSize;
  // Absent means on, matching the server: scenes made before the toggle existed
  // had a grid.
  //
  // Deliberately *not* part of the draft. Show grid stays in the scene bar and
  // takes effect for everyone the moment it is pressed: it answers "is there a
  // grid", which the table needs to agree on, while the window answers "what
  // does it look like", which is the DM's to settle in private first.
  const gridOn = scene?.gridOn !== false;
  // Tuning the grid is the GM's, and only while they can write.
  const canTuneGrid = isDm && !offline;
  const mapW = scene?.width || 1200;
  const mapH = scene?.height || 840;
  const cellPx = gridSize * zoom;
  // Where cell (0,0) starts, in map pixels. Everything measured in cells -
  // the lines, the tokens, the square a pointer is over - is measured from
  // here, so moving it slides the whole grid across a map that stays put.
  const gridOffX = grid.gridOffsetX;
  const gridOffY = grid.gridOffsetY;
  // The same corner in screen pixels, which is what the layout wants.
  const offXPx = gridOffX * zoom;
  const offYPx = gridOffY * zoom;
  /**
   * The board's first and last square in each direction.
   *
   * Not `0` to `count - 1`, which is what these used to be, and the difference
   * is the whole of a bug that made the top row of some maps unusable.
   *
   * The grid is drawn by a repeating gradient positioned at the grid offset,
   * and a repeating pattern tiles *backwards* from its origin as readily as
   * forwards. So a map nudged down by a whole cell - which the offset allows,
   * and which looks identical to no nudge at all - still shows a line at the
   * very top of the map, and the row under it looks like every other row. In
   * cells that row is number -1, because cell 0 begins one cell lower down. It
   * could be seen and never used: every clamp stopped at zero.
   *
   * So the board is defined as what can actually be seen instead: a square
   * belongs to it when its *centre* is on the map. The centre rather than any
   * part of it, because a sliver one pixel wide along an edge is not somewhere
   * a token can stand, and counting it would put a column in the grid window
   * that nobody could use. This also settles the far edge, which had the
   * opposite fault: a nudged map offered a bottom row that had slid off it.
   *
   * On a map with no nudge that divides evenly into cells, these come to
   * exactly the numbers this used to work out.
   */
  const firstCell = (offset) => Math.round(-offset / gridSize);
  const lastCell = (span, offset) => Math.round((span - offset) / gridSize) - 1;
  const minCol = firstCell(gridOffX);
  const minRow = firstCell(gridOffY);
  const maxCol = Math.max(minCol, lastCell(mapW, gridOffX));
  const maxRow = Math.max(minRow, lastCell(mapH, gridOffY));
  // How many squares that comes to, which is what the grid window reports.
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;

  /**
   * Every token as it stands *this frame*: the stored board, with our own drag
   * and everybody else's laid over it.
   *
   * Built once rather than per token, since the nameplates ask about it once
   * each and would otherwise walk the same list a second time apiece. Only the
   * three fields the placement rule reads, so a drag - which carries a position
   * and nothing else - can be spread over a token without pretending to be one.
   */
  const tokensNow = (scene?.tokens || []).map((t) => {
    const at = (drag?.tokenId === t.id ? drag : ghosts[t.id]) || t;
    return { id: t.id, x: at.x, y: at.y, size: t.size };
  });

  // One token per cell. Footprints are rectangles because a token can be bigger
  // than one cell, so this mirrors the server's check - the server is still the
  // authority, this just avoids a doomed round trip and lets us warn mid-drag.
  const blockerAt = useCallback(
    (x, y, size, ignoreId) =>
      (scene?.tokens || []).find((t) => {
        if (t.id === ignoreId) return false;
        // Without a grid the only occupied position is one exactly taken;
        // with one, footprints may not overlap at all.
        if (!gridOn) return Math.abs(x - t.x) < SAME_SPOT && Math.abs(y - t.y) < SAME_SPOT;
        const ts = t.size || 1;
        return x < t.x + ts && t.x < x + size && y < t.y + ts && t.y < y + size;
      }) || null,
    [scene, gridOn]
  );

  // --- the drawing layer ---
  // Drawing is for the people playing: a spectator reads the board, and the
  // server would refuse them anyway. What you may do to a shape once it exists
  // is a separate question - see canEditShape below, which is the ownership
  // rule tokens already have.
  const canDraw = !offline && (isDm || actor?.role === 'player');
  /**
   * Drawing mode is the box being open, not a tool being held.
   *
   * Opening it is a change of mode: from then on the map answers to shapes
   * rather than to tokens, whether or not there's a tool in hand. You can pick
   * up what's already drawn, and every shape shows its centre mark - a mode you
   * have to arm by choosing a tool would be two steps to reach one state.
   * Picking a tool then adds the one thing this doesn't do on its own: pulling
   * a *new* shape out of the map.
   */
  const drawing = canDraw && shapeWindow;
  /**
   * What could be put on *this* board right now.
   *
   * Everything in the cast except what is already standing here. A creature can
   * be on several maps at once - the innkeeper in the square and in the tavern -
   * so standing somewhere else is no reason not to offer it; standing here is,
   * because a second figure of one creature on one map is two things the board
   * cannot tell apart. That is what copying is for.
   */
  const placeable = roster.filter(
    (t) => !(t.scenes || []).some((where) => where.id === selectedId)
  );
  const shapes = scene?.shapes || [];
  const selectedShape = shapes.find((s) => s.id === selectedShapeId) || null;
  // Yours if you drew it, anyone's if you're the DM - the rule the server keeps.
  const canEditShape = useCallback(
    (shape) =>
      Boolean(shape) &&
      !offline &&
      (isDm || (Boolean(shape.ownerId) && shape.ownerId === actor?.userId)),
    [isDm, offline, actor]
  );
  // The ones this person could clear: all of them for the DM, their own for
  // anyone else - the rule the server keeps, asked here so the button that
  // offers it can name a real number. Declared below canEditShape rather than
  // beside the list it filters, because that's the order it can be read in.
  const clearableShapes = shapes.filter((s) => canEditShape(s));

  // --- pins ---
  // Sticking one in is for the people playing, like drawing: a spectator reads
  // the board. What may be done to one afterwards is a different question, and
  // a stricter one - see canEditPin.
  const canPin = !offline && (isDm || actor?.role === 'player');
  /**
   * Every pin on this board that this browser was told about.
   *
   * Which is not every pin on it. A pin nobody has given you is filtered out by
   * the server on the way into the scene, so there is nothing here to hide and
   * nothing to be found by opening the dev tools. See canSeePin on the server.
   */
  const pins = scene?.pins || [];
  /**
   * Yours if you stuck it in, and nobody else's - not even the DM's.
   *
   * The one exception is a pin whose author has left the table, which the DM
   * inherits so that it can be taken down; the server keeps the same rule and
   * has the last word (canEditPin in campaigns.js). Here it only decides which
   * items a right-click offers.
   */
  const canEditPin = useCallback(
    (pin) => {
      if (!pin || offline) return false;
      if (pin.ownerId && pin.ownerId === actor?.userId) return true;
      const authorHere = Boolean(pin.ownerId) && players.some((p) => p.id === pin.ownerId);
      return isDm && !authorHere;
    },
    [actor, isDm, offline, players]
  );
  /**
   * Where a pin is *this frame*: where it has been dragged to, or where it is
   * stored. The one place that answers the question, so the head on the map,
   * the title beside it and the card hanging over it cannot end up in three
   * different places.
   */
  const pinSpot = useCallback(
    (pin) => pinMoves[pin.id] || { x: pin.x, y: pin.y },
    [pinMoves]
  );
  // The pins on this board that are yours to move. Also what decides whether
  // Move pins is offered at all: a mode in which nothing can be dragged is a
  // mode worth not offering.
  const movablePins = pins.filter((pin) => canEditPin(pin));
  // Every pin as it stands this frame, which is what the titles dodge each
  // other by. Built once rather than per pin, like tokensNow.
  const pinsNow = pins.map((pin) => ({ id: pin.id, ...pinSpot(pin) }));

  // --- fog of war ---
  const fog = fogOf(scene);
  const fogActive = fog.on === true;
  // The creature whose sight the DM is borrowing. Read from the live scene, so
  // a POV of a token somebody has just taken off the board falls away rather
  // than leaving the screen dark around a creature that isn't there.
  const povToken = povTokenId ? (scene?.tokens || []).find((t) => t.id === povTokenId) : null;
  /**
   * Whose eyes this screen is looking through, or null for "no fog here".
   *
   * Three answers. Borrowed eyes while the DM is in a token's point of view;
   * none at all for the DM otherwise, whose own board is never dimmed - they
   * are running the fight and need to see the room they are describing; and
   * your own creatures for everybody else, all of them at once, since a player
   * with a familiar out scouting sees through both.
   *
   * A player with nothing on the board gets an empty list, which is not the
   * same as null: it means the lights are out and they have no lantern.
   */
  const fogEyes = !fogActive
    ? null
    : povToken
      ? [povToken]
      : isDm
        ? null
        : (scene?.tokens || []).filter((t) => t.ownerId && t.ownerId === actor?.userId);
  /**
   * The two patches of light, as they stand this frame - ready to be worn by a
   * layer that covers everything else.
   *
   * Each band is one of three things. `null` is somebody who sees without limit:
   * no layer at all. An empty object is a layer with no mask, which covers the
   * board entirely - what somebody with nothing on it sees. Anything else is the
   * mask that cuts the light out of it.
   *
   * Shaped by the board rather than by the geometry: with a grid, sight is read
   * off the grid like everything else on it, and what a table wants to know is
   * whether it can see *that square*. Without one there are no squares to round
   * to and the circle is the honest answer. See litCellsFor.
   *
   * Positions come from tokensNow rather than from the stored tokens, so the
   * light travels with your own drag instead of waiting for the drop - which is
   * what makes walking into a dark room feel like walking rather than
   * teleporting.
   */
  const fogLight = (() => {
    if (!fogEyes) return null;
    const positions = Object.fromEntries(tokensNow.map((t) => [t.id, { x: t.x, y: t.y }]));
    const geometry = { cellPx, offXPx, offYPx, positions };
    const lit = (band) => {
      if (!gridOn) {
        const discs = discsFor(fogEyes, band, geometry);
        return discs === null ? null : maskOf(discs) || {};
      }
      const cells = litCellsFor(fogEyes, band, {
        ...geometry,
        // The board's own first and last squares, so a creature standing at the
        // edge doesn't light a mile of nothing beyond it.
        bounds: { minCol, maxCol, minRow, maxRow },
      });
      return cells === null ? null : maskOfRects(cells, mapW * zoom, mapH * zoom) || {};
    };
    return { clear: lit('clear'), dim: lit('dim') };
  })();

  // --- the ruler ---
  /**
   * Your own colour, on anything of yours that appears on somebody else's
   * screen - a ping, and now a shared ruler. It carries who it is from without
   * a name having to be read mid-combat.
   *
   * Declared up here rather than beside the ping that first needed it: the
   * measuring effects below send it, and a const used above its own line is a
   * crash rather than a warning.
   */
  const myColor = players.find((p) => p.id === actor?.userId)?.color || '#ffd479';

  /**
   * Measuring mode, and what it takes away from the map.
   *
   * While it's on, the board stops answering to hands: no token drags, no shape
   * grips, no menu on a token. That is the mode rather than a side effect of it
   * - a ruler is used *over* a board you are reading, and a click that measured
   * sometimes and dragged an ogre other times would be a ruler nobody trusted
   * near a crowded map. Everything is still visible, and still moves when
   * somebody else moves it; it just isn't yours to touch for the moment.
   */
  const measuring = measureWindow;
  const openChain = measurements.find((m) => m.id === openChainId) || null;
  // The legs of every chain added together. Total distance in the panel: it is
  // asked about a route, and a route is usually more than one leg. Each chain
  // is totalled on its own before they are added, because under the movement
  // count a chain is a route and two routes do not share their diagonals.
  const measuredCells = measurements.reduce(
    (sum, m) => sum + totalBy(m.points, measureSetup.movement),
    0
  );
  /**
   * What your own ruler is drawn in: your choice, or the colour you are at this
   * table until you make one.
   *
   * The default matters more than it looks. A shared ruler in the colour that
   * already names you in the chat and pips your tokens says whose it is without
   * anybody reading a label mid-combat, and that is worth keeping for the people
   * who never open the picker. Anyone who does open it has said something more
   * specific than the default was saying, so their choice wins from then on.
   */
  const rulerColor = measureSetup.color || myColor;
  // Somebody else's ruler, but only the ones about the board on screen - a line
  // measured on another map is a line drawn in another map's coordinates.
  const remoteRulers = Object.values(remoteMeasures).filter(
    (r) => r.sceneId === selectedId && r.measurements.length > 0
  );

  /**
   * The grid, borrowed rather than switched on.
   *
   * Measuring is counting cells, and counting what you cannot see is guessing.
   * But `gridOn` is a property of the *scene*: it is saved, it is the same for
   * everybody, and only the DM may change it - so a player entering this mode
   * could not turn it on, and a DM entering it would be turning it on for the
   * whole table and leaving it on afterwards.
   *
   * So the grid is drawn locally instead, for exactly as long as there is a
   * measurement to read against it, and for exactly the people who can see that
   * measurement: the measurer, and - when it's shared - everyone else. Nothing
   * is written, nothing is sent, and when the last ruler goes the grid goes back
   * to whatever the scene actually says.
   */
  const gridShown = gridOn || measuring || remoteRulers.length > 0;

  /**
   * Snapshot the ruler so an action can be taken back.
   *
   * Measuring actions go on the same undo stack as everything else, because
   * "Ctrl+Z takes back the last thing you did" is a promise about the last
   * thing you did, not about the last thing you did to the server. They're
   * tagged so leaving the mode can drop them - the measurements are gone by
   * then, and an entry that would put one back is a promise it can't keep.
   */
  const recordMeasure = useCallback(
    (label, before, after) => {
      record({
        kind: 'measure',
        label,
        sceneId: selectedId,
        undo: async () => applyRuler(before),
        redo: async () => applyRuler(after),
      });
    },
    [selectedId, applyRuler]
  );

  /**
   * The one way the ruler changes, so every change is undoable by construction
   * rather than by each caller remembering to write an entry.
   *
   * `next` is handed the current state and returns the next one, or null to
   * mean "nothing to do". Read from the ref rather than from this render, so a
   * second click arriving in the same frame builds on the first - and written
   * outside a state updater, since recording history inside one would write the
   * entry twice the first time React chose to call it twice.
   */
  function changeMeasure(label, next) {
    const before = rulerRef.current;
    const after = next(before);
    if (!after) return;
    applyRuler(after);
    recordMeasure(label, before, after);
  }

  // A tool put down, or the box closed, leaves nothing selected: the panel is
  // what the selection was for.
  useEffect(() => {
    if (!drawing) setSelectedShapeId(null);
  }, [drawing]);

  useEffect(() => {
    try {
      localStorage.setItem(SHAPE_STYLE_KEY, JSON.stringify(shapeStyle));
    } catch {
      // Private mode, or a full quota. It still draws; it just won't remember.
    }
  }, [shapeStyle]);

  useEffect(() => {
    try {
      localStorage.setItem(MEASURE_KEY, JSON.stringify(measureSetup));
    } catch {
      // Same bargain: it still measures, it just won't remember how.
    }
  }, [measureSetup]);

  /**
   * Leaving measuring mode takes the measurements with it.
   *
   * Said in the panel, and true: they are not saved anywhere, so there is no
   * version of this where closing the box and reopening it finds them again.
   * The undo entries go at the same moment - an entry that would put back a
   * ruler in a mode that is switched off is a promise the stack can't keep, and
   * Ctrl+Z reaching past a token move to redraw one would be baffling.
   */
  useEffect(() => {
    if (measuring) return;
    applyRuler({ measurements: [], openChainId: null });
    setMeasureAt(null);
    forget((entry) => entry.kind === 'measure');
  }, [measuring, applyRuler]);

  // A measurement is in the cells of the map it was drawn on, so it can no more
  // survive a change of scene than a shape selection can.
  useEffect(() => {
    applyRuler({ measurements: [], openChainId: null });
    setMeasureAt(null);
    setRemoteMeasures({});
    forget((entry) => entry.kind === 'measure');
  }, [selectedId, applyRuler]);

  /**
   * Show the table what you're measuring, or stop showing them.
   *
   * The whole set goes on every change rather than the change itself - see the
   * note on the server side. It is at most a few dozen numbers, and a stream of
   * states cannot get out of order in a way that leaves a line on somebody's
   * screen that was never on yours.
   *
   * Unsharing sends the empty set rather than merely stopping: silence would
   * leave the last thing sent standing on every other screen forever.
   */
  useEffect(() => {
    if (!selectedId) return undefined;
    if (!measuring || !measureShared || offline) {
      socket.emit('scene:measure:end');
      return undefined;
    }
    socket.emit('scene:measure', {
      sceneId: selectedId,
      measurements: measurements.map((m) => ({ id: m.id, points: m.points })),
      unit: measureSetup.unit,
      perCell: measureSetup.perCell,
      // All four travel for one reason: a shared ruler should read on every
      // screen the way it reads on its author's. The scale and the counting
      // rule because otherwise the same line makes two different claims, and
      // the colour and thickness because a ruler somebody deliberately drew
      // thick and red is one they are pointing at.
      movement: measureSetup.movement,
      color: rulerColor,
      thickness: measureSetup.thickness,
    });
    // On the way out too: closing the tab, walking off to the notes tab, or
    // switching scenes all have to take the ruler off other people's boards.
    return () => socket.emit('scene:measure:end');
  }, [measuring, measureShared, offline, selectedId, measurements, measureSetup, rulerColor]);

  // Somebody else's ruler arriving. Keyed by whose it is, so a new set from one
  // person replaces theirs and leaves everybody else's alone - and an empty set
  // is how a ruler is taken down, which the same line handles.
  useEffect(() => {
    const onMeasured = ({
      sceneId,
      userId,
      by,
      measurements: theirs,
      unit,
      perCell,
      movement,
      color,
      thickness,
    }) => {
      if (!userId) return;
      setRemoteMeasures((prev) => {
        if (!theirs?.length) {
          if (!prev[userId]) return prev;
          const { [userId]: gone, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [userId]: { sceneId, by, measurements: theirs, unit, perCell, movement, color, thickness },
        };
      });
    };
    socket.on('scene:measured', onMeasured);
    return () => socket.off('scene:measured', onMeasured);
  }, []);

  useEffect(() => () => clearTimeout(shapeTimer.current), []);

  // The rubbing-out, as of this render. The Delete key binds once per selection
  // and would otherwise hold whatever the board looked like at that moment.
  const eraseRef = useRef(null);
  useEffect(() => {
    eraseRef.current = eraseShape;
  });

  // --- dragging ---

  function pointerCell(e) {
    const rect = surfaceRef.current.getBoundingClientRect();
    return {
      px: (e.clientX - rect.left - offXPx) / cellPx,
      py: (e.clientY - rect.top - offYPx) / cellPx,
    };
  }

  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    socket.emit('token:drag:end');
  }

  // --- drawing ---
  // The look a new shape is drawn with, which is the style minus the two things
  // in it that are about *drawing* rather than about a shape.
  const shapeLook = () => ({
    fill: shapeStyle.fill,
    stroke: shapeStyle.stroke,
    opacity: shapeStyle.opacity,
    strokeWidth: shapeStyle.strokeWidth,
    label: shapeStyle.label,
  });

  // Snapping is only ever on when there are squares to snap to.
  const snapping = shapeStyle.snap && gridOn;

  // Where the pointer is on the board, in cells - on the squares if that's what
  // was asked for.
  function drawPoint(e) {
    const { px, py } = pointerCell(e);
    return { x: snapCell(px, snapping), y: snapCell(py, snapping) };
  }

  // The same, untouched. Turning and stretching do their own rounding - of an
  // angle, or of the far edge - and snapping the pointer first would round the
  // measurement twice, each time to a different thing.
  function rawPoint(e) {
    const { px, py } = pointerCell(e);
    return { x: px, y: py };
  }

  /**
   * A press on the board.
   *
   * Three things can be taken hold of on a shape and they're told apart by
   * where the hand landed rather than by a mode picked in advance: the middle
   * of it moves, the outline stretches, the mark at its centre turns it. That's
   * how every drawing tool worth using behaves, and it means the panel never
   * has to carry a row of "now do this instead" buttons.
   */
  /**
   * A click while measuring: drop a point in the middle of the cell it landed
   * in, extending the open chain or starting one.
   *
   * Cell centres rather than the pointer, so every distance is a whole number
   * of cells. With the 5e count the only question a leg asks is *which cell*,
   * and a point sitting three pixels inside a boundary would make the answer
   * depend on the hand rather than on the board.
   */
  function addMeasurePoint(e) {
    const { px, py } = pointerCell(e);
    const at = cellCentre(px, py);
    changeMeasure('measure', ({ measurements: was, openChainId: open }) => {
      const chain = was.find((m) => m.id === open);
      if (!chain) {
        const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return { measurements: [...was, { id, points: [at] }], openChainId: id };
      }
      return {
        measurements: was.map((m) => (m.id === open ? { ...m, points: [...m.points, at] } : m)),
        openChainId: open,
      };
    });
  }

  function onDrawStart(e) {
    // Measuring takes the map over entirely: a left-click is a point and
    // nothing else can be picked up. Before the drawing check, because the two
    // modes are mutually exclusive and this is the one that's on.
    if (measuring) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.focus?.({ preventScroll: true });
      addMeasurePoint(e);
      return;
    }
    if (!drawing || e.button !== 0) return;
    const hit = e.target?.closest?.('[data-shape-id]')?.dataset.shapeId;
    e.preventDefault();
    // A press on the map is the map taking the keyboard. The preventDefault
    // above is what stops the browser doing this itself, so without it the
    // focus stays wherever the panel left it - and after typing a label,
    // Delete would go on belonging to that text field rather than to the shape
    // you have just picked up. Without the scroll, because moving the view is
    // the one thing a press on the map must never do by itself.
    e.currentTarget.focus?.({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);

    if (hit) {
      const shape = shapes.find((s) => s.id === hit);
      setSelectedShapeId(hit);
      // Somebody else's shape can be pointed at but not pushed around. The
      // selection is still worth making: it's what tells you whose it is.
      if (!canEditShape(shape)) return;
      // A polygon has neither a box nor a radius, so there is nothing for a
      // stretch to write: grabbing its edge picks it up instead. Better than a
      // grip that quietly set an `r` nothing draws.
      const grabbed = e.target?.closest?.('[data-grip]')?.dataset.grip || 'move';
      const grip = shape?.kind === 'poly' && grabbed === 'resize' ? 'move' : grabbed;
      const raw = rawPoint(e);
      const base = { ...shape };

      if (grip === 'rotate') {
        const pivot = shapePivot(shape);
        drawRef.current = {
          mode: 'rotate',
          id: hit,
          base,
          shape: base,
          pivot,
          // Where the hand took hold, so the shape turns *with* it rather than
          // snapping round to point at it the instant it's touched.
          grabbedAt: angleTo(pivot, raw),
        };
        return;
      }

      if (grip === 'resize') {
        drawRef.current = {
          mode: 'resize',
          id: hit,
          base,
          shape: base,
          // Which sides, for a rectangle. The tolerance is the hit stroke's own
          // width in cells - what the hand was aiming at was a band of screen
          // pixels, and this is that band said in the shape's units.
          held:
            shape.kind === 'rect'
              ? edgesAt(shape, localPoint(shape, raw), GRIP_PX / 2 / cellPx)
              : null,
        };
        return;
      }

      const at = drawPoint(e);
      drawRef.current = {
        mode: 'move',
        id: hit,
        base,
        shape: base,
        // Where inside the shape it was taken hold of, so it doesn't jump.
        grabX: at.x - shape.x,
        grabY: at.y - shape.y,
      };
      return;
    }

    // A press on bare map puts down whatever was held. With no tool chosen
    // that's all it does: in drawing mode without one, the map is a board you
    // rearrange rather than one you draw on.
    setSelectedShapeId(null);
    if (!shapeTool) return;

    /**
     * The polygon is clicked out rather than dragged, so its press does the
     * whole of the work and there is no gesture left to hand to the move
     * handler below.
     *
     * Landing on the first corner closes it, which is the gesture every
     * drawing program uses for this and the one people try first. Escape
     * finishes it too - see the key handler - because a polygon you meant to
     * leave open-ended should not have to be walked back to its own start.
     */
    if (shapeTool === 'poly') {
      const at = drawPoint(e);
      const open = polyPoints || [];
      if (open.length >= 3 && closesPolygon(open, at)) {
        finishPolygon(open);
        return;
      }
      setPolyPoints([...open, at]);
      return;
    }

    const at = drawPoint(e);
    const started = { ...shapeFromDrag(shapeTool, at, at, shapeStyle), ...shapeLook() };
    drawRef.current = { mode: 'draw', from: at, shape: started };
    setSketch(started);
  }

  // Returns whether it took the event, so the token drag below can have it
  // otherwise. Only ever one of the two is in flight.
  // Returns whether it took the event, so the token drag below can have it
  // otherwise. Only ever one of the two is in flight.
  function onDrawMove(e) {
    const d = drawRef.current;
    if (!d) return false;

    if (d.mode === 'draw') {
      d.shape = { ...shapeFromDrag(shapeTool, d.from, drawPoint(e), shapeStyle), ...shapeLook() };
    } else if (d.mode === 'rotate') {
      d.shape = {
        ...d.base,
        dir: turnedTo(d.base.dir || 0, d.grabbedAt, angleTo(d.pivot, rawPoint(e)), snapping),
      };
    } else if (d.mode === 'resize') {
      // Always measured from the shape as it was when the drag began, never
      // from the last frame: reading a stretch off its own output would let a
      // rounding of half a pixel walk the edge across the map.
      const raw = rawPoint(e);
      d.shape =
        d.base.kind === 'rect'
          ? { ...d.base, ...resizeRect(d.base, d.held, localPoint(d.base, raw), snapping) }
          : { ...d.base, r: resizeRadius(d.base, raw, snapping) };
    } else {
      const at = drawPoint(e);
      // Carrying the whole shape rather than just its corner: the sketch is
      // what gets drawn while the hand is down, so it has to look like itself.
      d.shape = { ...d.base, x: round2(at.x - d.grabX), y: round2(at.y - d.grabY) };
    }

    setSketch(d.shape);
    return true;
  }

  // Everything a gesture can change about a shape it already had. One list, so
  // moving, stretching and turning all end the same way and only ever write the
  // numbers they actually moved.
  const GEOMETRY = ['x', 'y', 'w', 'h', 'r', 'dir'];

  function onDrawEnd() {
    const d = drawRef.current;
    if (!d) return false;
    drawRef.current = null;
    setSketch(null);
    // The geometry off the gesture, not off the sketch state: a release can
    // arrive before the render that last drew it.
    const drawn = d.shape;
    if (d.mode === 'draw') {
      // A click that never became a drag isn't a shape. It has already done its
      // other job, which was to clear the selection.
      if (drawn && isDrawn(drawn)) createShape(drawn);
      return true;
    }
    const changes = {};
    for (const key of GEOMETRY) {
      if (drawn[key] !== d.base[key]) changes[key] = drawn[key];
    }
    if (Object.keys(changes).length) editShape(d.id, changes);
    return true;
  }

  /**
   * Whether a click landed back on the corner the polygon started from.
   *
   * In cells, and generously: the dot is a few pixels of screen and the hand is
   * aiming at it rather than at the cell it sits in. The same tolerance the
   * ruler uses for grabbing one of its own points, for the same reason.
   */
  const closesPolygon = (points, at) =>
    points.length > 0 && distance(points[0], at) <= POLY_CLOSE_GRAB;

  /**
   * Put the finished polygon on the board, or throw it away.
   *
   * Fewer than three corners is not a shape - see isDrawn - and the ones that
   * were clicked are dropped rather than left half-drawn on screen with no way
   * to finish them. Either way the pencil is put down: the next click starts a
   * new polygon rather than continuing one nobody can see the end of.
   */
  function finishPolygon(points = polyPoints) {
    setPolyPoints(null);
    const corners = points || [];
    if (corners.length < 3) return;
    createShape({ ...polygonFrom(corners), ...shapeLook() });
  }

  async function createShape(shape) {
    setError('');
    try {
      const created = await api.addShape(scene.id, shape);
      setScenes((prev) =>
        prev.map((s) => (s.id === scene.id ? { ...s, shapes: [...(s.shapes || []), created] } : s))
      );
      // Selected on arrival: you have just decided where it goes, and what's
      // wanted next is almost always to tune it.
      setSelectedShapeId(created.id);
      recordShapeAdd({ sceneId: scene.id, shape: created });
    } catch (e) {
      setError(e.message);
    }
  }

  /**
   * Change a shape: a slider moved, or a drag that put it somewhere else.
   *
   * Applied here and written when the hand stops, like the grid's own sliders -
   * a colour picker dragged across the spectrum would otherwise be a hundred
   * writes and a hundred broadcasts of a shape nobody has finished choosing.
   */
  function editShape(id, changes) {
    const shape = shapes.find((s) => s.id === id);
    if (!shape || !canEditShape(shape)) return;
    setScenes((prev) =>
      prev.map((s) =>
        s.id === scene.id
          ? { ...s, shapes: s.shapes.map((x) => (x.id === id ? { ...x, ...changes } : x)) }
          : s
      )
    );
    // The shape as it stood before the *first* change of a burst is the one
    // Undo has to put back - not as it stood one slider-notch ago.
    if (shapeEdit.current?.id !== id) shapeEdit.current = { id, before: shape, changes: {} };
    shapeEdit.current.changes = { ...shapeEdit.current.changes, ...changes };
    clearTimeout(shapeTimer.current);
    shapeTimer.current = setTimeout(saveShapeEdit, SHAPE_SAVE_MS);
  }

  async function saveShapeEdit() {
    const pending = shapeEdit.current;
    shapeEdit.current = null;
    if (!pending) return;
    const fields = Object.keys(pending.changes);
    try {
      const updated = await api.updateShape(scene.id, pending.id, pending.changes);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id
            ? { ...s, shapes: s.shapes.map((x) => (x.id === updated.id ? updated : x)) }
            : s
        )
      );
      const before = pick(pending.before, fields);
      const after = pick(updated, fields);
      if (!matches(after, before)) {
        recordShapeEdit({ sceneId: scene.id, shapeId: updated.id, before, after });
      }
    } catch (e) {
      setError(e.message);
      refresh(); // whatever the board is, it isn't what we just drew
    }
  }

  /**
   * Take every shape off the board that's yours to take off.
   *
   * For the DM that's the lot; for anyone else it's their own drawings, which
   * is the same rule as rubbing out one of them and is enforced on the server
   * either way. One request, so the table sees the map clear at once rather
   * than a shape at a time, and one undo entry, so it comes back the same way.
   */
  async function clearShapes() {
    clearTimeout(shapeTimer.current);
    shapeEdit.current = null;
    setError('');
    const { removed } = await api.clearShapes(scene.id);
    const gone = new Set((removed || []).map((s) => s.id));
    setScenes((prev) =>
      prev.map((s) =>
        s.id === scene.id ? { ...s, shapes: (s.shapes || []).filter((x) => !gone.has(x.id)) } : s
      )
    );
    setSelectedShapeId(null);
    if (removed?.length) recordShapesCleared({ sceneId: scene.id, shapes: removed });
  }

  async function eraseShape(id) {
    const shape = shapes.find((s) => s.id === id);
    if (!shape || !canEditShape(shape)) return;
    // Anything still waiting to be written is about a shape that's leaving.
    clearTimeout(shapeTimer.current);
    shapeEdit.current = null;
    setError('');
    try {
      await api.deleteShape(scene.id, id);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, shapes: s.shapes.filter((x) => x.id !== id) } : s
        )
      );
      setSelectedShapeId(null);
      recordShapeDelete({ sceneId: scene.id, shape });
    } catch (e) {
      setError(e.message);
    }
  }

  // --- pins ---

  /**
   * The cards on screen right now, in the order they were reached for.
   *
   * Resolved from the live scene rather than kept as records: a pin can be
   * changed by its author or taken back from you while you are reading it, and
   * an id that no longer resolves is a card that closes itself. That is the
   * whole of "unsharing takes effect at once" on this screen.
   */
  const openPins = openPinIds.map((id) => pins.find((p) => p.id === id)).filter(Boolean);

  /**
   * Keep track of where the map is on screen while any card is open.
   *
   * Scrolling the board moves the picture without changing a thing React knows
   * about, so the card over a pin would stay where it was while the pin slid
   * away underneath. Measured on every scroll, and only while there is a card
   * to place: the listener is not worth having on a map nobody has opened a pin
   * on. Compared before it is stored, so a scroll that moved nothing - the map
   * is already against its edge - is not a render.
   */
  useLayoutEffect(() => {
    if (!openPins.length) {
      setSurfaceBox(null);
      return undefined;
    }
    const measure = () => {
      const el = surfaceRef.current;
      if (!el) return;
      const { left, top } = el.getBoundingClientRect();
      setSurfaceBox((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    measure();
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      scroller?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
    // The zoom and the tick are in here because both move the picture under the
    // cards without a scroll event: one resizes the surface, the other is what
    // a focus pull bumps once it has scrolled somewhere new.
  }, [openPins.length, zoom, selectedId, focusTick]);

  /**
   * Tell the whole page that pins are being placed.
   *
   * On the body rather than on this component's own root, because what the
   * class holds still is mostly *not* in this component: the campaign's tabs,
   * the chat down the side, the music. Everything the mode leaves alive - the
   * map, the zoom, its own bar, and the cards already open - is written as an
   * exception in the stylesheet, so there is one list to read rather than a
   * `disabled` scattered across four files.
   */
  useEffect(() => {
    document.body.classList.toggle('pins-moving', movingPins);
    return () => document.body.classList.remove('pins-moving');
  }, [movingPins]);

  /**
   * Where a pin is on screen, as its card's anchor.
   *
   * The point of the pin is the spot it was stuck in; the head and the title
   * stand above it. So the card is told to clear `top` when there is room above
   * and `bottom` when there isn't, and both allow for the title, which sits on
   * whichever side the head does not need.
   */
  const anchorFor = (pin) => {
    if (!surfaceBox) return null;
    // Where it is *now*, which mid-move is where it has been dragged to: a card
    // left hanging over the spot its pin has just left would be a card about
    // somewhere else.
    const spot = pinSpot(pin);
    const tip = surfaceBox.top + spot.y * zoom;
    return {
      x: surfaceBox.left + spot.x * zoom,
      top: tip - PIN_PX - PIN_LABEL_PX,
      bottom: tip + PIN_LABEL_PX,
    };
  };

  /**
   * Open a pin, or bring an already-open one to the front.
   *
   * The card in front is left alone rather than re-listed, because this is also
   * what a press anywhere inside a card calls: resizing one would otherwise
   * rewrite the list on every pointer event of the drag.
   */
  function openPin(id) {
    setOpenPinIds((ids) => (ids[ids.length - 1] === id ? ids : [...ids.filter((x) => x !== id), id]));
  }

  const closePin = (id) => setOpenPinIds((ids) => ids.filter((x) => x !== id));

  /**
   * Show the pins, or put them away.
   *
   * Hiding them closes every card with them. A card floating over a board with
   * no pin under it would be a note about a place nothing marks any more.
   */
  function togglePins() {
    setShowPins((on) => {
      if (on) setOpenPinIds([]);
      return !on;
    });
  }

  /**
   * Stick a new pin in, or save the changes to one.
   *
   * Not wrapped in guard(): the form is open and an error belongs in front of
   * whoever is still looking at it, which is what throwing does. Creating one
   * turns the pins on, since a pin somebody has just written and cannot see
   * would look exactly like a pin that failed to save.
   */
  async function submitPin(data) {
    if (!scene) return;
    if (pinForm?.pin) {
      const updated = await api.updatePin(scene.id, pinForm.pin.id, data);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id
            ? { ...s, pins: (s.pins || []).map((p) => (p.id === updated.id ? updated : p)) }
            : s
        )
      );
      return;
    }
    const created = await api.addPin(scene.id, data);
    setScenes((prev) =>
      prev.map((s) => (s.id === scene.id ? { ...s, pins: [...(s.pins || []), created] } : s))
    );
    setShowPins(true);
  }

  async function removePin(pinId) {
    setError('');
    try {
      await api.deletePin(scene.id, pinId);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, pins: (s.pins || []).filter((p) => p.id !== pinId) } : s
        )
      );
      closePin(pinId);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  // --- moving pins ---

  /** Give the map over to placing pins. Nothing is written until Confirm. */
  function startMovingPins() {
    setMenu(null);
    setError('');
    setPinMoves({});
    setPinUndo({ done: [], undone: [] });
    setMovingPins(true);
  }

  /** And take it back, forgetting whatever was staged. */
  function stopMovingPins() {
    pinDragRef.current = null;
    setPinMoves({});
    setPinUndo({ done: [], undone: [] });
    setMovingPins(false);
    setSavingPins(false);
  }

  /**
   * Where the pointer is on the map, in map pixels.
   *
   * Unzoomed, because that is what a pin's position is stored in - the one
   * frame of reference every client shares whatever their zoom or window size.
   */
  function mapPointAt(e) {
    const surf = surfaceRef.current;
    if (!surf) return null;
    const rect = surf.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  function onPinDragStart(e, pin) {
    // Left button only; the right one is still the pan, which is the whole
    // reason it stays available in here.
    if (!movingPins || e.button !== 0 || !canEditPin(pin)) return;
    const at = mapPointAt(e);
    if (!at) return;
    e.preventDefault();
    // The press must not also reach the map underneath, which would read it as
    // the start of a pan or a drawing gesture.
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = pinSpot(pin);
    // Where inside the head it was grabbed, so the pin doesn't jump to put its
    // point under the cursor the moment it is picked up.
    pinDragRef.current = {
      id: pin.id,
      grabX: at.x - from.x,
      grabY: at.y - from.y,
      from,
      to: from,
    };
  }

  function onPinDragMove(e) {
    const drag = pinDragRef.current;
    if (!drag) return;
    const at = mapPointAt(e);
    if (!at) return;
    e.stopPropagation();
    // Clamped to the picture: a pin dragged off the edge of the map is a pin
    // nobody can reach again, since the board only scrolls as far as its own
    // corners.
    const to = {
      x: Math.round(clamp(at.x - drag.grabX, 0, mapW)),
      y: Math.round(clamp(at.y - drag.grabY, 0, mapH)),
    };
    drag.to = to;
    setPinMoves((moves) => ({ ...moves, [drag.id]: to }));
  }

  /**
   * The end of a drag, and the one thing worth remembering about it.
   *
   * A press that moved nothing is not an action - it leaves no entry, so a
   * Ctrl+Z after an accidental click takes back the last real move rather than
   * appearing to do nothing.
   */
  function onPinDragEnd(e) {
    const drag = pinDragRef.current;
    if (!drag) return;
    pinDragRef.current = null;
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone - a cancel, or the button released off-window */
    }
    if (drag.to.x === drag.from.x && drag.to.y === drag.from.y) return;
    setPinUndo((stack) => ({
      done: [...stack.done, { id: drag.id, from: drag.from, to: drag.to }],
      // A new move is a new branch of this sitting's history, exactly as it is
      // in the app's own stack.
      undone: [],
    }));
  }

  /** Take back the last move of this sitting, and put it again. */
  function undoPinMove() {
    const last = pinUndo.done[pinUndo.done.length - 1];
    if (!last) return;
    setPinMoves((moves) => ({ ...moves, [last.id]: last.from }));
    setPinUndo((stack) => ({ done: stack.done.slice(0, -1), undone: [...stack.undone, last] }));
  }

  function redoPinMove() {
    const next = pinUndo.undone[pinUndo.undone.length - 1];
    if (!next) return;
    setPinMoves((moves) => ({ ...moves, [next.id]: next.to }));
    setPinUndo((stack) => ({ done: [...stack.done, next], undone: stack.undone.slice(0, -1) }));
  }

  /**
   * Write the moves, and only the ones that are actually moves.
   *
   * One request per pin rather than one for the lot, because that is the route
   * that exists and each pin is its own record; they go one after another so a
   * refusal names the pin it is about. Anything that fails stays staged with
   * the mode still open - a save that half worked must not look like one that
   * worked, and the placing you did is not something to throw away on our own
   * initiative.
   */
  async function confirmPinMoves() {
    if (!scene || savingPins) return;
    const moved = pins.filter((pin) => {
      const at = pinMoves[pin.id];
      return at && (at.x !== pin.x || at.y !== pin.y);
    });
    if (!moved.length) {
      stopMovingPins();
      return;
    }
    setSavingPins(true);
    setError('');
    const failed = [];
    for (const pin of moved) {
      const at = pinMoves[pin.id];
      try {
        // Position only. The server merges an edit onto the stored pin, so what
        // it says, who it is shared with and what colour it is all survive
        // being dragged across the map.
        const updated = await api.updatePin(scene.id, pin.id, { x: at.x, y: at.y });
        setScenes((prev) =>
          prev.map((s) =>
            s.id === scene.id
              ? { ...s, pins: (s.pins || []).map((p) => (p.id === updated.id ? updated : p)) }
              : s
          )
        );
      } catch (err) {
        failed.push({ pin, message: err.message });
      }
    }
    if (!failed.length) {
      stopMovingPins();
      return;
    }
    setSavingPins(false);
    // Keep only what did not land, so pressing Confirm again retries exactly
    // those and the ones that saved are not written a second time.
    const stuck = new Set(failed.map((f) => f.pin.id));
    setPinMoves((moves) =>
      Object.fromEntries(Object.entries(moves).filter(([id]) => stuck.has(id)))
    );
    setPinUndo({ done: [], undone: [] });
    setError(
      failed.length === 1
        ? `“${failed[0].pin.title}” could not be moved: ${failed[0].message}`
        : `${failed.length} pins could not be moved. ${failed[0].message}`
    );
  }

  // --- fog of war ---

  /**
   * Change the scene's fog: the unit, the scale, or whether the lights are out.
   *
   * Applied here and written at once, because every one of these is a single
   * decision rather than something dragged: there is no half-typed state of
   * "the lights are off". A failure puts the board back the way the server has
   * it rather than leaving this browser believing something the table doesn't.
   */
  async function saveFog(changes) {
    if (!scene) return;
    const next = { ...fog, ...changes };
    setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, fog: next } : s)));
    setError('');
    try {
      const saved = await api.setFog(scene.id, next);
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? { ...s, fog: saved } : s)));
    } catch (e) {
      setError(e.message);
      refresh();
    }
  }

  /** How far one creature can see. Stored on the token, in cells. */
  async function saveVision(tokenId, changes) {
    if (!scene) return;
    setError('');
    try {
      const updated = await api.updateToken(scene.id, tokenId, changes);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id
            ? { ...s, tokens: s.tokens.map((t) => (t.id === updated.id ? updated : t)) }
            : s
        )
      );
    } catch (e) {
      setError(e.message);
    }
  }

  /**
   * Look through a creature's eyes, and stop.
   *
   * Nothing is sent either way. What this changes is which tokens *this* screen
   * draws the darkness from, and the answer to that question is nobody else's
   * business - see fogEyes.
   */
  function enterPov(tokenId) {
    setMenu(null);
    setPovTokenId(tokenId);
  }

  const exitPov = useCallback(() => setPovTokenId(null), []);

  /**
   * A point of view outlives nothing.
   *
   * The lights coming back on, the creature leaving the board, a change of
   * scene: each of them leaves a borrowed pair of eyes describing a board that
   * is no longer there, so each of them gives them back.
   */
  useEffect(() => {
    if (!povTokenId) return;
    if (!fogActive || !povToken) setPovTokenId(null);
  }, [povTokenId, povToken, fogActive]);

  /**
   * Escape gives the eyes back, before it does anything else.
   *
   * Capture phase for the same reason the ruler's Escape is: the windows on
   * screen listen for the key too, and a bubbling handler would find one of
   * them already closed. Leaving a point of view is the more urgent of the two
   * - it is a whole mode - so it goes first and stops the event where it is.
   */
  useEffect(() => {
    if (!povTokenId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || isTyping(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      exitPov();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [povTokenId, exitPov]);

  /**
   * Tell the page that the DM is looking through somebody else's eyes.
   *
   * The same device the pin-moving mode uses, and for the same reason: what has
   * to be held still - the tools panel - is drawn by this component, but saying
   * so in one class keeps the rule in the stylesheet where the greying is.
   */
  useEffect(() => {
    document.body.classList.toggle('fog-pov', Boolean(povTokenId));
    return () => document.body.classList.remove('fog-pov');
  }, [povTokenId]);

  // --- panning ---
  // Right-drag anywhere on the map moves your view, so you don't have to reach
  // for the scrollbars. Tokens are excluded: a right-click on one keeps its
  // normal browser menu.
  const onToken = (e) => Boolean(e.target.closest?.('.token'));

  /**
   * Whether a right-drag moves the grid instead of the view.
   *
   * While Grid settings is open the gesture is aimed at the grid rather than
   * the camera: the map stays exactly where it is and the cells slide over it.
   * That is what makes a map with a grid already drawn on it usable - size the
   * cells to match the art, then push them onto it. The view still has its
   * scrollbars, and closing the window gives the pan back.
   *
   * It used to be armed by selecting a Grid gauge in the scene bar. The gauge
   * has gone into the window, and the window is now what arms it: the two
   * always belonged together, since the only reason to slide a grid is that you
   * are in the middle of setting one up.
   */
  const canNudgeGrid = canTuneGrid && Boolean(gridDraft);

  function onPanStart(e) {
    pannedRef.current = false; // any fresh press starts a new gesture
    setMenu(null); // ...and any fresh press dismisses the last menu
    if (e.button !== 2 || onToken(e)) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    panRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      // Decided at the press, not at each move: changing gauge mid-drag would
      // otherwise turn a nudge into a pan halfway through it.
      grid: canNudgeGrid,
      // Where the grid started, and where it has got to - kept here rather than
      // read back from the draft, so a move can't pick up a value from a render
      // that hasn't happened yet.
      offX: gridOffX,
      offY: gridOffY,
    };
    setGesture(canNudgeGrid ? 'grid' : 'pan');
  }

  function onPanMove(e) {
    const p = panRef.current;
    if (!p) return;
    // Hold still until the pointer has actually gone somewhere. Until then this
    // gesture is a click, and treating it as a pan would both nudge the map and
    // eat the context menu on release.
    if (!pannedRef.current && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < PAN_SLOP) {
      return;
    }
    pannedRef.current = true;
    if (p.grid) {
      // In map pixels, not screen ones: the offset is stored against the map,
      // so everyone draws the same alignment whatever their zoom. Held to a
      // cell each way - beyond that the grid only repeats itself.
      p.offX = clamp(Math.round(p.offX + (e.clientX - p.x) / zoom), -gridSize, gridSize);
      p.offY = clamp(Math.round(p.offY + (e.clientY - p.y) / zoom), -gridSize, gridSize);
      // The travel so far has been spent; measure the next move from here.
      p.x = e.clientX;
      p.y = e.clientY;
      // Into the draft, like everything else the window changes. Nothing is
      // written when the button comes up; Save is what sends it to the table.
      changeGrid({ gridOffsetX: p.offX, gridOffsetY: p.offY });
      return;
    }
    const el = scrollRef.current;
    // Drag the map with the cursor: content moves the way the hand does, so
    // the scroll offset goes the opposite way.
    el.scrollLeft = p.left - (e.clientX - p.x);
    el.scrollTop = p.top - (e.clientY - p.y);
  }

  function onPanEnd() {
    const p = panRef.current;
    if (!p) return;
    panRef.current = null;
    setGesture(null);
    try {
      scrollRef.current?.releasePointerCapture(p.pointerId);
    } catch {
      /* pointer already gone */
    }
    // Nothing to save here any more. The drag has been writing into the draft
    // as it went, and the draft is written to the scene by Save changes.
  }

  // --- scroll to adjust ---
  // The wheel drives one of the bars in the scene bar rather than the
  // scrollbars - whichever is selected there. Registered natively because React
  // attaches wheel listeners as *passive*, where preventDefault() is ignored and
  // the page would scroll anyway.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e) => {
      e.preventDefault();

      // Normalise the units browsers report (pixels / lines / pages).
      const delta =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      // Reversing direction should respond at once, not fight leftover travel.
      if (Math.sign(delta) !== Math.sign(wheelAcc.current)) wheelAcc.current = 0;
      wheelAcc.current += delta;

      const notches = Math.trunc(wheelAcc.current / WHEEL_NOTCH);
      if (!notches) return;
      wheelAcc.current -= notches * WHEEL_NOTCH;

      // Scrolling down (positive delta) means less of whatever the wheel is
      // driving - zoomed further out, or smaller cells.
      //
      // The wheel goes to the grid exactly while Grid settings is open, which
      // is the same condition that gives the right-drag to the grid. One mode,
      // both gestures: inside that window the map is a thing being set up, and
      // outside it the map is a thing being played on.
      if (gridDraft && canTuneGrid) {
        const next = clamp(gridSize - notches * GRID_WHEEL_STEP, GRID_MIN, GRID_MAX);
        if (next !== gridSize) changeGrid({ gridSize: next });
        return;
      }

      const next = clamp(round1(zoom - notches * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
      if (next === zoom) return;

      // Remember the map point under the cursor so it stays put across the
      // zoom - otherwise the view lurches away from whatever you're aiming at.
      const surf = surfaceRef.current;
      const box = el.getBoundingClientRect();
      if (surf) {
        const sBox = surf.getBoundingClientRect();
        zoomAnchor.current = {
          mx: (e.clientX - sBox.left) / zoom, // in unzoomed map pixels
          my: (e.clientY - sBox.top) / zoom,
          cx: e.clientX - box.left, // where in the viewport to pin it
          cy: e.clientY - box.top,
        };
      }
      setZoom(next);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // `gridDraft` decides which of the two the wheel is driving, so the
    // listener has to be rebound when the window opens or closes.
  }, [zoom, selectedId, canTuneGrid, gridSize, gridDraft]);

  // Re-pin the anchor point after the zoom has been laid out.
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a) return;
    zoomAnchor.current = null;
    const el = scrollRef.current;
    const surf = surfaceRef.current;
    if (!el || !surf) return;
    const box = el.getBoundingClientRect();
    const sBox = surf.getBoundingClientRect();
    // Where the surface starts in content coordinates. Derived rather than read
    // from offsetLeft because `margin: 0 auto` centring shifts it.
    const originX = sBox.left - box.left + el.scrollLeft;
    const originY = sBox.top - box.top + el.scrollTop;
    el.scrollLeft = originX + a.mx * zoom - a.cx;
    el.scrollTop = originY + a.my * zoom - a.cy;
  }, [zoom]);

  /**
   * Centre the view on a map point, once the zoom it arrived with is on screen.
   *
   * Runs after every render that bumped focusTick, which is why the tick exists
   * - a focus at the zoom you already had changes no state the renderer can see.
   */
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const el = scrollRef.current;
    const surf = surfaceRef.current;
    if (!el || !surf) return;
    const box = el.getBoundingClientRect();
    const sBox = surf.getBoundingClientRect();
    // Where the surface begins in content coordinates - derived rather than
    // read from offsetLeft, because `margin: 0 auto` centring shifts it.
    const originX = sBox.left - box.left + el.scrollLeft;
    const originY = sBox.top - box.top + el.scrollTop;
    // Put the point in the middle of the viewport. Assigning past either end is
    // clamped by the browser, which is exactly what should happen at a border
    // or a corner: scroll as far as there is map to scroll, and no further. The
    // spot ends up off-centre there, which is the honest result - the alternative
    // is showing everyone a margin of nothing so the maths can come out even.
    el.scrollLeft = originX + target.mx * zoom - el.clientWidth / 2;
    el.scrollTop = originY + target.my * zoom - el.clientHeight / 2;
  }, [focusTick, zoom]);

  // An open menu is dismissed by anything that isn't using it.
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      // Not a press on the menu itself - that press is someone choosing an item,
      // and closing here would unmount the button before its click landed.
      if (e?.target && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);

  /**
   * Ctrl+Z and Ctrl+Shift+Z, the two shortcuts everybody's hands already know.
   *
   * Bound while the tabletop is on screen, since everything Undo can reach is
   * on it. Note that a browser cannot tell the left Shift from the right one
   * here: a keydown only reports *that* Shift is held, not which, so either
   * hand redoes.
   */
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key?.toLowerCase() !== 'z') return;
      // A text box has an undo of its own, and that is the one being asked for.
      // Taking the keystroke from someone retyping a chat line to instead move
      // a token behind them would be a poor trade.
      if (isTyping(e.target)) return;
      // A form over the map is what the keyboard is aimed at, even when the
      // focus has slipped off its fields.
      if (tokenForm || confirmDelete) return;
      e.preventDefault();
      // While pins are being placed the two keys mean *this sitting* and
      // nothing else. Reaching past it into the app's own stack would take back
      // somebody's token move in the middle of an unrelated job, and the moves
      // being undone here are not in that stack anyway - none of them has been
      // written yet.
      if (movingPins) {
        if (e.shiftKey) redoPinMove();
        else undoPinMove();
        return;
      }
      runHistory(e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runHistory, tokenForm, confirmDelete, movingPins, pinUndo]);

  /**
   * Escape ends the line you're drawing, and only that.
   *
   * In the *capture* phase on the document, which is the whole trick: the
   * measuring window listens for Escape too, on the document, to close itself.
   * A bubbling listener would run after that one and find the window already
   * shut. Capture runs first, so this gets to decide - and stops the event
   * where it stands when there was a line to end.
   *
   * With no line open the key falls through untouched, and Escape closes the
   * window as it does for every other window in the app. That is the right
   * order of surrender: the first press puts the pen down, the second puts the
   * box away.
   */
  useEffect(() => {
    if (!measuring) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || !openChainId) return;
      if (isTyping(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      // Not recorded as an undoable action. Nothing about the board changed -
      // this only says the next click starts somewhere new, and a Ctrl+Z that
      // silently reopened a line for appending would be an invisible edit.
      applyRuler({ ...rulerRef.current, openChainId: null });
      setMeasureAt(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [measuring, openChainId, applyRuler]);

  /**
   * Delete rubs out the shape you have hold of.
   *
   * Only while a tool is in hand and something is picked - the same two
   * conditions that put the button in the panel - so the key means nothing at
   * all when there's nothing selected to mean it about. Undo puts it back, like
   * everything else here, which is why it doesn't stop to ask.
   */
  useEffect(() => {
    if (!drawing || !selectedShapeId) return;
    const onKey = (e) => {
      if (e.key !== 'Delete') return;
      // Delete inside a text box is a text box's own key - the label field in
      // the drawing panel is one, and it's a field you type in with a shape
      // selected by definition. A slider is not.
      if (isTyping(e.target)) return;
      e.preventDefault();
      // Through the ref, so the listener always rubs out against the board as
      // it stands rather than as it stood when the key was bound.
      eraseRef.current(selectedShapeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, selectedShapeId]);

  /**
   * Escape finishes the polygon being clicked out.
   *
   * The same key that closes an open measuring chain, because it is the same
   * situation: a run of clicks with no natural last one. It goes down as a
   * shape if there is enough of it to be one and is dropped if there is not,
   * which makes Escape the way out of a polygon started by mistake as well as
   * the way to finish a good one.
   *
   * On `window` rather than the map, so it works with the focus anywhere - the
   * drawing panel's own fields included, since a corner is often the last thing
   * clicked before reaching for a colour.
   */
  useEffect(() => {
    if (!polyPoints) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finishRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [polyPoints]);

  // Through a ref for the reason the eraser above is: the listener is bound
  // once per run of corners and must act on the corners as they stand.
  const finishRef = useRef(() => {});
  finishRef.current = () => finishPolygon();

  /**
   * A tool put down, or the mode left, abandons a half-drawn polygon.
   *
   * Not finished - abandoned. Choosing the circle tool is not a way of saying
   * "and commit that": what was on screen was a thing being decided, and the
   * decision was to go and do something else.
   */
  useEffect(() => {
    if (!drawing || shapeTool !== 'poly') setPolyPoints(null);
  }, [drawing, shapeTool]);

  function onContextMenu(e) {
    // Windows fires contextmenu on mouse-*up*, so a pan that finishes over a
    // token would otherwise pop that token's menu. A gesture that panned never
    // opens a menu, wherever it happens to end.
    if (pannedRef.current) {
      pannedRef.current = false;
      e.preventDefault();
      return;
    }
    /**
     * While pins are being placed, the menu is about this sitting and nothing
     * else: two items, both of them about what your own hand has just done.
     *
     * First of all the branches, because the mode owns the map - a menu
     * offering to delete a token, or to edit the very pin you are dragging,
     * would be a menu describing a different mode.
     */
    if (movingPins) {
      e.preventDefault();
      setMenu({
        clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
        clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
        moving: true,
      });
      return;
    }

    /**
     * A polygon being clicked out owns the right-click while it is open.
     *
     * Before everything below it for the reason the ruler's menu is: the shape
     * in hand is what the pointer is about, and offering to edit a token under
     * a corner you were aiming at would be a menu describing something else.
     * Hit-tested here in cells rather than by the DOM, again like the ruler -
     * the corners are drawn on a layer the pointer passes straight through, so
     * that they never get in the way of the map itself.
     */
    if (drawing && shapeTool === 'poly' && polyPoints?.length) {
      e.preventDefault();
      const surf = surfaceRef.current;
      if (!surf) return;
      const box = surf.getBoundingClientRect();
      const at = {
        x: (e.clientX - box.left - offXPx) / cellPx,
        y: (e.clientY - box.top - offYPx) / cellPx,
      };
      const pointIndex = pointIndexAt(polyPoints, at, POLY_CLOSE_GRAB);
      setMenu({
        clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
        clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
        polygon: { pointIndex },
      });
      return;
    }

    /**
     * While measuring, the menu is about the ruler and nothing else.
     *
     * Before the token check, because the board is inert: offering to edit a
     * token you cannot so much as drag would be a menu describing a different
     * mode. What it offers depends on what the click landed on, and the
     * hit-testing is done here in cells rather than by the DOM, so the drawn
     * layer can stay untouchable to the pointer - a line one pixel wide is not
     * a thing anybody can be asked to hit.
     */
    if (measuring) {
      e.preventDefault();
      const surf = surfaceRef.current;
      if (!surf) return;
      const box = surf.getBoundingClientRect();
      const at = {
        x: (e.clientX - box.left - offXPx) / cellPx,
        y: (e.clientY - box.top - offYPx) / cellPx,
      };
      // The topmost first: a later chain is drawn over an earlier one, so it is
      // the one the eye thinks it is pointing at.
      let hit = null;
      for (let i = measurements.length - 1; i >= 0 && !hit; i -= 1) {
        const m = measurements[i];
        const pointIndex = pointIndexAt(m.points, at, MEASURE_POINT_GRAB);
        if (pointIndex >= 0) hit = { chainId: m.id, pointIndex };
        else if (touches(m.points, at, MEASURE_GRAB)) hit = { chainId: m.id, pointIndex: -1 };
      }
      setMenu({
        clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
        clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
        measure: hit || {},
      });
      return;
    }

    // A pin gets a menu about *that pin*, and only for the person whose pin it
    // is: sharing one hands over something to read, and a menu offering to edit
    // or delete somebody else's note would be a menu of things you may not do.
    // Before the token check, because a pin is drawn over the board and is what
    // the hand was aiming at when it landed on one.
    const pinEl = e.target.closest?.('.map-pin');
    if (pinEl) {
      const pin = pins.find((p) => p.id === pinEl.dataset.pinId);
      if (!pin) return;
      // Somebody else's pin still gets a menu when you have pins of your own on
      // this board, because Move pins is about the board rather than about the
      // pin that was clicked. With nothing of your own to move there is nothing
      // to offer, and the browser's own menu is better than an empty one.
      if (!canEditPin(pin) && !movablePins.length) return;
      e.preventDefault();
      setMenu({
        clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
        clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
        pinId: pin.id,
      });
      return;
    }

    // A token gets a menu about *that token* rather than about the map under
    // it. The DM gets one on any token; a player gets one on their own, where
    // there is plenty on it for them - editing it, its initiative, and taking
    // it off the table. On anybody else's they keep the browser's own menu,
    // because a menu of things you may not do is worse than no menu.
    const el = e.target.closest?.('.token');
    if (el) {
      const token = scene?.tokens.find((t) => t.id === el.dataset.tokenId);
      // In a borrowed point of view, only that creature has a menu.
      if (povTokenId && token?.id !== povTokenId) return;
      if (offline || !(isDm || canMove(token))) return;
      e.preventDefault();
      setMenu({
        clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
        clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
        tokenId: el.dataset.tokenId,
      });
      return;
    }
    e.preventDefault();
    // Every item in the menu is something the server relays to other people, so
    // there's nothing to offer while the server is unreachable.
    if (offline) return;
    const surf = surfaceRef.current;
    if (!surf) return;
    const rect = surf.getBoundingClientRect();
    setMenu({
      // Where to draw the menu: viewport coordinates, since it's positioned
      // fixed and must not scroll away from the spot it describes.
      clientX: clamp(e.clientX, 8, window.innerWidth - MENU_W),
      clientY: clamp(e.clientY, 8, window.innerHeight - MENU_H),
      // What it points at: unzoomed map pixels, the one frame of reference
      // every client shares whatever their zoom or window size. Clamped to the
      // map because the surface is centred and you can right-click beside it.
      mx: clamp((e.clientX - rect.left) / zoom, 0, mapW),
      my: clamp((e.clientY - rect.top) / zoom, 0, mapH),
    });
  }

  // --- right-click actions ---

  /**
   * The three things the ruler's menu can do.
   *
   * All local, all undoable, none of them asking first. Nothing here can lose
   * work - a measurement is a question, not a drawing - and a confirmation
   * dialog in front of something Ctrl+Z puts straight back is a dialog that
   * only ever gets in the way.
   */
  function deleteMeasurePoint() {
    const { chainId, pointIndex } = menu?.measure || {};
    setMenu(null);
    if (!chainId || pointIndex == null || pointIndex < 0) return;
    changeMeasure('delete point', ({ measurements: was, openChainId: open }) => {
      const chain = was.find((m) => m.id === chainId);
      if (!chain) return null;
      const points = chain.points.filter((_, i) => i !== pointIndex);
      // A chain with nothing left in it is not a chain. Taking the last point
      // out of one removes it, rather than leaving an invisible entry that the
      // "delete all" count would still be counting.
      if (!points.length) {
        return {
          measurements: was.filter((m) => m.id !== chainId),
          openChainId: open === chainId ? null : open,
        };
      }
      return {
        measurements: was.map((m) => (m.id === chainId ? { ...m, points } : m)),
        openChainId: open,
      };
    });
  }

  function deleteMeasurement() {
    const { chainId } = menu?.measure || {};
    setMenu(null);
    if (!chainId) return;
    changeMeasure('delete measurement', ({ measurements: was, openChainId: open }) => ({
      measurements: was.filter((m) => m.id !== chainId),
      openChainId: open === chainId ? null : open,
    }));
  }

  /**
   * Drop one corner from the polygon in hand.
   *
   * No confirmation and no writing: this is a shape being decided rather than
   * one on the board, so there is nothing to lose and nothing to tell anybody
   * about. Taking the last corner out ends the polygon, the same way taking the
   * last point out of a measurement ends that.
   */
  function deletePolygonPoint() {
    const { pointIndex } = menu?.polygon || {};
    setMenu(null);
    if (pointIndex == null || pointIndex < 0) return;
    setPolyPoints((was) => {
      const left = (was || []).filter((_, i) => i !== pointIndex);
      return left.length ? left : null;
    });
  }

  function deletePolygon() {
    setMenu(null);
    setPolyPoints(null);
  }

  function deleteAllMeasurements() {
    setMenu(null);
    if (!measurements.length) return;
    changeMeasure('delete all measurements', () => ({ measurements: [], openChainId: null }));
  }

  function ping() {
    if (!menu || !scene) return;
    socket.emit('scene:ping', { sceneId: scene.id, x: menu.mx, y: menu.my, color: myColor });
    setMenu(null);
  }

  function focusEveryone() {
    if (!menu || !scene) return;
    // Sent to the whole room including us, so one path moves every camera and
    // we end up looking at exactly what we just asked everyone else to look at.
    socket.emit('scene:focus', { sceneId: scene.id, x: menu.mx, y: menu.my, zoom });
    setMenu(null);
  }

  /**
   * The same pull, aimed at where a token stands rather than where a pointer
   * was - what a double-click in the turn list does.
   *
   * Token coordinates are in cells and the focus wants map pixels, and it wants
   * the middle of the token rather than its top-left corner: a size-3 giant
   * centred on its corner sits a cell and a half off the middle of the screen.
   */
  // Resolved from the live scene when the item is chosen, not when the menu was
  // opened - the same care the map's own menu takes, since a token can be
  // deleted or moved while its menu is sitting there.
  function focusFromTurnList() {
    const token = scene?.tokens.find((t) => t.id === menu?.turnTokenId);
    setMenu(null);
    focusOnToken(token);
  }

  // Hands the turn to the token whose row was right-clicked. The server decides
  // whether that's allowed; all this has to know is which row it was.
  function giveTurnTo() {
    const tokenId = menu?.turnTokenId;
    setMenu(null);
    if (!scene || !tokenId) return;
    guard(async () => applyTurn(await api.giveTurn(scene.id, tokenId)));
  }

  function focusOnToken(token) {
    if (!scene || !token) return;
    const half = (token.size || 1) / 2;
    socket.emit('scene:focus', {
      sceneId: scene.id,
      x: gridOffX + (token.x + half) * gridSize,
      y: gridOffY + (token.y + half) * gridSize,
      zoom,
    });
  }

  // Remember where the menu was opened and hand the rest to the modal. The spot
  // is settled here, not there: a token summoned into the top-left corner is one
  // you then have to go and find, and the point of asking for it *here* is that
  // here is where you want it.
  /**
   * Where a right-click landed, in cells.
   *
   * Measured from the grid's own corner, so it follows the grid when that has
   * been slid across the map, and clamped to the board - you can right-click
   * beside a map that is narrower than its scroller.
   *
   * Floored, not rounded. The question here is "which square is this point
   * inside", and that is the whole of the difference: rounding answers "which
   * grid *line* is this point nearest", which is a different question with an
   * answer half a cell out. It shifted every placement up and to the left by
   * half a square, and it made the first row and the first column half the
   * target every other one is - a click anywhere in the lower half of row 0
   * landed in row 1, so the top row could only be hit by catching its top few
   * pixels. Dragging is unaffected and stays rounded: there the number is a
   * token's own corner being snapped to the nearest grid line, which is exactly
   * the other question.
   */
  const cellAt = (mx, my) => ({
    x: clamp(
      gridOn ? Math.floor((mx - gridOffX) / gridSize) : round2((mx - gridOffX) / gridSize),
      minCol,
      maxCol
    ),
    y: clamp(
      gridOn ? Math.floor((my - gridOffY) / gridSize) : round2((my - gridOffY) / gridSize),
      minRow,
      maxRow
    ),
  });

  function openTokenModal() {
    if (!menu || !scene) return;
    setTokenForm(cellAt(menu.mx, menu.my));
    setMenu(null);
  }

  // --- token actions ---
  // Resolved from the live scene rather than captured when the menu opened, so
  // an edit can't be applied to a token someone deleted in the meantime.
  const menuToken = menu?.tokenId ? scene?.tokens.find((t) => t.id === menu.tokenId) : null;
  // And the pin a menu was opened on, read the same way and for the same
  // reason: it can be taken down while its menu is sitting there.
  const menuPin = menu?.pinId ? pins.find((p) => p.id === menu.pinId) : null;

  // The same for the hovered one: a tooltip left open while its token takes
  // damage should show the new number, not the one it opened on. A tooltip is
  // noise during a drag or a pan, and would sit on top of the right-click menu,
  // so those three states suppress it outright.
  const hoveredToken =
    hovered && !drag && !gesture && !menu
      ? scene?.tokens.find((t) => t.id === hovered.id)
      : null;

  function editToken() {
    if (!menuToken) return;
    setTokenForm({ token: menuToken });
    setMenu(null);
  }

  /**
   * Put this token on the clipboard.
   *
   * Nothing happens on the board and nothing is sent anywhere: copying is a
   * note to yourself about what to paste next. Only the id matters when the
   * paste finally happens - the rest of this snapshot is what the confirmation
   * dialog draws, so that choosing between two goblins is done by looking at
   * one rather than by remembering which was which.
   */
  function copyToken() {
    const token = menuToken;
    setMenu(null);
    if (!token) return;
    setClipboard({
      id: token.id,
      label: token.label,
      imageUrl: token.imageUrl,
      color: token.color,
      borderColor: token.borderColor,
      size: token.size,
      ownerId: token.ownerId,
      // Which family it belongs to, so the name the dialog promises is worked
      // out from the same lineage the server will use. A copy of a copy is
      // another copy of the original, not the start of something new.
      copyOf: token.copyOf || null,
    });
  }

  /**
   * How many copies of the clipboard's token this browser can see.
   *
   * The server counts this again when the paste lands, and its count is the one
   * that ends up in the name - it can see the whole campaign, including scenes
   * nobody here has opened and other people's benched tokens. This is the same
   * arithmetic over what is on screen, and it exists so the dialog can say what
   * the copy will be called instead of asking somebody to accept a name they
   * cannot see. The two agree in every ordinary case; where they don't, what
   * arrives is what the server decided.
   */
  const copyCount = useMemo(() => {
    if (!clipboard) return 0;
    const root = clipboard.copyOf || clipboard.id;
    // Once each: a creature standing on three maps is one member of the family,
    // and counting its figures would name the next paste "(Copy 4)" for a table
    // holding two goblins.
    const byId = new Map();
    for (const token of scenes.flatMap((s) => s.tokens || [])) byId.set(token.id, token);
    for (const token of roster) if (!byId.has(token.id)) byId.set(token.id, token);
    return [...byId.values()].filter((t) => t.copyOf === root).length;
  }, [clipboard, scenes, roster]);

  // What the next paste will be called: the original's name, and how many of
  // them there will be once it exists. Kept in step with copyLabelFor on the
  // server, which writes the name that actually arrives - two ideas of what the
  // brackets look like would have the dialog promising one thing and the board
  // showing another.
  const pasteName = useMemo(() => {
    if (!clipboard) return '';
    const base = String(clipboard.label ?? '').replace(/\s*\(Copy \d+\)$/, '').trim() || 'Token';
    const suffix = ` (Copy ${copyCount + 1})`;
    return `${base.slice(0, 60 - suffix.length)}${suffix}`;
  }, [clipboard, copyCount]);

  /** And the other half: another one of it, on the square that was clicked. */
  async function pasteToken() {
    const at = pasteAt;
    if (!at || !scene || !clipboard || pasting) return;
    setPasting(true);
    setPasteError('');
    try {
      const placed = await api.pasteToken(scene.id, clipboard.id, at.x, at.y);
      setScenes((prev) =>
        prev.map((s) => (s.id === scene.id ? { ...s, tokens: [...s.tokens, placed] } : s))
      );
      loadRoster();
      recordTokenPaste({
        sceneId: scene.id,
        sourceId: clipboard.id,
        token: placed,
        x: at.x,
        y: at.y,
      });
      // The clipboard stays loaded. Laying out four goblins is four
      // right-clicks, not four trips back to the first one.
      setPasteAt(null);
    } catch (e) {
      setPasteError(e.message);
      // The token behind the clipboard has been deleted since it was copied.
      // Nothing will ever paste from it again, so the item goes rather than
      // staying in the menu as an offer that cannot be kept.
      if (e.status === 404) setClipboard(null);
    } finally {
      setPasting(false);
    }
  }

  // Asking first, like every other delete in the app. The menu closes as the
  // dialog opens - leaving both on screen would be two things asking to be
  // answered about the same token.
  function askDeleteToken() {
    if (!menuToken) return;
    setConfirmDelete({ kind: 'token', id: menuToken.id, name: menuToken.label || 'Token' });
    setMenu(null);
  }

  /**
   * Take a token off the table without destroying it.
   *
   * The difference from Delete is the whole point: this one is reversible by
   * anybody who could have done it, tomorrow, on a different map. What comes
   * off keeps its name, its picture, its hit points and its owner, and waits on
   * the campaign's bench until somebody puts it back.
   */
  async function benchToken() {
    const token = menuToken;
    setMenu(null);
    if (!token || !scene) return;
    setError('');
    try {
      await api.benchToken(scene.id, token.id);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, tokens: s.tokens.filter((t) => t.id !== token.id) } : s
        )
      );
      loadRoster();
      recordTokenBench({ sceneId: scene.id, token });
    } catch (e) {
      setError(e.message);
    }
  }

  /** And back again, onto the square the right-click chose. */
  async function spawnFromBench(token) {
    const at = spawnAt;
    setSpawnAt(null);
    if (!at || !scene) return;
    setError('');
    try {
      const placed = await api.spawnToken(scene.id, token.id, at.x, at.y);
      setScenes((prev) =>
        prev.map((s) => (s.id === scene.id ? { ...s, tokens: [...s.tokens, placed] } : s))
      );
      loadRoster();
      recordTokenSpawn({ sceneId: scene.id, token: placed });
    } catch (e) {
      setError(e.message);
    }
  }

  /**
   * What this creature rolled - the one number about a token that belongs to
   * the person playing it rather than to the person running the table.
   *
   * Not wrapped in guard(): the dialog is open, and an error belongs in front
   * of whoever is still looking at it. Throwing is how it gets there.
   */
  async function saveInitiative(roll) {
    const token = initiativeFor;
    if (!token || !scene) return;
    const updated = await api.setInitiative(scene.id, token.id, roll);
    setScenes((prev) =>
      prev.map((s) =>
        s.id === scene.id
          ? { ...s, tokens: s.tokens.map((t) => (t.id === updated.id ? updated : t)) }
          : s
      )
    );
    const fields = ['initiative', 'initiativeDie', 'initiativeMod'];
    recordTokenEdit({
      sceneId: scene.id,
      tokenId: updated.id,
      label: updated.label,
      before: pick(token, fields),
      after: pick(updated, fields),
    });
  }

  async function removeToken(tokenId) {
    setError('');
    // Kept before it goes: putting it back means sending the whole token, and
    // in a moment there'll be nowhere left to read it from.
    const token = scene.tokens.find((t) => t.id === tokenId);
    try {
      await api.deleteToken(scene.id, tokenId);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, tokens: s.tokens.filter((t) => t.id !== tokenId) } : s
        )
      );
      if (token) recordTokenDelete({ sceneId: scene.id, token });
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  // --- turn mode ---

  /**
   * The order everyone reads off the tracker.
   *
   * The same rule the server applies when Next decides who acts (routes/
   * scenes.js `turnOrder`): highest initiative first, ties to the bigger
   * modifier, and a token without an initiative isn't in the fight at all. The
   * two are kept in step on purpose - if this list and that one disagreed, the
   * highlight would land somewhere Next never goes.
   */
  const order = useMemo(() => turnOrderOf(scene?.tokens), [scene?.tokens]);

  const turnMode = Boolean(scene?.turnMode);

  // Only while the list it comes from is on screen. Rows can be taken away
  // under the pointer - the fight ends, the window is folded - and no
  // mouseleave arrives to say so, which would strand the highlight on the map.
  const spotlitId = turnMode ? spotlight : null;

  function setOpacity(next) {
    setTurnsOpacity(next);
    try {
      localStorage.setItem(TURNS_OPACITY_KEY, String(next));
    } catch {
      // Private mode, or a full quota. It still fades; it just won't remember.
    }
  }

  // Folding the panel is remembered per browser, not per visit: leaving the
  // tab unmounts the map, and a panel that unfolded itself every time you came
  // back would not be much of a preference.
  function foldTools(next) {
    setToolsMin(next);
    try {
      localStorage.setItem(TOOLS_MIN_KEY, next ? '1' : '0');
    } catch {
      // Private mode, or a full quota. The panel still folds; it just won't
      // remember doing so, which is not worth an error in front of anyone.
    }
  }

  // The server answers with the whole scene; take its turn fields but keep our
  // own tokens, which may be mid-drag. Same trade the scene edits above make.
  const applyTurn = (updated) =>
    setScenes((prev) =>
      prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s))
    );

  function toggleTurnMode() {
    if (!scene) return;
    guard(async () => applyTurn(await api.setTurnMode(scene.id, !turnMode)));
  }

  function advanceTurn() {
    if (!scene) return;
    guard(async () => applyTurn(await api.nextTurn(scene.id)));
  }

  function onPointerDown(e, token) {
    if (e.button !== 0) return; // left button drags tokens; right pans the map
    // With a tool in hand the map is a drawing surface, not a board of pieces.
    // The stylesheet already stops tokens hearing this; so does this line, and
    // between them there is no arrangement where a stray press moves a figure
    // somebody meant to draw around.
    if (drawing) return;
    // Nor while measuring, and for a stronger reason: a ruler is used over a
    // board you are reading, so the press that was meant to mark a spot must
    // never turn out to have picked up the ogre standing on it.
    if (measuring) return;
    // Nor while pins are being placed: in that mode the hand is aimed at pins,
    // and a token dragged along the way would be a move nobody made on purpose.
    if (movingPins) return;
    // In somebody else's point of view the only creature that answers is the
    // one whose eyes are borrowed. Everything else on that board is scenery you
    // are looking at from where it stands.
    if (povTokenId && token.id !== povTokenId) return;
    if (!canMove(token)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { px, py } = pointerCell(e);
    // Remember where inside the token we grabbed it, so it doesn't jump.
    dragRef.current = {
      tokenId: token.id,
      grabX: px - token.x,
      grabY: py - token.y,
      x: token.x,
      y: token.y,
      size: token.size || 1,
      fromX: token.x, // where it started, for a refused drop
      fromY: token.y,
      lastEmit: 0,
      authorized: false,
    };
    setDrag({ tokenId: token.id, x: token.x, y: token.y });
    socket.emit('token:drag:start', { sceneId: scene.id, tokenId: token.id }, (ack) => {
      if (ack?.ok) {
        if (dragRef.current) dragRef.current.authorized = true;
      } else {
        // The server disagrees about who owns this - stop immediately.
        setError(ack?.error || 'You cannot move that token.');
        endDrag();
      }
    });
  }

  function onPointerMove(e) {
    // The leg being drawn follows the pointer, so the distance is readable
    // before the far end has been decided - which is most of what a ruler is
    // for. The cell centre rather than the pointer itself, so the number on
    // screen is the number the next click will commit.
    if (measuring) {
      const { px, py } = pointerCell(e);
      setMeasureAt(cellCentre(px, py));
      return;
    }
    if (onDrawMove(e)) return;
    const d = dragRef.current;
    if (!d) return;
    const { px, py } = pointerCell(e);
    // Held to the squares that exist, which on a nudged grid starts before
    // zero - see minCol/minRow. A token dragged onto the top row was otherwise
    // pinned to the row below it and snapped back on release.
    const x = clamp(px - d.grabX, minCol, maxCol);
    const y = clamp(py - d.grabY, minRow, maxRow);
    d.x = x;
    d.y = y;
    setDrag({ tokenId: d.tokenId, x, y });
    const now = performance.now();
    if (d.authorized && now - d.lastEmit > DRAG_EMIT_MS) {
      d.lastEmit = now;
      socket.emit('token:drag:move', { x, y });
    }
  }

  async function onPointerUp() {
    if (onDrawEnd()) return;
    const d = dragRef.current;
    if (!d) return;
    // Snap to the grid on drop - or don't, when there isn't one.
    const x = gridOn ? Math.round(d.x) : round2(d.x);
    const y = gridOn ? Math.round(d.y) : round2(d.y);
    const tokenId = d.tokenId;
    endDrag();

    // Nothing moved - don't spend a write on it.
    if (x === d.fromX && y === d.fromY) return;

    // Occupied: silently refuse. Clearing the drag above already returned the
    // token to its stored square, so the move simply doesn't happen - no
    // message needed, since the red outline already said so mid-drag.
    if (blockerAt(x, y, d.size, tokenId)) return;
    // Apply locally, then persist. The PUT re-checks ownership server-side, so
    // this is optimistic but not authoritative.
    setScenes((prev) =>
      prev.map((s) =>
        s.id === scene.id
          ? { ...s, tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, x, y } : t)) }
          : s
      )
    );
    try {
      await api.moveToken(scene.id, tokenId, x, y);
      recordTokenMove({
        sceneId: scene.id,
        tokenId,
        label: scene.tokens.find((t) => t.id === tokenId)?.label,
        from: { x: d.fromX, y: d.fromY },
        to: { x, y },
      });
    } catch (e) {
      // 409 means someone claimed the square between our check and our write.
      // Same outcome as our own check: the move just doesn't happen, quietly.
      if (e.status !== 409) setError(e.message);
      refresh(); // snap back to the truth
    }
  }

  // --- GM actions ---
  async function guard(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const newScene = () =>
    guard(async () => {
      const created = await api.createScene({ name: `Scene ${scenes.length + 1}` });
      setScenes((prev) => [...prev, created]);
      setActiveId(created.id);
    });

  // Called by the confirmation dialog, so a failure has to be thrown as well as
  // shown: the dialog stays open and says what happened rather than closing as
  // though the scene had gone.
  async function removeScene(goneId) {
    setError('');
    try {
      const i = scenes.findIndex((s) => s.id === goneId);
      await api.deleteScene(goneId);
      const remaining = scenes.filter((s) => s.id !== goneId);
      setScenes(remaining);
      // Step back to the scene above the one you just deleted rather than
      // dropping to an empty tabletop. Deleting the first scene leaves index 0,
      // which is now whatever used to be second; deleting the last one leaves
      // nothing to land on.
      setActiveId(remaining[Math.max(0, i - 1)]?.id || '');
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  const patchScene = (changes) =>
    guard(async () => {
      const fields = Object.keys(changes);
      // Read off the scene as this screen reads it, defaults filled in - an
      // older scene may never have stored a grid offset or a gridOn flag, and
      // "put back what was there" has to mean the value that was in force, not
      // the gap where it wasn't written down.
      const before = pick({ ...scene, gridOn, gridSize, gridOffsetX: gridOffX, gridOffsetY: gridOffY }, fields);
      const updated = await api.updateScene(scene.id, { ...scene, ...changes });
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s)));
      // A name field blurred without being touched is not an action, and an
      // undo that does nothing is worse than no undo at all.
      const after = pick(updated, fields);
      if (!matches(after, before)) recordSceneEdit({ sceneId: updated.id, before, after });
    });

  // Adopt a map: take the image's own dimensions as the scene's size, so the
  // grid slider has something fixed to be a ratio *of*.
  const setMap = (url) =>
    guard(async () => {
      const { width, height } = await imageSize(url);
      await patchScene({ imageUrl: url, width, height });
    });

  // --- grid settings ---
  const GRID_FIELDS = [
    'gridSize',
    'gridOffsetX',
    'gridOffsetY',
    'gridColor',
    'gridOpacity',
    'gridThickness',
    'gridContrast',
  ];
  // Whether the draft has anything in it worth saving. Drives the Save button,
  // so a window opened and closed again writes nothing and records no undo.
  const gridDirty = Boolean(gridDraft) && !matches(pick(gridDraft, GRID_FIELDS), sceneGrid);

  // Opening takes a copy of the scene as it stands; from then until Cancel or
  // Save, this person's map follows the copy and nobody else's changes at all.
  const openGridSettings = () => setGridDraft({ ...sceneGrid });
  const changeGrid = (changes) => setGridDraft((d) => (d ? { ...d, ...changes } : d));
  // Cancel is simply dropping the draft: nothing was written, so there is
  // nothing to put back beyond letting the scene speak for itself again.
  const cancelGridSettings = () => setGridDraft(null);

  /**
   * Put this scene in front of the table.
   *
   * One scene carries the flag and the server clears whichever had it, so this
   * is one call and not two. Every player's board follows at once - they have no
   * picker of their own - while the DM's own view stays where it is: setting the
   * table's scene is not the same act as looking at it, and a DM who has just
   * revealed the next map is usually still working on the one after.
   *
   * **Nothing is recorded, on purpose.** This is on the no-Ctrl+Z list; see
   * NEVER_UNDOABLE in sceneHistory.js for why an announcement to the whole
   * table is not something a stray keystroke should be able to take back. It
   * goes through its own endpoint rather than patchScene, so there is nothing
   * here that could record it even by accident - and the guard on the list
   * covers the case where somebody later changes that.
   */
  function showSceneToTable(target) {
    const chosen = target || scene;
    if (!chosen) return;
    guard(async () => {
      await api.selectScene(chosen.id);
      setScenes((prev) => prev.map((s) => ({ ...s, selected: s.id === chosen.id })));
    });
  }

  async function saveGridSettings() {
    if (!gridDraft || !scene) return;
    const before = pick(sceneGrid, GRID_FIELDS);
    const after = pick(gridDraft, GRID_FIELDS);
    try {
      const updated = await api.updateScene(scene.id, { ...scene, ...after });
      setScenes((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s))
      );
      // One entry for the whole sitting, whatever was fiddled with inside it.
      // Undo should put the grid back the way the table last saw it, not step
      // backwards through a tuning session nobody else witnessed.
      if (!matches(pick(updated, GRID_FIELDS), before)) {
        recordSceneEdit({ sceneId: updated.id, before, after: pick(updated, GRID_FIELDS) });
      }
      setGridDraft(null);
    } catch (e) {
      // The window stays open holding the draft: a failed save must not be a
      // silently discarded one.
      setError(e.message);
    }
  }

  /**
   * Make the token the modal describes, at the spot the menu chose.
   *
   * Deliberately not wrapped in guard(): the modal is showing, and an error
   * belongs in front of the person still looking at the form rather than in the
   * page-level banner behind it. Throwing is how it gets there.
   */
  async function submitToken({ label, color, borderColor, size, imageUrl, ...stats }) {
    if (!scene || !tokenForm) return;

    // Editing sends only what the form asked about. The server merges them onto
    // the stored token (routes/scenes.js), so where it stands and who owns it
    // survive an edit rather than being silently reset to the form's idea of
    // them. It also refuses a size that would grow the token into a neighbour,
    // which surfaces in the modal.
    if (tokenForm.token) {
      const asked = { label, color, borderColor, size, imageUrl, ...stats };
      const updated = await api.updateToken(scene.id, tokenForm.token.id, asked);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id
            ? { ...s, tokens: s.tokens.map((t) => (t.id === updated.id ? updated : t)) }
            : s
        )
      );
      // Only the fields the form asked about, and read back off the server's
      // answer rather than off the form: it settles some of them itself - hit
      // points from a total, an initiative from its die and modifier - and an
      // undo has to put back what was stored, not what was typed.
      const fields = Object.keys(asked);
      recordTokenEdit({
        sceneId: scene.id,
        tokenId: updated.id,
        label: updated.label,
        before: pick(tokenForm.token, fields),
        after: pick(updated, fields),
      });
      return;
    }

    const token = await api.addToken(scene.id, {
      label,
      color,
      borderColor,
      size,
      imageUrl,
      // `stats` carries the owner the form chose. It used to be overwritten
      // with null here, which is why nothing in the app could hand a token to
      // anybody - every permission check behind it worked, and nothing ever
      // set the field they all read.
      ...stats,
      x: tokenForm.x,
      y: tokenForm.y,
    });
    setScenes((prev) =>
      prev.map((s) => (s.id === scene.id ? { ...s, tokens: [...s.tokens, token] } : s))
    );
    // The server's copy, not the form's: it may have slid the token to the next
    // free cell, and that's where undo has to know it went.
    recordTokenAdd({ sceneId: scene.id, token });
  }


  // --- render ---
  // Reachable only when there are genuinely no scenes: any scene at all now
  // resolves above.
  if (!scene) {
    return (
      <div className="tabletop-empty">
        <p>No scene yet.</p>
        {isDm && !offline && (
          <button onClick={newScene} disabled={busy}>
            + Create a scene
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  // Sized from the map, not the grid - the whole point of the ratio slider.
  const width = mapW * zoom;
  const height = mapH * zoom;

  /**
   * What the confirmation dialog says, by the thing it's asking about.
   *
   * A lookup rather than a run of ternaries: there are three of these now and
   * each wants its own heading, its own warning and its own button. The
   * warnings differ in kind, not just in wording - a scene is gone for good,
   * where a token or a board of shapes is one Ctrl+Z from coming back.
   */
  const CONFIRM = {
    scene: {
      description:
        'This deletes the scene, its map and every token standing on it, for everyone at the table. It cannot be undone.',
      confirmLabel: 'Delete scene',
      run: () => removeScene(confirmDelete.id),
    },
    token: {
      /**
       * Deleting is deleting the creature, not the figure in front of you.
       *
       * One token can stand on several maps at once now, so the sentence names
       * the others when there are any: taking the innkeeper off the town square
       * with this would take it out of the tavern as well, and that is worth
       * knowing before rather than after. Remove from table is the reversible
       * one, and it only ever touches this map.
       */
      description: (() => {
        // This object is built on every render, dialog or no dialog, so the
        // question it is about may not have been asked yet.
        if (!confirmDelete) return '';
        const elsewhere = (
          roster.find((t) => t.id === confirmDelete.id)?.scenes || []
        ).filter((where) => where.id !== selectedId);
        if (!elsewhere.length) return 'This takes the token off the map for everyone at the table.';
        const names = elsewhere.map((where) => where.name);
        const list =
          names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        return `This deletes the creature everywhere it stands, which is this map and ${list}. To take it off this one only, choose Remove from table instead.`;
      })(),
      confirmLabel: 'Delete token',
      run: () => removeToken(confirmDelete.id),
    },
    pin: {
      description:
        'This takes the pin off the map for everyone it was shared with, and what is written on it goes with it. It cannot be undone.',
      confirmLabel: 'Delete pin',
      run: () => removePin(confirmDelete.id),
    },
    shapes: {
      title: `Delete ${clearableShapes.length} shape${clearableShapes.length === 1 ? '' : 's'}?`,
      description: isDm
        ? 'This clears every shape on this scene, whoever drew it, for everyone at the table. Ctrl+Z puts them all back.'
        : 'This clears every shape you drew on this scene. Anything drawn by somebody else stays where it is. Ctrl+Z puts yours back.',
      confirmLabel: 'Delete all shapes',
      run: clearShapes,
    },
  };
  const asking = confirmDelete ? CONFIRM[confirmDelete.kind] : null;

  return (
    <div className="tabletop">
      <div className="scene-bar">
        {/* The DM's alone, and not merely disabled for everybody else: a picker
            a player cannot use is a list of the scenes they are not being shown,
            which is half of what the DM has not told them yet. They see the
            scene the table is on and no way to ask for another.

            Held still while pins are being placed, along with everything else
            outside the map: changing scene mid-move would leave the staged
            positions describing a board nobody is looking at. */}
        {isDm && (
          <select
            value={selectedId}
            disabled={movingPins}
            onChange={(e) => setActiveId(e.target.value)}
          >
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.selected ? ' · shown to players' : ''}
              </option>
            ))}
          </select>
        )}

        {/* Zoom is a plain label again. It used to be a button that pointed
            the wheel at this bar rather than at the grid gauge beside it; the
            gauge has moved into Grid settings, which arms the wheel by being
            open, so there is nothing left to choose between. */}
        <label className="zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={zoom}
            aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            title="Scroll over the map to zoom"
          />
          <small>{Math.round(zoom * 100)}%</small>
        </label>

        {isDm && !offline && (
          <>
            {/* Two things, and only two. Whether there is a grid, which the
                whole table sees the moment it is pressed; and a way in to what
                it looks like, which is the DM's to settle in private. The cell
                size and the cell count moved into that window, where the rest
                of the grid's settings now live. */}
            <div className="zoom grid-ratio">
              <label htmlFor="grid-on">Show grid</label>
              <input
                id="grid-on"
                type="checkbox"
                checked={gridOn}
                disabled={movingPins}
                onChange={(e) => patchScene({ gridOn: e.target.checked })}
                title="Show the grid and snap tokens to it"
              />
              <button
                type="button"
                onClick={openGridSettings}
                aria-pressed={Boolean(gridDraft)}
                className={gridDraft ? 'active' : ''}
                // Held still while a drawing tool is in hand or the ruler is
                // out: setting a grid up needs the right-drag and the wheel,
                // and in those modes both are already spoken for.
                disabled={drawing || measuring || movingPins}
                title={
                  drawing
                    ? 'Put the drawing tool down to retune the grid'
                    : measuring
                      ? 'Leave measuring mode to retune the grid'
                      : movingPins
                        ? 'Finish moving the pins to retune the grid'
                        : 'Size, colour, thickness and opacity of the grid'
                }
              >
                Grid settings
              </button>
            </div>

            {/* One button where six controls used to sit. Naming the scene,
                choosing its picture, making one and throwing one away are all
                things done between sessions rather than during them, and they
                were being read past all game to reach the three that aren't.
                See SceneManager.jsx. */}
            <button
              onClick={() => setManaging(true)}
              disabled={busy || movingPins}
              title="Scenes, their backgrounds, and your images"
            >
              Scene Manager
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {/* The bar that says the map is being rearranged, and the only two ways
          out of it. Fixed to the top of the window rather than sitting in this
          column: everything else on screen is greyed out behind it, and the one
          live thing in a still page belongs where the eye goes first. */}
      {movingPins && (
        <div className="pins-move-bar" role="dialog" aria-label="Moving pins">
          <strong>Moving pins</strong>
          <span className="hint">
            Drag your own pins where you want them. Right-drag still moves the view, the wheel
            still zooms, and Ctrl+Z takes back the last move.
          </span>
          <button type="button" onClick={stopMovingPins} disabled={savingPins}>
            Cancel movements
          </button>
          <button type="button" className="confirm" onClick={confirmPinMoves} disabled={savingPins}>
            {savingPins ? 'Saving…' : 'Confirm movements'}
          </button>
        </div>
      )}

      {/* Wraps the scroller so the tools panel can be pinned to the map's own
          top-left corner. Inside the scroller it would be pinned to the *map*
          and slide away with it; outside this wrapper there is nothing to
          measure against but the whole column, and the bar above it is a row
          whose height changes as it wraps. */}
      <div className="map-area">
        <div
          className={`surface-scroll${gesture === 'pan' ? ' panning' : ''}${gesture === 'grid' ? ' nudging' : ''
            }`}
          ref={scrollRef}
          onPointerDown={onPanStart}
          onPointerMove={onPanMove}
          onPointerUp={onPanEnd}
          onPointerCancel={onPanEnd}
          onContextMenu={onContextMenu}
        >
          <div
            className={`surface${drawing ? ' drawing' : ''}${measuring ? ' measuring' : ''}${movingPins ? ' moving-pins' : ''
              }`}
            ref={surfaceRef}
            // A pointer that leaves the map has no cell to be in, so the leg in
            // flight stops following it rather than freezing at the edge.
            onPointerLeave={() => setMeasureAt(null)}
            // Focusable on purpose but never in the tab order: it's here so a
            // press on the map can hand it the keyboard, not so that tabbing
            // through the page stops on the picture.
            tabIndex={-1}
            style={{
              width,
              height,
              backgroundImage: scene.imageUrl ? `url(${scene.imageUrl})` : 'none',
              '--cell': `${cellPx}px`,
              // Only the grid reads these. The map's own background is placed by
              // the stylesheet and stays where it is while they change.
              '--grid-x': `${offXPx}px`,
              '--grid-y': `${offYPx}px`,
              '--grid-ink': grid.gridColor,
              '--grid-alpha': grid.gridOpacity / 100,
              // The lines keep their width on screen rather than growing with the
              // map: a two-pixel grid line is a choice about how the grid reads,
              // not a distance across the ground.
              '--grid-line': `${grid.gridThickness}px`,
            }}
            onPointerDown={onDrawStart}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* The drawing layer, under the grid and under the tokens: a shape
              marks out ground, and ground is the thing everything else stands
              on. In map pixels via the viewBox, so one set of numbers is right
              at every zoom - and the strokes are told not to scale with it, or
              zooming out would thin every outline into nothing. */}
            <svg
              className="shape-layer"
              width={width}
              height={height}
              viewBox={`0 0 ${mapW} ${mapH}`}
              aria-hidden="true"
            >
              {shapes.map((s) => {
                // The one under the hand is drawn from the gesture instead, so it
                // isn't painted twice while it moves.
                if (sketch?.id === s.id) return null;
                return (
                  <ShapeMark
                    key={s.id}
                    shape={s}
                    cell={gridSize}
                    origin={{ x: gridOffX, y: gridOffY }}
                    zoom={zoom}
                    selected={s.id === selectedShapeId}
                  />
                );
              })}
              {sketch && (
                <ShapeMark
                  shape={sketch}
                  cell={gridSize}
                  origin={{ x: gridOffX, y: gridOffY }}
                  zoom={zoom}
                  sketching
                />
              )}
              {/* The polygon being clicked out: the outline so far, and a dot on
                  every corner. Drawn from the corners rather than through
                  ShapeMark because it is not a shape yet - it has no id, may be
                  a single point, and wants its corners shown, which no finished
                  shape does. */}
              {polyPoints?.length > 0 && (
                <PolygonSketch
                  points={polyPoints}
                  cell={gridSize}
                  origin={{ x: gridOffX, y: gridOffY }}
                  zoom={zoom}
                  style={shapeStyle}
                />
              )}
            </svg>

            {/* Borrowed while a ruler is on the board, whoever's it is - see
              gridShown. The scene's own setting is untouched.

              Drawn for the DM while Grid settings is open even with Show grid
              off: they are looking at what they are tuning. Everyone else still
              sees nothing until the checkbox is on, which is the promise the
              window makes. */}
            {(gridShown || gridDraft) && (
              <div className={`grid-overlay${grid.gridContrast ? ' adaptive-contrast' : ''}`} />
            )}

            {/* Inside the surface, so a ping sits at its map position and stays
              there through panning and zooming rather than at a point on glass. */}
            {pings.map((p) => (
              <div
                key={p.id}
                className="ping"
                style={{ left: p.x * zoom, top: p.y * zoom, '--ping': p.color }}
                title={p.by ? `${p.by} pinged here` : 'ping'}
              >
                <span />
                <span />
                <span />
              </div>
            ))}

            {scene.tokens.map((token) => {
              const mine = drag?.tokenId === token.id ? drag : null;
              const ghost = ghosts[token.id];
              const pos = mine || ghost || token;
              // What the plate says, and which side of the token it goes on.
              // Two independent offers that share one plate: the name, and the
              // condition in brackets after it. Asking for neither is the usual
              // case and costs nothing beyond this line.
              // A token the players cannot see. Only ever true on the DM's own
              // screen: the others were never sent it (see canSeeToken on the
              // server), so there is nothing here for them to draw.
              const hidden = token.visible === false;
              const plated = token.showNameplate || token.showStatus || hidden;
              const plate = plated ? plateSide(token, pos, tokensNow, minRow, maxRow) : null;
              const movable = canMove(token);
              // Whose token this is. A token can name somebody who has since left
              // the table, and an owner nobody can find is drawn as no owner at
              // all rather than as a blank pip nobody can explain.
              const owner = token.ownerId ? players.find((p) => p.id === token.ownerId) : null;
              // Warn while dragging over a square that's already taken, so the
              // refusal isn't a surprise at the moment of release.
              const blocked =
                mine &&
                Boolean(
                  blockerAt(
                    gridOn ? Math.round(mine.x) : mine.x,
                    gridOn ? Math.round(mine.y) : mine.y,
                    token.size || 1,
                    token.id
                  )
                );
              return (
                <div
                  key={token.id}
                  // Read back by the right-click handler: the event knows which
                  // element was hit, not which token that element stands for.
                  data-token-id={token.id}
                  // No 'own' class any more: the ring it drew inside your own
                  // tokens read as an unasked-for white border, and as a second
                  // border inside whichever one the DM had chosen. The pip below
                  // says whose a token is, and on yours it is your own colour.
                  className={`token${movable ? ' movable' : ''}${mine ? ' dragging' : ''}${blocked ? ' blocked' : ''
                    }${ghost && !mine ? ' remote' : ''}${token.id === spotlitId ? ' spotlit' : ''}`}
                  style={{
                    // Tokens ride the grid rather than the picture: a token in a
                    // cell stays in that cell when the grid is moved onto the one
                    // drawn on the map.
                    left: offXPx + pos.x * cellPx,
                    top: offYPx + pos.y * cellPx,
                    width: token.size * cellPx,
                    height: token.size * cellPx,
                    // A picture replaces the fill, not just the name - cover so a
                    // portrait of any shape fills the circle without distorting.
                    background: token.imageUrl
                      ? `center / cover no-repeat url(${JSON.stringify(token.imageUrl)})`
                      : token.color,
                    // Left off entirely when unset, so the stylesheet's dark ring
                    // stays the default rather than being overridden with it.
                    ...(token.borderColor ? { borderColor: token.borderColor } : {}),
                  }}
                  onPointerDown={(e) => onPointerDown(e, token)}
                  // No `title`: the tooltip below says all of this and more, and
                  // the browser's own bubble would surface underneath it.
                  onMouseEnter={(e) => setHovered({ id: token.id, el: e.currentTarget })}
                  onMouseLeave={() => setHovered((h) => (h?.id === token.id ? null : h))}
                >
                  {/* The picture stands in for the name. Printing both would put
                    text over a face at the size a token actually is. */}
                  {!token.imageUrl && <span className="token-label">{token.label}</span>}

                  {/* The plate: what this token says about itself without being
                      pointed at. The name, the condition in brackets, or both,
                      in that order - a reader who has both is reading a name
                      first and a note about it second.

                      Sized in pixels rather than as a fraction of the token, so
                      it stays readable when the map is zoomed out, which is
                      exactly when a board full of similar-looking figures needs
                      its labels most. */}
                  {plate && (
                    <span className={`token-plate ${plate}`}>
                      {/* First, and on its own when nothing else asked for a
                          plate: a token nobody else can see says so whether or
                          not it is captioned. */}
                      {hidden && <HiddenEye />}
                      {hidden && token.showNameplate ? ' ' : ''}
                      {token.showNameplate && token.label}
                      {token.showStatus && (
                        <span className="token-plate-status">
                          {/* Spaced off whatever is in front of it - the name,
                              or the hidden mark when there is no name. Alone,
                              it is the whole plate and needs no gap. */}
                          {token.showNameplate || hidden ? ' ' : ''}[{token.status || 'Normal'}]
                        </span>
                      )}
                    </span>
                  )}

                  {/* Whose it is, in their own colour - the same colour that
                    names them in the chat and marks them in the roster, so the
                    map can be read against either without learning a third
                    thing. A pip rather than a border: `borderColor` is already
                    the DM's to choose per token, and ownership must not quietly
                    overrule a decision somebody made about how a token looks. */}
                  {owner && (
                    <span
                      className="token-owner"
                      style={{ background: owner.color }}
                      title={`${owner.name}'s token`}
                    />
                  )}
                </div>
              );
            })}

            {/* The pins, over the tokens: a pin is stuck in the map in front of
              everything standing on it, and one hidden behind an ogre would be
              a pin nobody could click. Only while they are being shown, and
              only the ones this browser was told about - the rest were filtered
              out by the server and are not here to draw.

              Inert while drawing or measuring, like the board itself: those two
              modes take the map over, and a press meant for a shape must not
              turn out to have opened somebody's note. They stay visible; they
              just aren't yours to touch for the moment. */}
            {showPins &&
              pins.map((pin) => {
                const spot = pinSpot(pin);
                const side = pinLabelSide({ id: pin.id, ...spot }, pinsNow, zoom);
                const mine = canEditPin(pin);
                // Being placed right now: the one under the hand, and the ones
                // it is standing beside waiting their turn.
                const dragging = pinDragRef.current?.id === pin.id;
                return (
                  <div
                    key={pin.id}
                    // Read back by the right-click handler, which knows which
                    // element was hit rather than which pin it stands for.
                    data-pin-id={pin.id}
                    className={`map-pin${drawing || measuring ? ' inert' : ''}${openPinIds.includes(pin.id) ? ' open' : ''
                      }${movingPins ? (mine ? ' draggable' : ' locked') : ''}${dragging ? ' dragging' : ''}`}
                    style={{ left: spot.x * zoom, top: spot.y * zoom }}
                    title={
                      movingPins
                        ? mine
                          ? `Drag ${pin.title} where you want it`
                          : `${pin.title} - only the person who stuck it in can move it`
                        : mine
                          ? `${pin.title} - right-click to edit`
                          : pin.title
                    }
                    // In the mode a press picks the pin up. Outside it, the
                    // press is stopped from reaching the map - which would read
                    // it as the start of a pan - and the click below opens the
                    // card.
                    onPointerDown={(e) =>
                      movingPins ? onPinDragStart(e, pin) : e.stopPropagation()
                    }
                    onPointerMove={movingPins ? onPinDragMove : undefined}
                    onPointerUp={movingPins ? onPinDragEnd : undefined}
                    onPointerCancel={movingPins ? onPinDragEnd : undefined}
                    // No card while placing: the press is a hand on the pin, and
                    // a note that opened every time you moved one would be a
                    // note in the way of the next move.
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!movingPins) openPin(pin.id);
                    }}
                  >
                    <PinIcon color={pin.color || '#e5534b'} />
                    <span className={`map-pin-label ${side}`}>{pin.title}</span>
                  </div>
                );
              })}

            {/* The dark, over everything on the board.

              Two layers, and the order matters. Underneath, the grey: it
              covers everything outside the sharp circle and drains the colour
              from what shows through it, which is what "you can make it out,
              but only just" looks like. On top, the black: it covers everything
              outside the wider circle, and being opaque it hides the grey
              wherever both apply.

              So a pixel is normal inside the first circle, grey between the
              two, and black beyond - out of two layers and no arithmetic about
              rings. Neither takes the pointer: what you cannot see you cannot
              click, and the tokens under here were never sent to you anyway. */}
            {fogLight?.clear && <div className="fog-layer fog-dim" style={fogLight.clear} />}
            {fogLight?.dim && <div className="fog-layer fog-dark" style={fogLight.dim} />}

            {/* The ruler, over everything.

              Above the tokens rather than under them, unlike the drawing layer:
              a shape is ground that things stand on, but a measurement is a
              question about the things themselves, and one whose answer
              disappears behind the very ogre you were measuring to is no
              answer. Untouchable by the pointer - the right-click menu works
              out what was hit from the coordinates instead (see onContextMenu),
              which is the only way a line two pixels wide can be aimed at. */}
            {(measurements.length > 0 || remoteRulers.length > 0) && (
              <svg
                className="measure-layer"
                width={width}
                height={height}
                viewBox={`0 0 ${mapW} ${mapH}`}
                aria-hidden="true"
              >
                {/* Other people's first, so yours is the one on top: it is the one
                  you are working on, and the one your own right-click will
                  find. */}
                {remoteRulers.map((ruler) =>
                  ruler.measurements.map((chain) => (
                    <MeasureMark
                      key={`${ruler.by}-${chain.id}`}
                      chain={chain}
                      cell={gridSize}
                      origin={{ x: gridOffX, y: gridOffY }}
                      zoom={zoom}
                      // All four as the measurer set them, so their ruler reads
                      // here the way it reads for them. Thickness has a fallback
                      // because a client on the old version sends none, and a
                      // ruler with no width at all is an invisible one.
                      color={ruler.color}
                      thickness={ruler.thickness || 2}
                      unit={ruler.unit}
                      perCell={ruler.perCell}
                      movement={ruler.movement}
                    />
                  ))
                )}
                {measurements.map((chain) => (
                  <MeasureMark
                    key={chain.id}
                    chain={chain}
                    cell={gridSize}
                    origin={{ x: gridOffX, y: gridOffY }}
                    zoom={zoom}
                    color={rulerColor}
                    thickness={measureSetup.thickness}
                    unit={measureSetup.unit}
                    perCell={measureSetup.perCell}
                    movement={measureSetup.movement}
                    // Only the chain still open follows the pointer, and only
                    // while the pointer is over the map.
                    pending={chain.id === openChainId ? measureAt : null}
                  />
                ))}
              </svg>
            )}
          </div>
        </div>

        {/* Whose eyes the DM has borrowed, and the way back out.
            Over the board, at the top and centred on it - not on the window,
            which would put it over the chat down the side. What it says is
            about the map underneath it, so that is what it is measured
            against. */}
        {povToken && (
          <div className="fog-pov-bar" role="dialog" aria-label="Point of view">
            <span className="hint">You are seeing the board as</span>
            <span className="fog-pov-token">
              <span
                className="fog-swatch"
                style={{
                  background: povToken.imageUrl
                    ? `center / cover no-repeat url(${JSON.stringify(povToken.imageUrl)})`
                    : povToken.color,
                }}
              />
              <strong>{povToken.label || 'Token'}</strong>
            </span>
            <button type="button" onClick={exitPov} title="Escape does this too">
              Exit POV
            </button>
          </div>
        )}

        {/* Floats over the map rather than taking a strip of it. Everyone gets
            the panel; what's inside it is another question, and for now the
            only answer is the DM's. */}
        {toolsMin ? (
          <div className="map-tools map-tools-min">
            <button
              type="button"
              onClick={() => foldTools(false)}
              aria-label="Show map tools"
              title="Map tools"
            >
              ☰
            </button>
          </div>
        ) : (
          <div className="map-tools">
            <div className="map-tools-head">
              <strong>Tools</strong>
              <button
                type="button"
                className="linky"
                onClick={() => foldTools(true)}
                aria-label="Minimise"
                title="Minimise"
              >
                <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                  <line x1="0.5" y1="5" x2="9.5" y2="5" />
                </svg>
              </button>
            </div>
            <div className="map-tools-body">
              {/* Every button in the panel is held still while pins are being
                  placed. The stylesheet greys the panel too; this is what stops
                  a keyboard reaching them behind it. */}
              {isDm && (
                <button onClick={toggleTurnMode} disabled={busy || movingPins || Boolean(povTokenId)}>
                  {turnMode ? 'Exit Turn mode' : 'Enter Turn mode'}
                </button>
              )}
              {/* Not the DM's alone: marking where a spell lands, or where you
                  mean to run, is the same kind of thing as moving your own
                  token. What you drew stays yours to change. */}
              {canDraw && (
                <button
                  onClick={() => {
                    // The two modes are exclusive: each one takes the map over,
                    // and a board that was both a drawing surface and a ruler
                    // would have to guess what a click meant.
                    setMeasureWindow(false);
                    setShapeWindow((open) => !open);
                  }}
                  aria-pressed={shapeWindow}
                  className={shapeWindow ? 'active' : ''}
                  disabled={movingPins || Boolean(povTokenId)}
                >
                  {shapeWindow ? 'Standard mode' : 'Draw mode'}
                </button>
              )}
              {/* Everybody's, including a spectator's. Measuring changes
                  nothing and is sent nowhere unless you tick Shared, so there
                  is no permission it could need - and "how far is that?" is a
                  question the person who *isn't* running the fight asks most. */}
              <button
                onClick={() => {
                  setShapeTool(null);
                  setShapeWindow(false);
                  setMeasureWindow((open) => !open);
                }}
                aria-pressed={measureWindow}
                className={measureWindow ? 'active' : ''}
                disabled={movingPins || Boolean(povTokenId)}
              >
                {measureWindow ? 'Standard mode' : 'Measuring mode'}
              </button>
              {/* Everybody's too, and not a mode: it takes nothing away from
                  the map, so it can be left on while you play. Under the ruler
                  because it is the one button here that changes what you can
                  see rather than what a click does. */}
              <button
                onClick={togglePins}
                aria-pressed={showPins}
                className={showPins ? 'active' : ''}
                // Putting the pins away in the middle of arranging them would
                // take the map out from under the mode.
                disabled={movingPins || Boolean(povTokenId)}
              >
                {showPins ? 'Hide pins' : 'Show pins'}
              </button>
              {/* The DM's alone. Everything behind it - who sees how far, and
                  whether the lights are out - is a decision about what the rest
                  of the table is allowed to know. */}
              {isDm && (
                <button
                  onClick={() => setFogWindow(true)}
                  aria-pressed={fogActive}
                  className={fogActive ? 'active' : ''}
                  disabled={offline || movingPins || Boolean(povTokenId)}
                  title="Who sees how far, and whether the lights are out"
                >
                  Fog of War{fogActive ? ' (on)' : ''}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The drawing box. Yours alone - unlike the turn tracker, which is the
          table's, this one only says what *your* pointer is about to do. */}
      {shapeWindow && canDraw && (
        <ShapeTools
          tool={shapeTool}
          onTool={setShapeTool}
          style={shapeStyle}
          onStyle={(changes) => setShapeStyle((s) => ({ ...s, ...changes }))}
          selected={selectedShape}
          canEditSelected={canEditShape(selectedShape)}
          onEditSelected={(changes) => editShape(selectedShapeId, changes)}
          onDeleteSelected={() => eraseShape(selectedShapeId)}
          // How many are yours to clear. None, and the button isn't drawn.
          clearable={clearableShapes.length}
          onClearAll={() => setConfirmDelete({ kind: 'shapes' })}
          onClose={() => {
            // Putting the box away puts the tool down with it. Leaving drawing
            // mode on with nothing on screen to say so is how you end up
            // scribbling on the map while trying to move a token.
            setShapeTool(null);
            setShapeWindow(false);
          }}
          offline={offline}
        />
      )}

      {/* The scene bench: every scene, this one's name and picture, and the
          campaign's own folders full of maps. The DM's alone, and closed while
          the server is unreachable - everything in it is a write. */}
      {managing && isDm && !offline && scene && (
        <SceneManager
          scenes={scenes}
          activeId={selectedId}
          scene={scene}
          maps={maps}
          busy={busy}
          onSelect={setActiveId}
          onShowToTable={showSceneToTable}
          onRename={(name) => name !== scene.name && patchScene({ name })}
          onCreate={newScene}
          onDelete={(doomed) =>
            setConfirmDelete({
              kind: 'scene',
              id: doomed.id,
              name: doomed.name || 'this scene',
            })
          }
          onUse={setMap}
          onClose={() => setManaging(false)}
        />
      )}

      {/* Grid settings, the DM's alone and previewed on their map only. The
          draft's existence is what opens it, so there is no separate flag that
          could disagree with whether there is anything to edit. */}
      {gridDraft && canTuneGrid && (
        <GridSettings
          draft={gridDraft}
          cols={cols}
          rows={rows}
          sizeMin={GRID_MIN}
          sizeMax={GRID_MAX}
          dirty={gridDirty}
          onChange={changeGrid}
          onCancel={cancelGridSettings}
          onSave={saveGridSettings}
        />
      )}

      {/* The measuring box. Yours alone even when the ruler isn't: what it
          holds is how *you* are reading the board, and Shared decides only
          whether the lines are on anybody else's. */}
      {measureWindow && (
        <MeasureTools
          unit={measureSetup.unit}
          perCell={measureSetup.perCell}
          // A change of unit brings that unit's own default with it - see the
          // note in the panel. Keeping the old number would quietly reinterpret
          // it, and the field that would say so is the one being changed.
          onUnit={(unit) =>
            // Spread, not replaced: the colour, the thickness and the counting
            // rule are nothing to do with which unit the numbers are said in,
            // and a change of unit that quietly reset them would be three
            // settings undone by touching a fourth.
            setMeasureSetup((s) => ({ ...s, unit, perCell: unitNamed(unit).perCell }))
          }
          onPerCell={(perCell) =>
            setMeasureSetup((s) => ({ ...s, perCell: Number.isFinite(perCell) ? perCell : 1 }))
          }
          color={rulerColor}
          onColor={(color) => setMeasureSetup((s) => ({ ...s, color }))}
          thickness={measureSetup.thickness}
          onThickness={(thickness) =>
            setMeasureSetup((s) => ({
              ...s,
              // Clamped rather than refused: a field somebody has typed 40 into
              // wants a line as thick as this map can sensibly draw, not the
              // last valid number silently put back.
              thickness: Number.isFinite(thickness)
                ? clamp(thickness, MEASURE_THICK_MIN, MEASURE_THICK_MAX)
                : 2,
            }))
          }
          thicknessMin={MEASURE_THICK_MIN}
          thicknessMax={MEASURE_THICK_MAX}
          movement={measureSetup.movement}
          onMovement={(movement) => setMeasureSetup((s) => ({ ...s, movement }))}
          shared={measureShared}
          onShared={setMeasureShared}
          total={measuredCells}
          chains={measurements.length}
          onClearAll={deleteAllMeasurements}
          onClose={() => setMeasureWindow(false)}
          offline={offline}
        />
      )}

      {/* One tracker, shown to the whole table while the fight is on. Only the
          DM can put it away, and doing so is what ends turn mode - so a player
          gets no close button rather than one that betrays them. */}
      {turnMode && (
        <FloatingWindow
          title="Turns"
          storageKey="rpg:turns-window"
          defaultSize={{ w: 380, h: 420 }}
          minSize={TURNS_MIN}
          onClose={isDm ? toggleTurnMode : undefined}
          opacity={turnsOpacity / 100}
          onOpacityChange={setOpacity}
          // The window draws the opacity slider itself, beside the title. All
          // this adds is the spacer that sends the window's own two buttons to
          // the far end of the bar, as the sheet and note windows do.
          controls={<div className="spacer" />}
        >
          <div className="turns">
            {order.length === 0 ? (
              <p className="hint">
                No token on this scene has an initiative score, so there is nobody to put in
                order yet. Give one a score from its right-click menu.
              </p>
            ) : (
              <ol className="turn-list" onMouseLeave={() => setSpotlight(null)}>
                {order.map((t) => {
                  // The same reading the hover tooltip makes, from the same
                  // helper, so one creature cannot look different depending on
                  // which of the two you happen to be looking at.
                  const bar = hpBar(t.hp, t.maxHp, t.tempHp, t.nonLethalHp);
                  return (
                    // A menu of its own rather than an action on the click: the
                    // list is a thing you read during a fight, and every camera
                    // at the table swinging across the map is too much to hang on
                    // brushing against it. Anyone may ask for it, DM or not - it
                    // is the same Focus the map's own menu offers, and that has
                    // never been the DM's alone.
                    <li
                      key={t.id}
                      className={t.id === scene.turnTokenId ? 'active' : ''}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ clientX: e.clientX, clientY: e.clientY, turnTokenId: t.id });
                      }}
                      title={`Right-click for ${t.label}`}
                      onMouseEnter={() => setSpotlight(t.id)}
                      onMouseLeave={() => setSpotlight((id) => (id === t.id ? null : id))}
                    >
                      {/* The token as it looks on the board, so the list is read
                        by glancing between the two rather than by name. */}
                      <span
                        className="turn-face"
                        style={{
                          background: t.imageUrl
                            ? `center / cover no-repeat url(${JSON.stringify(t.imageUrl)})`
                            : t.color,
                          ...(t.borderColor ? { borderColor: t.borderColor } : {}),
                        }}
                      />
                      <span className="turn-who">
                        <strong>{t.label}</strong>
                        {/* Hit points stay the DM's to know, exactly as they do in
                          the hover tooltip - a tracker every player can see is
                          the last place to print the ogre's remaining health. */}
                        {isDm && bar && (
                          <span className="turn-hp">
                            <HpBar bar={bar} />
                            <small>
                              {bar.current}/{bar.total}
                              {/* Kept out of the fraction: temporary points are
                                  not part of the total, and "17/20" for a
                                  creature on 12 with 5 of them would be a
                                  number that is simply not true. */}
                              {bar.temp > 0 && (
                                <b className="hp-temp-text"> +{bar.temp}</b>
                              )}
                              {/* Out cold gets the word; short of that, the
                                  bar alone says how close it is. A line in a
                                  fight has room for one more thing, and this is
                                  the one worth knowing at a glance. */}
                              {bar.out && <b className="hp-out-text"> out</b>}
                            </small>
                          </span>
                        )}
                      </span>
                      <span className="turn-init">
                        {initiativeText(t).total}
                        {initiativeText(t).breakdown && (
                          <small>({initiativeText(t).breakdown})</small>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            {isDm && (
              <div className="turns-foot">
                <button onClick={advanceTurn} disabled={busy || order.length === 0}>
                  Next
                </button>
              </div>
            )}
          </div>
        </FloatingWindow>
      )}

      {hoveredToken && (
        <TokenTooltip
          anchor={hovered.el}
          token={hoveredToken}
          // The whole sheet, not just its attacks: what "+1 to hit" comes to
          // depends on the character's abilities, which are on the sheet.
          sheet={sheetFor(hoveredToken)}
          owner={
            hoveredToken.ownerId ? players.find((p) => p.id === hoveredToken.ownerId) : null
          }
          showHp={isDm}
          // Renamed from `status`, which now means the condition the token is
          // under. This one is a live note about the token rather than a fact
          // about it.
          note={
            ghosts[hoveredToken.id]
              ? `Being moved by ${ghosts[hoveredToken.id].by}`
              : ''
          }
        />
      )}

      {menu && (
        <div className="map-menu" ref={menuRef} style={{ left: menu.clientX, top: menu.clientY }}>
          {menu.moving ? (
            /* The whole menu while pins are being placed. Both items are about
               your own hand in this sitting: nothing else on the map is yours
               to touch until the bar at the top has been answered. */
            <>
              <button
                disabled={!pinUndo.done.length}
                onClick={() => {
                  setMenu(null);
                  undoPinMove();
                }}
                title="Take back the last move (Ctrl+Z)"
              >
                Undo
              </button>
              <button
                disabled={!pinUndo.undone.length}
                onClick={() => {
                  setMenu(null);
                  redoPinMove();
                }}
                title="Put it again (Ctrl+Shift+Z)"
              >
                Redo
              </button>
            </>
          ) : menu.polygon ? (
            <>
              {/* Only where a corner was actually under the pointer. Elsewhere
                  the polygon itself is all there is to act on. */}
              {menu.polygon.pointIndex >= 0 && (
                <button onClick={deletePolygonPoint}>Delete this point</button>
              )}
              <button className="danger" onClick={deletePolygon}>
                Delete entire polygon
              </button>
            </>
          ) : menu.measure ? (
            /* Three offers, narrowing to what the hand actually landed on. On a
               point you get both it and its chain, rather than only the
               smaller act: the point is the harder thing to hit, so hitting it
               is weak evidence that the whole line wasn't what was meant. */
            <>
              {menu.measure.pointIndex >= 0 && (
                <button onClick={deleteMeasurePoint}>Delete this point</button>
              )}
              {menu.measure.chainId && (
                <button onClick={deleteMeasurement}>Delete entire measurement</button>
              )}
              {!menu.measure.chainId && (
                <button
                  className="danger"
                  onClick={deleteAllMeasurements}
                  disabled={measurements.length === 0}
                >
                  Delete all measurements
                </button>
              )}
            </>
          ) : menu.pinId ? (
            /* Editing and deleting are the author's alone. Move pins is not:
               it is about arranging your own pins on this board, and which pin
               the menu happened to open on says nothing about that. */
            <>
              {canEditPin(menuPin) && (
                <>
                  <button
                    onClick={() => {
                      if (menuPin) setPinForm({ pin: menuPin });
                      setMenu(null);
                    }}
                  >
                    Edit pin
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (menuPin) {
                        setConfirmDelete({
                          kind: 'pin',
                          id: menuPin.id,
                          name: menuPin.title || 'Pin',
                        });
                      }
                      setMenu(null);
                    }}
                  >
                    Delete pin
                  </button>
                </>
              )}
              {movablePins.length > 0 && (
                <button
                  onClick={startMovingPins}
                  title="Drag your pins where you want them, then confirm"
                >
                  Move pins
                </button>
              )}
            </>
          ) : menu.turnTokenId ? (
            <>
              <button onClick={focusFromTurnList}>Focus</button>
              {isDm && <button onClick={giveTurnTo}>Give turn</button>}
            </>
          ) : menu.tokenId ? (
            <>
              {/* Editing your own figure, offered where you are playing rather
                  than only in the Tokens tab two clicks away. The form drops
                  Belongs to for anyone but the DM: giving a token away is the
                  one thing on it that takes something from somebody else. */}
              <button onClick={editToken}>Edit</button>
              <button
                onClick={() => {
                  setInitiativeFor(menuToken);
                  setMenu(null);
                }}
              >
                Set initiative
              </button>
              {/* Copying is the one item here that does nothing to the token it
                  was chosen on, which is why it sits below the two that do and
                  above the two that take it off the board. */}
              <button onClick={copyToken} title="Then right-click the map to paste a copy">
                Copy token
              </button>
              {/* Only with the lights out, and only for the person who put them
                  out: this is how the DM checks what a creature can actually
                  see from where it is standing, which is the question fog
                  raises and nothing else on this menu answers. */}
              {isDm && fogActive && !povTokenId && (
                <button
                  onClick={() => enterPov(menu.tokenId)}
                  title="See the board as this creature sees it"
                >
                  Fog of War POV
                </button>
              )}
              {/* Above Delete and worded plainly, because these two look alike
                  and one of them can't be undone. This is the reversible one. */}
              <button onClick={benchToken}>Remove from table</button>
              {isDm && (
                <button className="danger" onClick={askDeleteToken}>
                  Delete
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={ping}>Ping</button>
              <button onClick={focusEveryone}>Focus</button>
              {/* First of the three ways to put something here, because it is
                  the one somebody has just set up: you copied a token a moment
                  ago and this is what you came back for. Absent entirely until
                  something has been copied - an item that would only tell you
                  the clipboard is empty is an item worth not drawing. */}
              {clipboard && (
                <button
                  onClick={() => {
                    setPasteAt(cellAt(menu.mx, menu.my));
                    setPasteError('');
                    setMenu(null);
                  }}
                  title={`Paste a copy of ${clipboard.label || 'the copied token'} here`}
                >
                  Paste token
                </button>
              )}
              {/* Above Create token, and shown to anybody with a token of
                  their own waiting: placing one you already have is the common
                  act, and making a new one is the occasional one. Only when
                  there is something to place - an empty list behind a menu item
                  is a promise the menu couldn't keep. */}
              {placeable.length > 0 && (
                <button
                  onClick={() => {
                    setSpawnAt(cellAt(menu.mx, menu.my));
                    setMenu(null);
                  }}
                >
                  Place Token
                </button>
              )}
              {isDm && <button onClick={openTokenModal}>Create token</button>}
              {/* Everybody's, like drawing on the map: writing down what your
                  character worked out is the same kind of act as marking where
                  a spell landed. It goes at the exact point that was clicked,
                  grid or no grid - a pin names a doorway, not a square. */}
              {canPin && (
                <button
                  onClick={() => {
                    setPinForm({ at: { x: Math.round(menu.mx), y: Math.round(menu.my) } });
                    setMenu(null);
                  }}
                >
                  Create pin
                </button>
              )}
              {/* Below the line: not things to do to the map, but things to do
                  to what you have already done to it. Everyone has these - a
                  player who has moved a token has something to take back - and
                  they reach only your own work, since your own is all this
                  browser ever wrote down. */}
              <div className="menu-sep" />
              <button
                disabled={!history.undo}
                onClick={() => {
                  setMenu(null);
                  runHistory('undo');
                }}
                title="Take back your last change (Ctrl+Z)"
              >
                Undo
              </button>
              <button
                disabled={!history.redo}
                onClick={() => {
                  setMenu(null);
                  runHistory('redo');
                }}
                title="Put back what you just took back (Ctrl+Shift+Z)"
              >
                Redo
              </button>
            </>
          )}
        </div>
      )}

      {/* A scene asks for its name to be typed; a token only asks. The scene
          takes every token on it with it and can't be got back, which is the
          test the sheet windows already use - a token is a minute's work. */}
      {asking && (
        <ConfirmDeleteModal
          name={confirmDelete.name}
          title={asking.title}
          byName={confirmDelete.kind === 'scene'}
          description={asking.description}
          confirmLabel={asking.confirmLabel}
          onConfirm={asking.run}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {initiativeFor && (
        <InitiativeModal
          token={initiativeFor}
          onSubmit={saveInitiative}
          onClose={() => setInitiativeFor(null)}
        />
      )}

      {spawnAt && (
        <SpawnModal
          bench={placeable}
          owners={players}
          onPick={spawnFromBench}
          onClose={() => setSpawnAt(null)}
        />
      )}

      {pasteAt && clipboard && (
        <PasteTokenModal
          token={clipboard}
          name={pasteName}
          busy={pasting}
          error={pasteError}
          onConfirm={pasteToken}
          onClose={() => {
            setPasteAt(null);
            setPasteError('');
          }}
        />
      )}

      {tokenForm && (
        <TokenModal
          token={tokenForm.token}
          // Who there is to hand a token to: this table's members, which is the
          // same list the Players tab reads.
          players={players}
          // The DM's alone, and the server says so again on the way in - an
          // owner's edit cannot carry an owner, or hide a token from the table,
          // however the form was drawn.
          canAssign={isDm}
          canHide={isDm}
          canCloud={isDm}
          // The linked character, whose attacks are listed in the form without
          // being editable there: those belong to the sheet.
          sheet={sheetFor(tokenForm.token)}
          // And the picker that decides which character that is. Only on a
          // token that exists: coupling is written the moment it is chosen, and
          // there is nothing to couple until the figure has been created.
          sheetOptions={tokenForm.token && !offline ? sheetOptionsFor(tokenForm.token) : null}
          onLinkSheet={
            tokenForm.token && !offline
              ? (sheetId) => linkTokenSheet(tokenForm.token.id, sheetId)
              : undefined
          }
          onSubmit={submitToken}
          onClose={() => setTokenForm(null)}
        />
      )}

      {fogWindow && isDm && (
        <FogSettings
          fog={fog}
          // Every creature on this board, the DM's hidden ones included: a
          // monster nobody can see still has eyes, and its point of view is
          // exactly what the DM will want to check.
          tokens={scene.tokens}
          players={players}
          onFog={saveFog}
          onVision={saveVision}
          onClose={() => setFogWindow(false)}
          offline={offline}
        />
      )}

      {pinForm && (
        <PinModal
          pin={pinForm.pin}
          at={pinForm.at}
          // Who there is to share it with: this table's members, the same list
          // the handouts share against.
          players={players}
          actor={actor}
          onSubmit={submitPin}
          onClose={() => setPinForm(null)}
        />
      )}

      {/* One card per opened pin, painted in the order they were last reached
          for - the same arrangement the notes and the sheets use. Each hangs
          over its own pin and rides the map as it scrolls; a pin whose card
          cannot be placed yet, because the map has not been measured, simply
          waits for the frame after. */}
      {openPins.map((pin, i) => {
        const anchor = anchorFor(pin);
        if (!anchor) return null;
        return (
          <PinWindow
            key={pin.id}
            pin={pin}
            anchor={anchor}
            players={players}
            actor={actor}
            zIndex={Math.min(PIN_Z_BASE + i, PIN_Z_CEILING)}
            isTop={i === openPins.length - 1}
            onFocus={() => openPin(pin.id)}
            onClose={() => closePin(pin.id)}
          />
        );
      })}

      {/* Tokens are made from the map's own right-click menu now - see the
          `Create token` item - so there is no panel here any more. */}
    </div>
  );
}
