import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import FloatingWindow from './FloatingWindow.jsx';
import TokenModal from './TokenModal.jsx';
import TokenTooltip from './TokenTooltip.jsx';

// ~30 position updates a second is smooth to the eye and a fraction of the
// frames a pointer actually produces.
const DRAG_EMIT_MS = 33;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How long a grid-slider drag settles before we save it.
const GRID_SAVE_MS = 400;

// Where this browser remembers whether the map's tools panel is rolled up.
const TOOLS_MIN_KEY = 'rpg:map-tools-min';

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
// accumulate and only step once this much has gone by — otherwise a light
// two-finger flick would rocket through the whole zoom range.
const WHEEL_NOTCH = 100;

// A right-click is a menu; a right-drag is a pan. Under this much travel the
// gesture is still a click — which is what lets "press, release, don't really
// move" open the menu instead of panning the map by three pixels and
// suppressing it. No pointer is perfectly still for the length of a click.
const PAN_SLOP = 5;

// How long a ping stays on screen: long enough for someone looking at their
// character sheet to glance up and still catch it.
const PING_MS = 2400;

// Roughly the menu's own size, used only to stop it opening past the edge of
// the window. Approximate on purpose — measuring it properly means rendering it
// somewhere invisible first, for a few pixels nobody will ever notice.
const MENU_W = 140;
const MENU_H = 96;

const round1 = (v) => Math.round(v * 10) / 10;
// Free placement still gets rounded, just far more finely than to a cell —
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
  // Live grid-slider value. Null means "whatever the scene says" — we only hold
  // a local value while the GM is actually dragging, so another GM's change
  // isn't masked by a stale draft.
  const [gridDraft, setGridDraft] = useState(null);
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
  // Pings currently pulsing. Ephemeral by nature — never persisted, and dropped
  // wholesale when the scene changes.
  const [pings, setPings] = useState([]);
  // The token form: either { x, y } for a new token at that spot, or { token }
  // for one being edited. Held here rather than in the modal because the menu
  // that decided it is closed by the time the modal opens — the choice has to
  // outlive the thing that made it.
  const [tokenForm, setTokenForm] = useState(null);
  // The token the pointer is resting on, with the element to hang its tooltip
  // on. The element is kept rather than looked up again because the event that
  // told us about the hover is holding it already.
  const [hovered, setHovered] = useState(null);
  // Whether the tools panel is rolled up to its square. A local preference —
  // it says nothing about the table, only about how much of this screen its
  // owner wants the map to have — so it lives in this browser and is read back
  // on mount, since leaving the tab unmounts the map entirely.
  const [toolsMin, setToolsMin] = useState(() => localStorage.getItem(TOOLS_MIN_KEY) === '1');
  // The token whose row in the turn tracker the pointer is over, lit up on the
  // map so you can find it without reading names. Local to this screen: it says
  // where *you* are looking, which is nobody else's business.
  const [spotlight, setSpotlight] = useState(null);
  // What a confirmation dialog is currently asking about: { kind, id, name }.
  // One piece of state for both kinds, because only ever one of them is open.
  const [confirmDelete, setConfirmDelete] = useState(null);

  const surfaceRef = useRef(null);
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const pannedRef = useRef(false);
  const gridTimer = useRef(null);
  const wheelAcc = useRef(0);
  const zoomAnchor = useRef(null);
  const pendingFocus = useRef(null);
  const pingTimers = useRef(new Set());
  const menuRef = useRef(null);
  const [panning, setPanning] = useState(false);
  // Bumped to force a render after a focus arrives, so the scroll is applied by
  // a layout effect that runs *after* the new zoom is on screen. Without it a
  // focus that doesn't change the zoom would re-render nothing and never scroll.
  const [focusTick, setFocusTick] = useState(0);

  const isDm = actor?.role === 'dm';
  /**
   * The scene on screen, which is not merely "the one whose id is selected".
   *
   * A selection can stop resolving — you deleted that scene, or another DM did.
   * Falling back to the first scene means an id pointing at nothing costs you a
   * selection rather than the whole view: the alternative is rendering the
   * empty state while scenes plainly exist, and since the scene picker lives
   * below that branch there'd be no way back.
   */
  const rawScene = scenes.find((s) => s.id === activeId) || scenes[0] || null;
  // Everything downstream — the picker, the draft, the wheel handler — follows
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

  useEffect(() => {
    refresh();
    api.listMaps().then(setMaps).catch(() => setMaps([]));
  }, [refresh]);

  // A draft belongs to the scene it was made on, and so does a pulse on the map.
  useEffect(() => {
    setGridDraft(null);
    setPings([]);
    setMenu(null);
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
    socket.on('token:dragging', onDragging);
    socket.on('token:drag:ended', onDragEnded);
    return () => {
      socket.off('scenes:changed', onSceneChange);
      socket.off('token:dragging', onDragging);
      socket.off('token:drag:ended', onDragEnded);
    };
  }, []);

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
  // sized from the image and only the *cell* size follows the grid slider —
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
  const cols = Math.max(1, Math.floor(mapW / gridSize));
  const rows = Math.max(1, Math.floor(mapH / gridSize));

  // One token per cell. Footprints are rectangles because a token can be bigger
  // than one cell, so this mirrors the server's check — the server is still the
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

  // --- dragging ---

  function pointerCell(e) {
    const rect = surfaceRef.current.getBoundingClientRect();
    return { px: (e.clientX - rect.left) / cellPx, py: (e.clientY - rect.top) / cellPx };
  }

  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    socket.emit('token:drag:end');
  }

  // --- panning ---
  // Right-drag anywhere on the map moves your view, so you don't have to reach
  // for the scrollbars. Tokens are excluded: a right-click on one keeps its
  // normal browser menu.
  const onToken = (e) => Boolean(e.target.closest?.('.token'));

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
    };
    setPanning(true);
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
    setPanning(false);
    try {
      scrollRef.current?.releasePointerCapture(p.pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  // --- scroll to adjust ---
  // The wheel drives one of the bars in the scene bar rather than the
  // scrollbars — whichever is selected there. Registered natively because React
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

      // Scrolling down (positive delta) means less of whatever is selected —
      // zoomed further out, or smaller cells.
      if (wheelTarget === 'grid' && canTuneGrid) {
        const next = clamp(gridSize - notches * GRID_WHEEL_STEP, GRID_MIN, GRID_MAX);
        if (next !== gridSize) onGridSlide(next);
        return;
      }

      const next = clamp(round1(zoom - notches * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
      if (next === zoom) return;

      // Remember the map point under the cursor so it stays put across the
      // zoom — otherwise the view lurches away from whatever you're aiming at.
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
   * — a focus at the zoom you already had changes no state the renderer can see.
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
    // Where the surface begins in content coordinates — derived rather than
    // read from offsetLeft, because `margin: 0 auto` centring shifts it.
    const originX = sBox.left - box.left + el.scrollLeft;
    const originY = sBox.top - box.top + el.scrollTop;
    // Put the point in the middle of the viewport. Assigning past either end is
    // clamped by the browser, which is exactly what should happen at a border
    // or a corner: scroll as far as there is map to scroll, and no further. The
    // spot ends up off-centre there, which is the honest result — the alternative
    // is showing everyone a margin of nothing so the maths can come out even.
    el.scrollLeft = originX + target.mx * zoom - el.clientWidth / 2;
    el.scrollTop = originY + target.my * zoom - el.clientHeight / 2;
  }, [focusTick, zoom]);

  // An open menu is dismissed by anything that isn't using it.
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      // Not a press on the menu itself — that press is someone choosing an item,
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

  function onContextMenu(e) {
    // Windows fires contextmenu on mouse-*up*, so a pan that finishes over a
    // token would otherwise pop that token's menu. A gesture that panned never
    // opens a menu, wherever it happens to end.
    if (pannedRef.current) {
      pannedRef.current = false;
      e.preventDefault();
      return;
    }
    // A token gets a menu about *that token* rather than about the map under
    // it. Only for the DM, since both items are things only a DM may do —
    // anyone else keeps the browser's own menu, exactly as before.
    const el = e.target.closest?.('.token');
    if (el) {
      if (!isDm || offline) return;
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
  // Your own colour, so a ping is recognisably yours without carrying a name
  // across the wire for the eye to read mid-combat.
  const myColor = players.find((p) => p.id === actor?.userId)?.color || '#ffd479';

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
   * was — what a double-click in the turn list does.
   *
   * Token coordinates are in cells and the focus wants map pixels, and it wants
   * the middle of the token rather than its top-left corner: a size-3 giant
   * centred on its corner sits a cell and a half off the middle of the screen.
   */
  // Resolved from the live scene when the item is chosen, not when the menu was
  // opened — the same care the map's own menu takes, since a token can be
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
      x: (token.x + half) * gridSize,
      y: (token.y + half) * gridSize,
      zoom,
    });
  }

  // Remember where the menu was opened and hand the rest to the modal. The spot
  // is settled here, not there: a token summoned into the top-left corner is one
  // you then have to go and find, and the point of asking for it *here* is that
  // here is where you want it.
  function openTokenModal() {
    if (!menu || !scene) return;
    const cellX = menu.mx / gridSize;
    const cellY = menu.my / gridSize;
    setTokenForm({
      x: clamp(gridOn ? Math.round(cellX) : round2(cellX), 0, cols - 1),
      y: clamp(gridOn ? Math.round(cellY) : round2(cellY), 0, rows - 1),
    });
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
    hovered && !drag && !panning && !menu
      ? scene?.tokens.find((t) => t.id === hovered.id)
      : null;

  function editToken() {
    if (!menuToken) return;
    setTokenForm({ token: menuToken });
    setMenu(null);
  }

  // Asking first, like every other delete in the app. The menu closes as the
  // dialog opens — leaving both on screen would be two things asking to be
  // answered about the same token.
  function askDeleteToken() {
    if (!menuToken) return;
    setConfirmDelete({ kind: 'token', id: menuToken.id, name: menuToken.label || 'Token' });
    setMenu(null);
  }

  async function removeToken(tokenId) {
    setError('');
    try {
      await api.deleteToken(scene.id, tokenId);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, tokens: s.tokens.filter((t) => t.id !== tokenId) } : s
        )
      );
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
   * scenes.js `turnOrder`): highest initiative first, and a token without one
   * isn't in the fight at all. The two are kept in step on purpose — if this
   * list and that one disagreed, the highlight would land somewhere Next never
   * goes.
   */
  const order = useMemo(
    () =>
      (scene?.tokens || [])
        .filter((t) => t.initiative !== null && t.initiative !== undefined)
        .sort((a, b) => b.initiative - a.initiative),
    [scene?.tokens]
  );

  const turnMode = Boolean(scene?.turnMode);

  // Only while the list it comes from is on screen. Rows can be taken away
  // under the pointer — the fight ends, the window is folded — and no
  // mouseleave arrives to say so, which would strand the highlight on the map.
  const spotlitId = turnMode ? spotlight : null;

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
        // The server disagrees about who owns this — stop immediately.
        setError(ack?.error || 'You cannot move that token.');
        endDrag();
      }
    });
  }

  function onPointerMove(e) {
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
    const d = dragRef.current;
    if (!d) return;
    // Snap to the grid on drop — or don't, when there isn't one.
    const x = gridOn ? Math.round(d.x) : round2(d.x);
    const y = gridOn ? Math.round(d.y) : round2(d.y);
    const tokenId = d.tokenId;
    endDrag();

    // Nothing moved — don't spend a write on it.
    if (x === d.fromX && y === d.fromY) return;

    // Occupied: silently refuse. Clearing the drag above already returned the
    // token to its stored square, so the move simply doesn't happen — no
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
      const updated = await api.updateScene(scene.id, { ...scene, ...changes });
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s)));
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
      try {
        const updated = await api.updateScene(scene.id, { ...scene, gridSize: value });
        setScenes((prev) =>
          prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s))
        );
        setGridDraft(null); // back to following the scene
      } catch (e) {
        setError(e.message);
      }
    }, GRID_SAVE_MS);
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
      const updated = await api.updateToken(scene.id, tokenForm.token.id, {
        label,
        color,
        borderColor,
        size,
        imageUrl,
        ...stats,
      });
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id
            ? { ...s, tokens: s.tokens.map((t) => (t.id === updated.id ? updated : t)) }
            : s
        )
      );
      return;
    }

    const token = await api.addToken(scene.id, {
      label,
      color,
      borderColor,
      size,
      imageUrl,
      ...stats,
      ownerId: null,
      x: tokenForm.x,
      y: tokenForm.y,
    });
    setScenes((prev) =>
      prev.map((s) => (s.id === scene.id ? { ...s, tokens: [...s.tokens, token] } : s))
    );
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

  // Sized from the map, not the grid — the whole point of the ratio slider.
  const width = mapW * zoom;
  const height = mapH * zoom;

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
            onClick={() => setWheelTarget('zoom')}
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
            // its name — you've said which one you're working on either way.
            onPointerDown={() => setWheelTarget('zoom')}
            title="Scroll over the map to zoom"
          />
          <small>{Math.round(zoom * 100)}%</small>
        </div>

        {isDm && !offline && (
          <>
            {/* Grid ratio: how much of the map one cell covers. The map does
                not change size — only the number of cells over it does. */}
            <div className={`zoom grid-ratio${wheelTarget === 'grid' ? ' wheel-target' : ''}`}>
              <input
                type="checkbox"
                checked={gridOn}
                onChange={(e) => patchScene({ gridOn: e.target.checked })}
                title="Show the grid and snap tokens to it"
                aria-label="Show the grid and snap tokens to it"
              />
              {/* The word used to be the checkbox's label. It picks the wheel
                  now, so the checkbox carries its own aria-label instead —
                  otherwise choosing what to scroll would flick the grid off. */}
              <button
                type="button"
                className="wheel-pick"
                aria-pressed={wheelTarget === 'grid'}
                onClick={() => setWheelTarget('grid')}
                title="Scroll over the map to resize the cells"
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
                onPointerDown={() => setWheelTarget('grid')}
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
        className={`surface-scroll${panning ? ' panning' : ''}`}
        ref={scrollRef}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        onContextMenu={onContextMenu}
      >
        <div
          className="surface"
          ref={surfaceRef}
          style={{
            width,
            height,
            backgroundImage: scene.imageUrl ? `url(${scene.imageUrl})` : 'none',
            '--cell': `${cellPx}px`,
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {gridOn && <div className="grid-overlay" />}

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
                className={`token${movable ? ' movable' : ''}${mine ? ' dragging' : ''}${
                  blocked ? ' blocked' : ''
                }${ghost && !mine ? ' remote' : ''}${
                  token.id === spotlitId ? ' spotlit' : ''
                }`}
                style={{
                  left: pos.x * cellPx,
                  top: pos.y * cellPx,
                  width: token.size * cellPx,
                  height: token.size * cellPx,
                  // A picture replaces the fill, not just the name — cover so a
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
              </div>
            );
          })}
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
              {isDm ? (
                <button onClick={toggleTurnMode} disabled={busy}>
                  {turnMode ? 'Exit Turn mode' : 'Enter Turn mode'}
                </button>
              ) : (
                <small>Nothing here for you yet.</small>
              )}
            </div>
          </div>
        )}
      </div>

      {/* One tracker, shown to the whole table while the fight is on. Only the
          DM can put it away, and doing so is what ends turn mode — so a player
          gets no close button rather than one that betrays them. */}
      {turnMode && (
        <FloatingWindow
          title="Turns"
          storageKey="rpg:turns-window"
          defaultSize={{ w: 380, h: 420 }}
          minSize={TURNS_MIN}
          onClose={isDm ? toggleTurnMode : undefined}
          // No controls of its own, only the spacer that sends the window's own
          // two buttons to the far end of the bar — the same way the sheet and
          // note windows lay their header out.
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
                  // brushing against it. Anyone may ask for it, DM or not — it
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
                          the hover tooltip — a tracker every player can see is
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
                    <span className="turn-init">{t.initiative}</span>
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
          {menu.turnTokenId ? (
            <>
              <button onClick={focusFromTurnList}>Focus</button>
              {isDm && <button onClick={giveTurnTo}>Give turn</button>}
            </>
          ) : menu.tokenId ? (
            <>
              <button onClick={editToken}>Edit</button>
              <button className="danger" onClick={askDeleteToken}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button onClick={ping}>Ping</button>
              <button onClick={focusEveryone}>Focus</button>
              {isDm && <button onClick={openTokenModal}>Create token</button>}
            </>
          )}
        </div>
      )}

      {/* A scene asks for its name to be typed; a token only asks. The scene
          takes every token on it with it and can't be got back, which is the
          test the sheet windows already use — a token is a minute's work. */}
      {confirmDelete && (
        <ConfirmDeleteModal
          name={confirmDelete.name}
          byName={confirmDelete.kind === 'scene'}
          description={
            confirmDelete.kind === 'scene'
              ? 'This deletes the scene, its map and every token standing on it, for everyone at the table. It cannot be undone.'
              : 'This takes the token off the map for everyone at the table.'
          }
          confirmLabel={confirmDelete.kind === 'scene' ? 'Delete scene' : 'Delete token'}
          onConfirm={() =>
            confirmDelete.kind === 'scene'
              ? removeScene(confirmDelete.id)
              : removeToken(confirmDelete.id)
          }
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {tokenForm && (
        <TokenModal
          token={tokenForm.token}
          onSubmit={submitToken}
          onClose={() => setTokenForm(null)}
        />
      )}

      {/* Tokens are made from the map's own right-click menu now — see the
          `Create token` item — so there is no panel here any more. */}
    </div>
  );
}
