import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced } from './cache.js';
import CharacterSheet from './sheet/CharacterSheet.jsx';
import { abilityMod, blankSheet, signed } from './sheet/rules.js';

// How long we let edits settle before writing them to the server. Typing a
// sentence in a notes field is one save, not one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

export default function CharacterSheets({ actor, players, offline, campaignId, onOfflineData }) {
  const [sheets, setSheets] = useState([]);
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(0); // in-flight + queued writes
  const [accessOpen, setAccessOpen] = useState(false);

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and the socket handler
  // needs to read the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const isDm = actor?.role === 'dm';
  const open = sheets.find((s) => s.id === openId) || null;

  // Permission is per sheet, and the DM here may be a player at the next
  // table along. The server has already filtered the list to what we may see,
  // so the only question left is whether this particular sheet is ours to
  // change — and the server checks that again on write regardless of what we
  // render.
  const canEditSheet = (sheet) =>
    Boolean(sheet) && (isDm || sheet.access?.[actor?.userId] === 'edit');
  const readOnly = offline || !canEditSheet(open);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listSheets();
      setSheets(data);
      setError('');
      await cachePutAll('sheets', campaignId, data);
      onOfflineData?.(getLastSynced());
    } catch {
      // Server unreachable (your PC is offline) → fall back to the cache,
      // read-only. This is expected behaviour, not an error to alarm about.
      setSheets(await cacheGetAll('sheets', campaignId));
      onOfflineData?.(getLastSynced());
      setError('');
    }
  }, [onOfflineData, campaignId]);

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
      cachePutAll('sheets', campaignId, sheets).then(() => onOfflineData?.(getLastSynced()));
    }, 800);
    return () => clearTimeout(t);
  }, [sheets, offline, onOfflineData, campaignId]);

  // Creating and deleting characters stays the DM's, whoever can edit one.
  const canManage = isDm && !offline;

  async function addSheet() {
    if (!canManage) return;
    try {
      // Not optimistic: only the server can mint the record's id. It arrives
      // visible to nobody but the DM until they hand it out below.
      const record = await api.createSheet({ ...blankSheet(), name: 'New Character' });
      setSheets((prev) => [...prev, record]);
      setOpenId(record.id);
      setAccessOpen(true); // the next question is always "whose is it?"
    } catch (e) {
      setError(e.message);
    }
  }

  // Access changes save at once rather than on the typing debounce — it's a
  // decision, not a keystroke, and it changes what other people can see.
  async function setAccess(sheetId, userId, level) {
    const sheet = sheets.find((s) => s.id === sheetId);
    if (!sheet || !canManage) return;
    const next = { ...(sheet.access || {}) };
    if (level === 'none') delete next[userId];
    else next[userId] = level;

    const prev = sheets;
    setSheets((cur) => cur.map((s) => (s.id === sheetId ? { ...s, access: next } : s)));
    try {
      await api.setSheetAccess(sheetId, next);
      setError('');
    } catch (e) {
      setError(e.message);
      setSheets(prev); // put it back
    }
  }

  async function removeSheet(id) {
    if (!canManage) return;
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
          {canManage && (
            <button
              className={accessOpen ? 'active' : ''}
              onClick={() => setAccessOpen((v) => !v)}
            >
              👥 Who can see this
            </button>
          )}
          {canManage && (
            <button className="del" onClick={() => removeSheet(open.id)}>
              Delete character
            </button>
          )}
        </div>

        {canManage && accessOpen && (
          <AccessPanel sheet={open} players={players} onChange={setAccess} />
        )}

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
        {canManage && <button onClick={addSheet}>+ New character</button>}
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
              {/* Only the GM learns anything from this line: a player is
                  looking at a list of sheets they can already open. */}
              {isDm && <span className="card-access">{accessSummary(s, players)}</span>}
            </button>
          </li>
        ))}
        {sheets.length === 0 && (
          <li className="empty">
            {offline
              ? 'No cached characters yet.'
              : isDm
                ? 'No characters yet.'
                : "No characters yet — your GM hasn't given you one."}
          </li>
        )}
      </ul>
    </div>
  );
}

// "GM only" / "Kira can edit · Tom can view" — the GM's answer to "who's got
// this one?" without opening it.
function accessSummary(sheet, players) {
  const entries = Object.entries(sheet.access || {});
  if (entries.length === 0) return 'GM only';
  return entries
    .map(([id, level]) => {
      const player = players.find((p) => p.id === id);
      // A player deleted since is still in the map; name them honestly rather
      // than rendering a raw uuid.
      return `${player?.name || 'former player'} can ${level}`;
    })
    .join(' · ');
}

/**
 * The GM's per-sheet access control. Three states per player, because that's
 * the actual question: nothing, read it, or change it. The GM isn't listed —
 * they can always do everything, and a control that can't be switched off is
 * just a thing to wonder about.
 */
function AccessPanel({ sheet, players, onChange }) {
  return (
    <div className="access-panel">
      <p className="hint">
        You always see every sheet. Choose what each player gets — anyone not
        listed here can't open this character at all.
      </p>
      {players.length === 0 && (
        <p className="empty">No players yet. Add them in the Players tab first.</p>
      )}
      <ul className="access-list">
        {players.map((p) => (
          <li key={p.id}>
            <span className="swatch" style={{ background: p.color }} />
            <strong>{p.name}</strong>
            <select
              value={sheet.access?.[p.id] || 'none'}
              onChange={(e) => onChange(sheet.id, p.id, e.target.value)}
            >
              <option value="none">No access</option>
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
