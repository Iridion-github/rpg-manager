import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';

// ~30 position updates a second is smooth to the eye and a fraction of the
// frames a pointer actually produces.
const DRAG_EMIT_MS = 33;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How long a grid-slider drag settles before we save it.
const GRID_SAVE_MS = 400;

// Zoom bounds shared by the slider and the wheel, so the two can't disagree.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
// Roughly one mouse-wheel notch. Trackpads emit many small deltas instead, so we
// accumulate and only step once this much has gone by — otherwise a light
// two-finger flick would rocket through the whole zoom range.
const WHEEL_NOTCH = 100;

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Where other people's tokens are *right now*, mid-drag. Never persisted.
  const [ghosts, setGhosts] = useState({});
  // Our own in-flight drag, so the token follows the pointer smoothly.
  const [drag, setDrag] = useState(null);

  const surfaceRef = useRef(null);
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const pannedRef = useRef(false);
  const gridTimer = useRef(null);
  const wheelAcc = useRef(0);
  const zoomAnchor = useRef(null);
  const [panning, setPanning] = useState(false);

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

  // A draft belongs to the scene it was made on.
  useEffect(() => {
    setGridDraft(null);
    clearTimeout(gridTimer.current);
  }, [selectedId]);

  useEffect(() => () => clearTimeout(gridTimer.current), []);

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

  // --- scroll to zoom ---
  // The wheel drives the zoom bar rather than the scrollbars. Registered
  // natively because React attaches wheel listeners as *passive*, where
  // preventDefault() is ignored and the page would scroll anyway.
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

      // Scrolling down (positive delta) zooms out.
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
  }, [zoom, selectedId]);

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

  function onContextMenu(e) {
    // Windows fires contextmenu on mouse-*up*, so a pan that finishes over a
    // token would otherwise pop that token's menu. A gesture that panned never
    // opens a menu, wherever it happens to end.
    if (pannedRef.current) {
      pannedRef.current = false;
      e.preventDefault();
      return;
    }
    // Otherwise: suppress it over the map, leave it alone over a token.
    if (!onToken(e)) e.preventDefault();
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

  const removeScene = () =>
    guard(async () => {
      const goneId = scene.id;
      const i = scenes.findIndex((s) => s.id === goneId);
      await api.deleteScene(goneId);
      const remaining = scenes.filter((s) => s.id !== goneId);
      setScenes(remaining);
      // Step back to the scene above the one you just deleted rather than
      // dropping to an empty tabletop. Deleting the first scene leaves index 0,
      // which is now whatever used to be second; deleting the last one leaves
      // nothing to land on.
      setActiveId(remaining[Math.max(0, i - 1)]?.id || '');
    });

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

  const addToken = (ownerId) =>
    guard(async () => {
      const owner = players.find((p) => p.id === ownerId);
      const token = await api.addToken(scene.id, {
        label: owner ? owner.name : 'NPC',
        color: owner ? owner.color : '#e5534b',
        ownerId: ownerId || null,
        x: 0,
        y: 0,
      });
      setScenes((prev) =>
        prev.map((s) => (s.id === scene.id ? { ...s, tokens: [...s.tokens, token] } : s))
      );
    });

  const removeToken = (tokenId) =>
    guard(async () => {
      await api.deleteToken(scene.id, tokenId);
      setScenes((prev) =>
        prev.map((s) =>
          s.id === scene.id ? { ...s, tokens: s.tokens.filter((t) => t.id !== tokenId) } : s
        )
      );
    });

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

        <label className="zoom">
          Zoom
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            title="Scroll over the map to zoom"
          />
          <small>{Math.round(zoom * 100)}%</small>
        </label>

        {isDm && !offline && (
          <>
            {/* Grid ratio: how much of the map one cell covers. The map does
                not change size — only the number of cells over it does. */}
            <label className="zoom grid-ratio">
              <input
                type="checkbox"
                checked={gridOn}
                onChange={(e) => patchScene({ gridOn: e.target.checked })}
                title="Show the grid and snap tokens to it"
              />
              Grid
              {/* The slider stays live with the grid off: cell size is still
                  the scale tokens are measured in, even when no cells are
                  drawn. Only the readout changes, since there are no rows and
                  columns to count. */}
              <input
                type="range"
                min="16"
                max="240"
                step="1"
                value={gridSize}
                onChange={(e) => onGridSlide(Number(e.target.value))}
                title={gridOn ? 'Cell size relative to the map' : 'Token scale relative to the map'}
              />
              <small>{gridOn ? `${cols}×${rows}` : `${gridSize}px`}</small>
            </label>

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
              {scene.imageUrl ? 'Replace map' : 'Upload map'}
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
            <button className="del" onClick={removeScene} disabled={busy}>
              Delete scene
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}

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
                className={`token${movable ? ' movable' : ''}${mine ? ' dragging' : ''}${
                  blocked ? ' blocked' : ''
                }${ghost && !mine ? ' remote' : ''}`}
                style={{
                  left: pos.x * cellPx,
                  top: pos.y * cellPx,
                  width: token.size * cellPx,
                  height: token.size * cellPx,
                  background: token.color,
                }}
                onPointerDown={(e) => onPointerDown(e, token)}
                title={
                  ghost && !mine
                    ? `${token.label} — being moved by ${ghost.by}`
                    : movable
                      ? `${token.label} (drag to move)`
                      : token.label
                }
              >
                <span className="token-label">{token.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {isDm && !offline && (
        <div className="token-admin">
          <div className="add-token">
            <span>Add token:</span>
            <button onClick={() => addToken(null)} disabled={busy}>
              + NPC
            </button>
            {players.map((p) => (
              <button key={p.id} onClick={() => addToken(p.id)} disabled={busy}>
                + {p.name}
              </button>
            ))}
          </div>
          <ul className="token-list">
            {scene.tokens.map((t) => {
              const owner = players.find((p) => p.id === t.ownerId);
              return (
                <li key={t.id}>
                  <span className="swatch" style={{ background: t.color }} />
                  <span>{t.label}</span>
                  <small>{owner ? owner.name : 'GM / NPC'}</small>
                  <button className="del" onClick={() => removeToken(t.id)} disabled={busy}>
                    ✕
                  </button>
                </li>
              );
            })}
            {scene.tokens.length === 0 && <li className="empty">No tokens on this scene.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
