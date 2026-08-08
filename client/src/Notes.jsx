import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced } from './cache.js';

// Same reasoning as the character sheets: typing a paragraph is one save, not
// one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

/**
 * Notes (DM) and handouts (everyone else) — the same records, seen from two
 * sides. The server sends a player only the notes marked shared, so this
 * component never has to decide what to hide: it renders what it was given.
 */
export default function Notes({ canEdit, offline, campaignId, onOfflineData }) {
  const [notes, setNotes] = useState([]);
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(0); // in-flight + queued writes
  const [confirmDelete, setConfirmDelete] = useState('');

  // Edits waiting to be written, keyed by note id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and a refresh landing
  // mid-typing needs the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());
  const picked = useRef(false);

  const readOnly = !canEdit || offline;
  const open = notes.find((n) => n.id === openId) || null;

  const refresh = useCallback(async () => {
    try {
      const data = await api.listNotes();
      // Server truth for everything except what we're mid-edit on — otherwise
      // a refresh triggered by our own save would undo what we typed since.
      setNotes(data.map((n) => pending.current.get(n.id) || n));
      setError('');
      await cachePutAll('notes', campaignId, data);
      onOfflineData?.(getLastSynced());
    } catch {
      // Server unreachable (the host PC is off) → the cached handouts, which
      // is exactly what the offline mode is for: reading the table's material.
      setNotes(await cacheGetAll('notes', campaignId));
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
        await api.updateNote(id, payload);
      } catch (e) {
        setError(e.message);
        refresh();
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [refresh]
  );

  // Apply an edit locally right away, then schedule the save. `immediate` is
  // for discrete clicks (sharing) rather than typing — waiting out a debounce
  // to see a checkbox take effect feels broken.
  const queueSave = useCallback(
    (next, { immediate = false } = {}) => {
      setNotes((prev) => prev.map((n) => (n.id === next.id ? next : n)));
      if (!pending.current.has(next.id)) setSaving((n) => n + 1);
      pending.current.set(next.id, next);
      clearTimeout(timers.current.get(next.id));
      if (immediate) flush(next.id);
      else timers.current.set(next.id, setTimeout(() => flush(next.id), SAVE_DEBOUNCE_MS));
    },
    [flush]
  );

  // A note change arrives as a bare signal — see the server's announce() — so
  // there is no record to merge, only a reason to re-read our own filtered view.
  const onChanged = useCallback(
    ({ origin }) => {
      if (origin === clientId) return; // our own echo; already applied locally
      refresh();
    },
    [refresh]
  );

  useEffect(() => {
    refresh();
    socket.on('connect', refresh); // reconnected → re-sync
    socket.on('notes:changed', onChanged);
    return () => {
      socket.off('connect', refresh);
      socket.off('notes:changed', onChanged);
    };
  }, [refresh, onChanged]);

  // Land on something readable instead of an empty pane, but only on the first
  // load — re-picking after every refresh would fight with the reader.
  useEffect(() => {
    if (picked.current || notes.length === 0) return;
    picked.current = true;
    setOpenId(notes[0].id);
  }, [notes]);

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

  async function addNote() {
    if (readOnly) return;
    try {
      // Not optimistic: only the server can mint the record's id. New notes
      // start private — sharing is a decision, not a default.
      const record = await api.createNote({ title: 'New note', body: '', shared: false });
      setNotes((prev) => [...prev, record]);
      setOpenId(record.id);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeNote(id) {
    if (readOnly) return;
    const prev = notes;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    if (pending.current.delete(id)) setSaving((n) => n - 1);
    setNotes((cur) => cur.filter((n) => n.id !== id));
    setConfirmDelete('');
    if (openId === id) setOpenId('');
    try {
      await api.deleteNote(id);
    } catch (e) {
      setError(e.message);
      setNotes(prev); // put it back
    }
  }

  const edit = (patch) => queueSave({ ...open, ...patch });

  return (
    <div className="notes-view">
      <div className="sheet-toolbar">
        <h2 className="notes-title">{canEdit ? 'Notes & handouts' : 'Handouts'}</h2>
        {saving > 0 && <span className="badge saving">saving…</span>}
        {canEdit && offline && <span className="badge role anon">read-only</span>}
        <div className="spacer" />
        {!readOnly && <button onClick={addNote}>+ New note</button>}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="notes-layout">
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                className={`note-item${n.id === openId ? ' active' : ''}`}
                onClick={() => setOpenId(n.id)}
              >
                <span className="note-item-title">{n.title || 'Untitled note'}</span>
                {/* Only the DM has anything to learn from this: everything a
                    player can see here is shared by definition. */}
                {canEdit && (
                  <span className={`note-flag${n.shared ? ' on' : ''}`}>
                    {n.shared ? 'shared' : 'private'}
                  </span>
                )}
              </button>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="empty">
              {canEdit
                ? 'No notes yet.'
                : offline
                  ? 'No handouts cached yet.'
                  : "Nothing shared yet — your DM hasn't handed anything out."}
            </li>
          )}
        </ul>

        <div className="note-pane">
          {!open && notes.length > 0 && <p className="hint">Pick a note to read it.</p>}

          {open && readOnly && (
            <article className="note-read">
              <h3>{open.title || 'Untitled note'}</h3>
              {/* Whitespace is preserved in CSS, so the DM's line breaks and
                  paragraphs survive without a markdown renderer. */}
              <p className="note-body">{open.body || 'This handout is empty.'}</p>
            </article>
          )}

          {open && !readOnly && (
            <div className="note-edit">
              <input
                className="note-title-input"
                value={open.title}
                maxLength={120}
                placeholder="Title"
                onChange={(e) => edit({ title: e.target.value })}
              />

              <div className="note-controls">
                <label className="note-share" title="Shared notes are readable by every player">
                  <input
                    type="checkbox"
                    checked={Boolean(open.shared)}
                    onChange={(e) =>
                      queueSave({ ...open, shared: e.target.checked }, { immediate: true })
                    }
                  />
                  Share with players
                </label>
                <div className="spacer" />
                {confirmDelete === open.id ? (
                  <>
                    <span className="hint">Delete for good?</span>
                    <button className="del" onClick={() => removeNote(open.id)}>
                      Yes, delete
                    </button>
                    <button onClick={() => setConfirmDelete('')}>Keep</button>
                  </>
                ) : (
                  <button className="del" onClick={() => setConfirmDelete(open.id)}>
                    Delete note
                  </button>
                )}
              </div>

              <textarea
                className="note-body-input"
                value={open.body}
                maxLength={20000}
                placeholder="Prep, secrets, the text of a letter the party just found…"
                onChange={(e) => edit({ body: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
