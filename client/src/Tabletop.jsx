import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import TokenModal from './TokenModal.jsx';
import TokenTooltip from './TokenTooltip.jsx';
import InitiativeModal from './InitiativeModal.jsx';
import SpawnModal from './SpawnModal.jsx';
import ShapeTools from './ShapeTools.jsx';
import MeasureTools from './MeasureTools.jsx';
import {
  cellCentre,
  cellsBetween,
  formatDistance,
  labelSpot,
  legsOf,
  pointIndexAt,
  totalCells,
  touches,
  unitNamed,
} from './measure.js';
import {
  DEFAULT_STYLE,
  angleTo,
  contrastInk,
  edgesAt,
  isDrawn,
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
  recordTokenSpawn,
} from './sceneHistory.js';

// ~30 position updates a second is smooth to the eye and a fraction of the
// frames a pointer actually produces.
const DRAG_EMIT_MS = 33;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How long a grid-slider drag settles before we save it.
const GRID_SAVE_MS = 400;

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

// How the ruler was last set up. Which unit a table counts in is a fact about
// the campaign that doesn't change from one evening to the next, so having to
// say it again every time the box is opened would be a small tax on every use.
const MEASURE_KEY = 'rpg:measure-setup';

// How near a right-click has to land, in cells, to be about a measurement
// rather than about the bare map - and, inside that, to be about one of its
// points rather than the line between two. The point radius is the smaller
// because it sits *on* the line: a hand aiming at the line near a point would
// otherwise always be told it meant the point.
const MEASURE_GRAB = 0.4;
const MEASURE_POINT_GRAB = 0.25;

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


// Zoom bounds shared by the slider and the wheel, so the two can't disagree.
const ZOOM_MIN = 0.4;
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
// for the longest of the three menus, which is the map's own: six items and a
// rule, once there is something on the bench to spawn. The shorter ones open a
// little further from the bottom edge than they strictly need to, which nobody
// has ever complained about.
const MENU_W = 140;
const MENU_H = 182;

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
  const turnable = shape.kind !== 'circle';

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
 * `pending` is the leg still following the pointer: dashed, and labelled like
 * any other, since the number you are about to commit to is the one you are
 * actually reading.
 */
function MeasureMark({ chain, cell, origin, zoom, color, unit, perCell, pending }) {
  const at = (p) => ({ x: origin.x + p.x * cell, y: origin.y + p.y * cell });
  const points = chain.points.map(at);
  const legs = legsOf(chain.points);
  const scale = 1 / zoom;

  // The leg in flight is measured from the last committed point, and drawn
  // exactly like the others so that what you see is what you'll get.
  const tip = pending ? at(pending) : null;
  const tipCells = pending ? cellsBetween(chain.points[chain.points.length - 1], pending) : 0;

  return (
    <g className="measure-mark" style={{ '--ink': color }}>
      {points.length > 1 && (
        <polyline
          className="measure-line"
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          strokeWidth={2 * scale}
        />
      )}
      {tip && (
        <line
          className="measure-line measure-pending"
          x1={points[points.length - 1].x}
          y1={points[points.length - 1].y}
          x2={tip.x}
          y2={tip.y}
          strokeWidth={2 * scale}
          strokeDasharray={`${6 * scale} ${5 * scale}`}
        />
      )}

      {points.map((p, i) => (
        <circle key={i} className="measure-dot" cx={p.x} cy={p.y} r={4 * scale} strokeWidth={1.5 * scale} />
      ))}

      {/* One label per leg, beside the line rather than along it. A chain that
          doubles back would otherwise stack two numbers in the same place. */}
      {legs.map((leg, i) => {
        const spot = labelSpot(chain.points[i], chain.points[i + 1]);
        const px = at(spot);
        return (
          <text
            key={`leg-${i}`}
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
      {tip && (
        <text
          className="measure-text"
          x={at(labelSpot(chain.points[chain.points.length - 1], pending)).x}
          y={at(labelSpot(chain.points[chain.points.length - 1], pending)).y}
          fontSize={13 * scale}
          strokeWidth={3 * scale}
        >
          {formatDistance(tipCells, unit, perCell)}
        </text>
      )}

      {/* The chain's own running total, at its far end - the answer to "how far
          have I come", which for a route with a corner in it is not any of the
          leg numbers. Only once there is more than one leg to add up. */}
      {legs.length > 1 && (
        <text
          className="measure-text measure-sum"
          x={points[points.length - 1].x}
          y={points[points.length - 1].y - 12 * scale}
          fontSize={14 * scale}
          strokeWidth={3.5 * scale}
        >
          {formatDistance(totalCells(chain.points), unit, perCell)}
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
  // Live grid-slider value. Null means "whatever the scene says" - we only hold
  // a local value while the GM is actually dragging, so another GM's change
  // isn't masked by a stale draft.
  const [gridDraft, setGridDraft] = useState(null);
  // The same for where the grid sits, while it's being dragged into place.
  // Null means "whatever the scene says", for the same reason.
  const [offsetDraft, setOffsetDraft] = useState(null);
  // Which bar the wheel drives while the cursor is over the map. Zoom to begin
  // with: it's the one everybody reaches for, and the one a player has at all.
  const [wheelTarget, setWheelTarget] = useState('zoom');
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
  // Where a token is about to be put back, in cells. Non-null means the picker
  // is open; the spot was decided by the right-click that opened it, exactly as
  // it is for a brand new token.
  const [spawnAt, setSpawnAt] = useState(null);
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
  const gridTimer = useRef(null);
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
  // What the ruler counts in, and whether anybody else can see it. Remembered
  // per browser - except for Shared, which is deliberately not: showing the
  // table your working is a decision about *this* measurement, and one that
  // silently persisted from a fortnight ago is one nobody made.
  const [measureSetup, setMeasureSetup] = useState(() => {
    const fallback = { unit: 'cells', perCell: 1 };
    try {
      const saved = JSON.parse(localStorage.getItem(MEASURE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...fallback, ...saved } : fallback;
    } catch {
      return fallback;
    }
  });
  const [measureShared, setMeasureShared] = useState(false);
  // Other people's shared rulers, keyed by whose they are. One each: a fresh
  // set from somebody replaces the last one they sent rather than joining it.
  const [remoteMeasures, setRemoteMeasures] = useState({});

  const isDm = actor?.role === 'dm';
  /**
   * The scene on screen, which is not merely "the one whose id is selected".
   *
   * A selection can stop resolving - you deleted that scene, or another DM did.
   * Falling back to the first scene means an id pointing at nothing costs you a
   * selection rather than the whole view: the alternative is rendering the
   * empty state while scenes plainly exist, and since the scene picker lives
   * below that branch there'd be no way back.
   */
  const rawScene = scenes.find((s) => s.id === activeId) || scenes[0] || null;
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
      setActiveId((cur) => (data.some((s) => s.id === cur) ? cur : data[0]?.id || ''));
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

  useEffect(() => {
    refresh();
    loadRoster();
    api.listMaps().then(setMaps).catch(() => setMaps([]));
  }, [refresh, loadRoster]);

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

  // A draft belongs to the scene it was made on, and so does a pulse on the map.
  useEffect(() => {
    setGridDraft(null);
    setOffsetDraft(null);
    setPings([]);
    setMenu(null);
    // A shape belongs to the scene it was drawn on, so a selection can't
    // survive a change of scene either. The tool stays in your hand: it's about
    // what you're doing, not about which board you're looking at.
    setSelectedShapeId(null);
    setSketch(null);
    clearTimeout(gridTimer.current);
  }, [selectedId]);

  useEffect(() => () => clearTimeout(gridTimer.current), []);

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
  const gridSize = gridDraft ?? scene?.gridSize ?? 70;
  // Absent means on, matching the server: scenes made before the toggle existed
  // had a grid.
  const gridOn = scene?.gridOn !== false;
  // The grid bar is the GM's, and only while they can write. Everyone else has
  // zoom and nothing to choose between, so the wheel stays on it for them.
  const canTuneGrid = isDm && !offline;
  const mapW = scene?.width || 1200;
  const mapH = scene?.height || 840;
  const cellPx = gridSize * zoom;
  // Where cell (0,0) starts, in map pixels. Everything measured in cells -
  // the lines, the tokens, the square a pointer is over - is measured from
  // here, so moving it slides the whole grid across a map that stays put.
  const gridOffX = offsetDraft?.x ?? scene?.gridOffsetX ?? 0;
  const gridOffY = offsetDraft?.y ?? scene?.gridOffsetY ?? 0;
  // The same corner in screen pixels, which is what the layout wants.
  const offXPx = gridOffX * zoom;
  const offYPx = gridOffY * zoom;
  const cols = Math.max(1, Math.floor(mapW / gridSize));
  const rows = Math.max(1, Math.floor(mapH / gridSize));

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
  // What could be put on the board right now. A token already standing on a
  // scene - this one or another - is not a thing you can place; it is a thing
  // you can go and look at.
  const placeable = roster.filter((t) => !t.sceneId);
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
  // asked about a route, and a route is usually more than one leg.
  const measuredCells = measurements.reduce((sum, m) => sum + totalCells(m.points), 0);
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

  /**
   * While a tool is in hand the wheel belongs to the zoom.
   *
   * Not a preference so much as a consequence: the grid gauge's own gesture is
   * a right-drag, and a right-drag is how you move the view while you draw. One
   * of the two has to give, and it can't be the one that lets you reach the
   * part of the map you're drawing on.
   */
  const pickWheel = useCallback(
    (target) => {
      if (target === 'grid' && (drawing || measuring)) return;
      setWheelTarget(target);
    },
    [drawing, measuring]
  );

  useEffect(() => {
    if (drawing || measuring) setWheelTarget('zoom');
  }, [drawing, measuring]);

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
      color: myColor,
    });
    // On the way out too: closing the tab, walking off to the notes tab, or
    // switching scenes all have to take the ruler off other people's boards.
    return () => socket.emit('scene:measure:end');
  }, [measuring, measureShared, offline, selectedId, measurements, measureSetup, myColor]);

  // Somebody else's ruler arriving. Keyed by whose it is, so a new set from one
  // person replaces theirs and leaves everybody else's alone - and an empty set
  // is how a ruler is taken down, which the same line handles.
  useEffect(() => {
    const onMeasured = ({ sceneId, userId, by, measurements: theirs, unit, perCell, color }) => {
      if (!userId) return;
      setRemoteMeasures((prev) => {
        if (!theirs?.length) {
          if (!prev[userId]) return prev;
          const { [userId]: gone, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [userId]: { sceneId, by, measurements: theirs, unit, perCell, color },
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
      const grip = e.target?.closest?.('[data-grip]')?.dataset.grip || 'move';
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

  // --- panning ---
  // Right-drag anywhere on the map moves your view, so you don't have to reach
  // for the scrollbars. Tokens are excluded: a right-click on one keeps its
  // normal browser menu.
  const onToken = (e) => Boolean(e.target.closest?.('.token'));

  /**
   * Whether a right-drag moves the grid instead of the view.
   *
   * With the Grid gauge selected the same gesture is aimed at the grid rather
   * than the camera: the map stays exactly where it is and the cells slide over
   * it. That's what makes a map with a grid already drawn on it usable - size
   * the cells to match the art, then push them onto it. The view still has its
   * scrollbars, and picking Zoom again gives the pan back.
   */
  const canNudgeGrid = canTuneGrid && gridOn && wheelTarget === 'grid';

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
      // read back from the draft, so the save at the end can't pick up a value
      // from a render that hasn't happened yet. The start is kept as well as
      // the running total: it's what Undo puts back.
      offX: gridOffX,
      offY: gridOffY,
      fromX: gridOffX,
      fromY: gridOffY,
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
      setOffsetDraft({ x: p.offX, y: p.offY });
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
    // Saved when the hand comes off the map rather than once per pixel of
    // travel - the same bargain the cell-size slider makes with its timer.
    if (p.grid && pannedRef.current) {
      saveGridOffset(p.offX, p.offY, { gridOffsetX: p.fromX, gridOffsetY: p.fromY });
    }
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

      // Scrolling down (positive delta) means less of whatever is selected -
      // zoomed further out, or smaller cells.
      if (wheelTarget === 'grid' && canTuneGrid) {
        const next = clamp(gridSize - notches * GRID_WHEEL_STEP, GRID_MIN, GRID_MAX);
        if (next !== gridSize) onGridSlide(next);
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
    // `scene` is in here because onGridSlide saves it alongside the new size;
    // a stale one would write back an old scene.
  }, [zoom, selectedId, wheelTarget, canTuneGrid, gridSize, scene]);

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
      runHistory(e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runHistory, tokenForm, confirmDelete]);

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

    // A token gets a menu about *that token* rather than about the map under
    // it. The DM gets one on any token; a player gets one on their own, where
    // there is now something on it for them - their initiative, and taking the
    // token off the table. On anybody else's they keep the browser's own menu,
    // because a menu of things you may not do is worse than no menu.
    const el = e.target.closest?.('.token');
    if (el) {
      const token = scene?.tokens.find((t) => t.id === el.dataset.tokenId);
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
   * been slid across the map. Rounded to a square where there is a grid to
   * round to, and clamped to the board - you can right-click beside a map that
   * is narrower than its scroller.
   */
  const cellAt = (mx, my) => ({
    x: clamp(gridOn ? Math.round((mx - gridOffX) / gridSize) : round2((mx - gridOffX) / gridSize), 0, cols - 1),
    y: clamp(gridOn ? Math.round((my - gridOffY) / gridSize) : round2((my - gridOffY) / gridSize), 0, rows - 1),
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
    const x = clamp(px - d.grabX, 0, cols - 1);
    const y = clamp(py - d.grabY, 0, rows - 1);
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

  const uploadMap = (file) =>
    guard(async () => {
      const { url } = await api.uploadImage(file);
      const { width, height } = await imageSize(url);
      await patchScene({ imageUrl: url, width, height });
    });

  // Slider moves are previewed locally and saved once the GM settles, rather
  // than firing a write per pixel of slider travel.
  function onGridSlide(value) {
    setGridDraft(value);
    clearTimeout(gridTimer.current);
    gridTimer.current = setTimeout(async () => {
      // What the scene said before this settle - one entry per time the hand
      // comes to rest, rather than one per pixel of slider travel.
      const before = { gridSize: scene.gridSize ?? 70 };
      try {
        const updated = await api.updateScene(scene.id, { ...scene, gridSize: value });
        setScenes((prev) =>
          prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s))
        );
        const after = { gridSize: updated.gridSize };
        if (!matches(after, before)) recordSceneEdit({ sceneId: updated.id, before, after });
        setGridDraft(null); // back to following the scene
      } catch (e) {
        setError(e.message);
      }
    }, GRID_SAVE_MS);
  }

  // Where the drag left the grid. No timer: a nudge ends when the button comes
  // up, which is a moment the slider never gets.
  async function saveGridOffset(x, y, before) {
    try {
      const updated = await api.updateScene(scene.id, {
        ...scene,
        // The slider's own draft, if one is mid-flight - otherwise saving the
        // offset would write the cell size back to what it was before it moved.
        gridSize,
        gridOffsetX: x,
        gridOffsetY: y,
      });
      setScenes((prev) =>
        prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s))
      );
      // One entry for the whole drag: where the grid sat when the button went
      // down, and where it sat when it came up.
      const after = pick(updated, ['gridOffsetX', 'gridOffsetY']);
      if (!matches(after, before)) recordSceneEdit({ sceneId: updated.id, before, after });
      setOffsetDraft(null); // back to following the scene
    } catch (e) {
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
      description: 'This takes the token off the map for everyone at the table.',
      confirmLabel: 'Delete token',
      run: () => removeToken(confirmDelete.id),
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
        <select value={selectedId} onChange={(e) => setActiveId(e.target.value)}>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {/* A div, not a label: the name is a button that picks what the wheel
            drives, and inside a label every click on it would also be a click
            on the control next to it. */}
        <div className={`zoom${wheelTarget === 'zoom' ? ' wheel-target' : ''}`}>
          <button
            type="button"
            className="wheel-pick"
            aria-pressed={wheelTarget === 'zoom'}
            onClick={() => pickWheel('zoom')}
            title="Scroll over the map to zoom"
          >
            Zoom
          </button>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={zoom}
            aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            // Taking hold of a bar is as much a way of choosing it as clicking
            // its name - you've said which one you're working on either way.
            onPointerDown={() => pickWheel('zoom')}
            title="Scroll over the map to zoom"
          />
          <small>{Math.round(zoom * 100)}%</small>
        </div>

        {isDm && !offline && (
          <>
            {/* Grid ratio: how much of the map one cell covers. The map does
                not change size - only the number of cells over it does. */}
            <div className={`zoom grid-ratio${wheelTarget === 'grid' ? ' wheel-target' : ''}`}>
              <input
                type="checkbox"
                checked={gridOn}
                onChange={(e) => patchScene({ gridOn: e.target.checked })}
                title="Show the grid and snap tokens to it"
                aria-label="Show the grid and snap tokens to it"
              />
              {/* The word used to be the checkbox's label. It picks the wheel
                  now, so the checkbox carries its own aria-label instead -
                  otherwise choosing what to scroll would flick the grid off. */}
              <button
                type="button"
                className="wheel-pick"
                aria-pressed={wheelTarget === 'grid'}
                onClick={() => pickWheel('grid')}
                // Held still while a drawing tool is in hand, and while the
                // ruler is out: the gauge's own gesture is a right-drag, and
                // that is how you move the view in both of those modes. Said
                // out loud rather than left to be noticed.
                disabled={drawing || measuring}
                title={
                  drawing
                    ? 'Put the drawing tool down to retune the grid'
                    : measuring
                      ? 'Leave measuring mode to retune the grid'
                      : 'Scroll over the map to resize the cells, right-drag to move the grid'
                }
              >
                Grid
              </button>
              {/* The slider stays live with the grid off: cell size is still
                  the scale tokens are measured in, even when no cells are
                  drawn. Only the readout changes, since there are no rows and
                  columns to count. */}
              <input
                type="range"
                min={GRID_MIN}
                max={GRID_MAX}
                step="1"
                value={gridSize}
                aria-label="Cell size"
                onChange={(e) => onGridSlide(Number(e.target.value))}
                onPointerDown={() => pickWheel('grid')}
                title={gridOn ? 'Cell size relative to the map' : 'Token scale relative to the map'}
              />
              <small>{gridOn ? `${cols}×${rows}` : `${gridSize}px`}</small>
            </div>

            <input
              className="scene-name"
              value={scene.name}
              onChange={(e) =>
                setScenes((prev) =>
                  prev.map((s) => (s.id === scene.id ? { ...s, name: e.target.value } : s))
                )
              }
              onBlur={(e) => patchScene({ name: e.target.value })}
            />

            {maps.length > 0 && (
              <select
                className="map-picker"
                value={maps.some((m) => m.url === scene.imageUrl) ? scene.imageUrl : ''}
                onChange={(e) => e.target.value && setMap(e.target.value)}
                disabled={busy}
                title="Maps from public/maps"
              >
                <option value="">Built-in map…</option>
                {maps.map((m) => (
                  <option key={m.url} value={m.url}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}

            <label className="upload">
              Upload image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ''; // let the same file be picked again
                  if (file) uploadMap(file);
                }}
              />
            </label>
            <button onClick={newScene} disabled={busy}>
              + Scene
            </button>
            <button
              className="del"
              onClick={() =>
                setConfirmDelete({ kind: 'scene', id: scene.id, name: scene.name || 'this scene' })
              }
              disabled={busy}
            >
              Delete scene
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {/* Wraps the scroller so the tools panel can be pinned to the map's own
          top-left corner. Inside the scroller it would be pinned to the *map*
          and slide away with it; outside this wrapper there is nothing to
          measure against but the whole column, and the bar above it is a row
          whose height changes as it wraps. */}
      <div className="map-area">
      <div
        className={`surface-scroll${gesture === 'pan' ? ' panning' : ''}${
          gesture === 'grid' ? ' nudging' : ''
        }`}
        ref={scrollRef}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        onContextMenu={onContextMenu}
      >
        <div
          className={`surface${drawing ? ' drawing' : ''}${measuring ? ' measuring' : ''}`}
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
          </svg>

          {/* Borrowed while a ruler is on the board, whoever's it is - see
              gridShown. The scene's own setting is untouched. */}
          {gridShown && <div className="grid-overlay" />}

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
                className={`token${movable ? ' movable' : ''}${mine ? ' dragging' : ''}${
                  blocked ? ' blocked' : ''
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
                    color={ruler.color}
                    unit={ruler.unit}
                    perCell={ruler.perCell}
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
                  color={myColor}
                  unit={measureSetup.unit}
                  perCell={measureSetup.perCell}
                  // Only the chain still open follows the pointer, and only
                  // while the pointer is over the map.
                  pending={chain.id === openChainId ? measureAt : null}
                />
              ))}
            </svg>
          )}
        </div>
      </div>

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
              {isDm && (
                <button onClick={toggleTurnMode} disabled={busy}>
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
              >
                {measureWindow ? 'Standard mode' : 'Measuring mode'}
              </button>
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
          onUnit={(unit) => setMeasureSetup({ unit, perCell: unitNamed(unit).perCell })}
          onPerCell={(perCell) =>
            setMeasureSetup((s) => ({ ...s, perCell: Number.isFinite(perCell) ? perCell : 1 }))
          }
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
                  // The same reading of the same two fields the hover tooltip
                  // makes: no total means nothing to draw, and a stored current
                  // can outlive a maximum the DM has since lowered.
                  const total = t.maxHp ?? 0;
                  const hp = Math.max(0, Math.min(t.hp ?? 0, total));
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
                      {isDm && total > 0 && (
                        <span className="turn-hp">
                          <span className="hp-bar">
                            <span className="hp-fill" style={{ width: `${(hp / total) * 100}%` }} />
                          </span>
                          <small>
                            {hp}/{total}
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
          owner={
            hoveredToken.ownerId ? players.find((p) => p.id === hoveredToken.ownerId) : null
          }
          showHp={isDm}
          status={
            ghosts[hoveredToken.id]
              ? `Being moved by ${ghosts[hoveredToken.id].by}`
              : canMove(hoveredToken)
                ? 'Drag to move'
                : ''
          }
        />
      )}

      {menu && (
        <div className="map-menu" ref={menuRef} style={{ left: menu.clientX, top: menu.clientY }}>
          {menu.measure ? (
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
          ) : menu.turnTokenId ? (
            <>
              <button onClick={focusFromTurnList}>Focus</button>
              {isDm && <button onClick={giveTurnTo}>Give turn</button>}
            </>
          ) : menu.tokenId ? (
            <>
              {/* Editing everything about a token stays the DM's. What a player
                  gets on their own token is what is theirs to say: what it
                  rolled, and whether it's on the table at all. */}
              {isDm && <button onClick={editToken}>Edit</button>}
              <button
                onClick={() => {
                  setInitiativeFor(menuToken);
                  setMenu(null);
                }}
              >
                Set initiative
              </button>
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

      {tokenForm && (
        <TokenModal
          token={tokenForm.token}
          // Who there is to hand a token to: this table's members, which is the
          // same list the Players tab reads.
          players={players}
          onSubmit={submitToken}
          onClose={() => setTokenForm(null)}
        />
      )}

      {/* Tokens are made from the map's own right-click menu now - see the
          `Create token` item - so there is no panel here any more. */}
    </div>
  );
}
