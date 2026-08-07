import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAllSheets, cachePutAllSheets, getLastSynced } from './cache.js';

const BLANK = { name: '', class: '', level: 1, hp: 10, maxHp: 10, ac: 10, notes: '' };

// How long we let edits settle before writing them to the server. Typing a
// sentence in a notes field is one save, not one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

export default function CharacterSheets({ canEdit, offline, onOfflineData }) {
  const [sheets, setSheets] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(BLANK);
  const [saving, setSaving] = useState(0); // in-flight + queued writes

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and the socket handler
  // needs to read the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const readOnly = !canEdit || offline;

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
        // The optimistic edit didn't stick — show why and resync to the truth.
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

  async function addSheet(e) {
    e.preventDefault();
    if (readOnly) return;
    try {
      // Not optimistic: only the server can mint the record's id.
      const record = await api.createSheet({ ...draft, name: draft.name || 'New Character' });
      setSheets((prev) => [...prev, record]);
      setDraft(BLANK);
    } catch (e) {
      setError(e.message);
    }
  }

  function patch(sheet, changes) {
    if (readOnly) return;
    queueSave({ ...sheet, ...changes });
  }

  async function removeSheet(id) {
    if (readOnly) return;
    const prev = sheets;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    if (pending.current.delete(id)) setSaving((n) => n - 1);
    setSheets((cur) => cur.filter((s) => s.id !== id));
    try {
      await api.deleteSheet(id);
    } catch (e) {
      setError(e.message);
      setSheets(prev); // put it back
    }
  }

  return (
    <div className="sheets-view">
      {saving > 0 && <span className="badge saving">saving…</span>}
      {error && <p className="error">{error}</p>}

      {!readOnly && (
        <form className="new-sheet" onSubmit={addSheet}>
          <input
            placeholder="Character name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            placeholder="Class"
            value={draft.class}
            onChange={(e) => setDraft({ ...draft, class: e.target.value })}
          />
          <input
            type="number"
            title="Level"
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
          />
          <button type="submit">+ Add character</button>
        </form>
      )}

      <ul className="sheets">
        {sheets.map((s) => (
          <li key={s.id} className="sheet">
            <div className="sheet-head">
              <strong>{s.name}</strong>
              <span>
                {s.class} · Lv {s.level}
              </span>
              {!readOnly && (
                <button className="del" onClick={() => removeSheet(s.id)}>
                  ✕
                </button>
              )}
            </div>
            <div className="stats">
              <label>
                HP
                <input
                  type="number"
                  value={s.hp}
                  onChange={(e) => patch(s, { hp: e.target.value })}
                  disabled={readOnly}
                />
                / {s.maxHp}
              </label>
              <label>
                AC
                <input
                  type="number"
                  value={s.ac}
                  onChange={(e) => patch(s, { ac: e.target.value })}
                  disabled={readOnly}
                />
              </label>
            </div>
            <textarea
              placeholder="Notes…"
              value={s.notes}
              onChange={(e) => patch(s, { notes: e.target.value })}
              disabled={readOnly}
            />
          </li>
        ))}
        {sheets.length === 0 && (
          <li className="empty">{offline ? 'No cached characters yet.' : 'No characters yet.'}</li>
        )}
      </ul>
    </div>
  );
}
