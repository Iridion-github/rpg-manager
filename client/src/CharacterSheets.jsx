import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAllSheets, cachePutAllSheets, getLastSynced } from './cache.js';
import CharacterSheet from './sheet/CharacterSheet.jsx';
import { abilityMod, blankSheet, signed } from './sheet/rules.js';

// How long we let edits settle before writing them to the server. Typing a
// sentence in a notes field is one save, not one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

export default function CharacterSheets({ canEdit, offline, onOfflineData }) {
  const [sheets, setSheets] = useState([]);
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(0); // in-flight + queued writes

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and the socket handler
  // needs to read the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const readOnly = !canEdit || offline;
  const open = sheets.find((s) => s.id === openId) || null;

  const refresh = useCallback(async () => {
    try {
      const data = await api.listSheets();
      setSheets(data);
      setError('');
      await cachePutAllSheets(data);
      onOfflineData?.(getLastSynced());
    } catch {
      // Server unreachable (your PC is offline) → fall back to the cache,
      // read-only. This is expected behaviour, not an error to alarm about.
      setSheets(await cacheGetAllSheets());
      onOfflineData?.(getLastSynced());
      setError('');
    }
  }, [onOfflineData]);

  const flush = useCallback(
    async (id) => {
      const payload = pending.current.get(id);
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      pending.current.delete(id);
      if (!payload) return;
      try {
        await api.updateSheet(id, payload);
      } catch (e) {
        setError(e.message);
        refresh();
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [refresh]
  );

  // Apply an edit locally right away, then schedule the save.
  const queueSave = useCallback(
    (next) => {
      setSheets((prev) => prev.map((s) => (s.id === next.id ? next : s)));
      if (!pending.current.has(next.id)) setSaving((n) => n + 1);
      pending.current.set(next.id, next);
      clearTimeout(timers.current.get(next.id));
      timers.current.set(next.id, setTimeout(() => flush(next.id), SAVE_DEBOUNCE_MS));
    },
    [flush]
  );

  // Apply someone else's change as a delta instead of refetching the list.
  const applyRemote = useCallback(({ action, record, origin }) => {
    if (origin === clientId) return; // our own echo; already applied locally
    if (!record?.id) return;
    // Don't overwrite a sheet the user is mid-edit on — our queued write wins.
    if (action !== 'delete' && pending.current.has(record.id)) return;
    setSheets((prev) => {
      if (action === 'delete') return prev.filter((s) => s.id !== record.id);
      const i = prev.findIndex((s) => s.id === record.id);
      if (i === -1) return [...prev, record];
      const next = prev.slice();
      next[i] = record;
      return next;
    });
  }, []);

  useEffect(() => {
    refresh();
    socket.on('connect', refresh); // reconnected → re-sync
    socket.on('sheets:changed', applyRemote);
    return () => {
      socket.off('connect', refresh);
      socket.off('sheets:changed', applyRemote);
    };
  }, [refresh, applyRemote]);

  // Don't lose a debounced edit when the tab is hidden or closed.
  useEffect(() => {
    const flushAll = () => {
      for (const id of [...pending.current.keys()]) flush(id);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushAll();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flushAll);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushAll);
      flushAll();
    };
  }, [flush]);

  // Keep the offline snapshot current as live edits land, without hammering
  // IndexedDB on every keystroke.
  useEffect(() => {
    if (offline) return;
    const t = setTimeout(() => {
      cachePutAllSheets(sheets).then(() => onOfflineData?.(getLastSynced()));
    }, 800);
    return () => clearTimeout(t);
  }, [sheets, offline, onOfflineData]);

  async function addSheet() {
    if (readOnly) return;
    try {
      // Not optimistic: only the server can mint the record's id.
      const record = await api.createSheet({ ...blankSheet(), name: 'New Character' });
      setSheets((prev) => [...prev, record]);
      setOpenId(record.id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeSheet(id) {
    if (readOnly) return;
    const prev = sheets;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    if (pending.current.delete(id)) setSaving((n) => n - 1);
    setSheets((cur) => cur.filter((s) => s.id !== id));
    if (openId === id) setOpenId('');
    try {
      await api.deleteSheet(id);
    } catch (e) {
      setError(e.message);
      setSheets(prev); // put it back
    }
  }

  // --- the open sheet ---
  if (open) {
    return (
      <div className="sheets-view open">
        <div className="sheet-toolbar">
          <button className="linky" onClick={() => setOpenId('')}>
            ← All characters
          </button>
          {saving > 0 && <span className="badge saving">saving…</span>}
          {readOnly && <span className="badge role anon">read-only</span>}
          <div className="spacer" />
          {!readOnly && (
            <button className="del" onClick={() => removeSheet(open.id)}>
              Delete character
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <CharacterSheet sheet={open} onChange={queueSave} readOnly={readOnly} />
      </div>
    );
  }

  // --- the roster of characters ---
  return (
    <div className="sheets-view">
      <div className="sheet-toolbar">
        {saving > 0 && <span className="badge saving">saving…</span>}
        <div className="spacer" />
        {!readOnly && <button onClick={addSheet}>+ New character</button>}
      </div>

      {error && <p className="error">{error}</p>}

      <ul className="sheet-cards">
        {sheets.map((s) => (
          <li key={s.id}>
            <button className="sheet-card" onClick={() => setOpenId(s.id)}>
              <strong>{s.name || 'Unnamed'}</strong>
              <span>
                {[s.race, s.class && `${s.class} ${s.level ?? 1}`].filter(Boolean).join(' · ') ||
                  'No class yet'}
              </span>
              <div className="card-stats">
                <span>
                  HP {s.hp?.current ?? 0}/{s.hp?.max ?? 0}
                </span>
                <span>AC {s.armorClass ?? 10}</span>
                <span>
                  {/* A quick read on the character without opening them up. */}
                  STR {signed(abilityMod(s.abilities?.str))} DEX{' '}
                  {signed(abilityMod(s.abilities?.dex))} CON{' '}
                  {signed(abilityMod(s.abilities?.con))}
                </span>
              </div>
            </button>
          </li>
        ))}
        {sheets.length === 0 && (
          <li className="empty">{offline ? 'No cached characters yet.' : 'No characters yet.'}</li>
        )}
      </ul>
    </div>
  );
}
