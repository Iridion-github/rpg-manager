import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';

// ~30 position updates a second is smooth to the eye and a fraction of the
// frames a pointer actually produces.
const DRAG_EMIT_MS = 33;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function Tabletop({ actor, players, offline }) {
  const [scenes, setScenes] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Where other people's tokens are *right now*, mid-drag. Never persisted.
  const [ghosts, setGhosts] = useState({});
  // Our own in-flight drag, so the token follows the pointer smoothly.
  const [drag, setDrag] = useState(null);

  const surfaceRef = useRef(null);
  const dragRef = useRef(null);

  const isGm = actor?.role === 'gm';
  const rawScene = scenes.find((s) => s.id === activeId) || null;
  // Tokens are always an array from here on, whatever the server sent.
  const scene = rawScene ? { ...rawScene, tokens: rawScene.tokens || [] } : null;

  const canMove = useCallback(
    (token) => {
      if (offline) return false;
      if (isGm) return true;
      return actor?.role === 'player' && token.ownerId && token.ownerId === actor.playerId;
    },
    [actor, isGm, offline]
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
  }, [refresh]);

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

  // --- dragging ---
  const cellPx = (scene?.gridSize || 70) * zoom;

  function pointerCell(e) {
    const rect = surfaceRef.current.getBoundingClientRect();
    return { px: (e.clientX - rect.left) / cellPx, py: (e.clientY - rect.top) / cellPx };
  }

  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    socket.emit('token:drag:end');
  }

  function onPointerDown(e, token) {
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
    const x = clamp(px - d.grabX, 0, (scene.cols || 1) - 1);
    const y = clamp(py - d.grabY, 0, (scene.rows || 1) - 1);
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
    const x = Math.round(d.x); // snap to the grid on drop
    const y = Math.round(d.y);
    const tokenId = d.tokenId;
    endDrag();
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
      setError(e.message);
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
      await api.deleteScene(scene.id);
      setScenes((prev) => prev.filter((s) => s.id !== scene.id));
      setActiveId((cur) => (cur === scene.id ? '' : cur));
    });

  const patchScene = (changes) =>
    guard(async () => {
      const updated = await api.updateScene(scene.id, { ...scene, ...changes });
      setScenes((prev) => prev.map((s) => (s.id === updated.id ? { ...updated, tokens: s.tokens } : s)));
    });

  const uploadMap = (file) =>
    guard(async () => {
      const { url } = await api.uploadImage(file);
      await patchScene({ imageUrl: url });
    });

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
  if (!scene) {
    return (
      <div className="tabletop-empty">
        <p>No scene yet.</p>
        {isGm && !offline && (
          <button onClick={newScene} disabled={busy}>
            + Create a scene
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const width = scene.cols * cellPx;
  const height = scene.rows * cellPx;

  return (
    <div className="tabletop">
      <div className="scene-bar">
        <select value={activeId} onChange={(e) => setActiveId(e.target.value)}>
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
            min="0.4"
            max="2"
            step="0.1"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>

        {isGm && !offline && (
          <>
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

      <div className="surface-scroll">
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
          <div className="grid-overlay" />

          {scene.tokens.map((token) => {
            const mine = drag?.tokenId === token.id ? drag : null;
            const ghost = ghosts[token.id];
            const pos = mine || ghost || token;
            const movable = canMove(token);
            return (
              <div
                key={token.id}
                className={`token${movable ? ' movable' : ''}${mine ? ' dragging' : ''}${
                  ghost && !mine ? ' remote' : ''
                }`}
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

      {isGm && !offline && (
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
