import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced } from './cache.js';
import FloatingWindow from './FloatingWindow.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

// Same reasoning as the character sheets: typing a paragraph is one save, not
// one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

/**
 * Note windows sit in their own band above the character sheets' (which run
 * from 40) rather than sharing one.
 *
 * Neither component can see the other's windows, so a shared range would let a
 * note and a sheet hold the same z — and clicking the one behind could not
 * bring it forward. A band each is predictable and never traps a window; the
 * cost is that a sheet can't be raised over a note. Both stay under the map's
 * context menu (450) and the dialogs (500).
 */
const WIN_Z_BASE = 402;
const WIN_Z_CEILING = 440;

/**
 * Notes (DM) and handouts (everyone else) — the same records, seen from two
 * sides. The server sends a player only the notes marked shared, so this
 * component never has to decide what to hide: it renders what it was given.
 *
 * Mounted for as long as the campaign is, not for as long as its tab is shown:
 * a note popped out into a window has to survive a trip to the map. `showList`
 * is what the tab actually switches — off, this renders nothing but the open
 * windows, and keeps saving and syncing in the background.
 */
export default function Notes({
  canEdit,
  offline,
  campaignId,
  onOfflineData,
  showList = true,
}) {
  const [notes, setNotes] = useState([]);
  const [openId, setOpenId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(0); // in-flight + queued writes
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  // Notes popped out into their own windows, back to front. Same shape as the
  // character sheets': the order is the stacking order, and asking for one
  // that's already up brings it forward.
  const [windowIds, setWindowIds] = useState([]);

  // Edits waiting to be written, keyed by note id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and a refresh landing
  // mid-typing needs the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());
  const picked = useRef(false);

  const readOnly = !canEdit || offline;
  const open = notes.find((n) => n.id === openId) || null;

  // Skipping any id whose note has gone — deleted here, or unshared by the DM
  // and withdrawn from a player over the socket.
  const openWindows = windowIds.map((id) => notes.find((n) => n.id === id)).filter(Boolean);
  const confirmNote = notes.find((n) => n.id === confirmDeleteId) || null;

  const openWindow = (id) => setWindowIds((prev) => [...prev.filter((x) => x !== id), id]);
  const closeWindow = (id) => setWindowIds((prev) => prev.filter((x) => x !== id));

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
    if (openId === id) setOpenId('');
    closeWindow(id);
    try {
      await api.deleteNote(id);
    } catch (e) {
      setError(e.message);
      setNotes(prev); // put it back
      throw e; // and let the dialog that asked say so, rather than closing
    }
  }

  const edit = (patch) => queueSave({ ...open, ...patch });

  // The list, with any popped-out notes floating above it. The windows are its
  // siblings rather than its children: they outlive the tab, so they can't hang
  // off a list that isn't being rendered.
  return (
    <>
      {showList && (
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

          {open && (
            <NoteView
              note={open}
              readOnly={readOnly}
              onEdit={edit}
              onShare={(shared) => queueSave({ ...open, shared }, { immediate: true })}
              onDelete={() => setConfirmDeleteId(open.id)}
              // Only offered from the pane. Inside a window it would be a
              // button to open the window you are already looking at.
              onPopOut={() => openWindow(open.id)}
              popOutLabel={windowIds.includes(open.id) ? 'Bring window forward' : 'Open in window'}
            />
          )}
        </div>
      </div>
    </div>
      )}

      {/* One window per popped-out note, painted in the order they were last
          reached for — the same arrangement the character sheets use. */}
      {openWindows.map((note, i) => (
        <FloatingWindow
          key={note.id}
          title={note.title || 'Untitled note'}
          storageKey={`rpg:note-window:${note.id}`}
          zIndex={Math.min(WIN_Z_BASE + i, WIN_Z_CEILING)}
          cascade={i}
          isTop={i === openWindows.length - 1}
          defaultSize={{ w: 560, h: 520 }}
          onFocus={() => openWindow(note.id)}
          onClose={() => closeWindow(note.id)}
          controls={
            <>
              {readOnly && <span className="badge role anon">read-only</span>}
              <div className="spacer" />
              {!readOnly && (
                <>
                  <ShareToggle
                    note={note}
                    onShare={(shared) => queueSave({ ...note, shared }, { immediate: true })}
                  />
                  <button className="del" onClick={() => setConfirmDeleteId(note.id)}>
                    Delete note
                  </button>
                </>
              )}
            </>
          }
        >
          <NoteView
            note={note}
            readOnly={readOnly}
            onEdit={(patch) => queueSave({ ...note, ...patch })}
            onShare={(shared) => queueSave({ ...note, shared }, { immediate: true })}
            // Delete lives in the window's own header, where every other
            // window keeps it, rather than twice in the same frame.
            inWindow
          />
        </FloatingWindow>
      ))}

      {confirmNote && (
        <ConfirmDeleteModal
          name={confirmNote.title || 'Untitled note'}
          description={
            confirmNote.shared
              ? 'This note is shared, so it disappears from your players’ handouts too. It can’t be undone.'
              : 'This deletes the note for good. It can’t be undone.'
          }
          confirmLabel="Delete note"
          onConfirm={() => removeNote(confirmNote.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}
    </>
  );
}

/**
 * One note, read or edited — the same thing whether it's in the side pane or
 * floating in a window of its own, so both render this rather than each
 * growing its own copy that drifts from the other.
 */
/**
 * The one switch that decides who else can read this.
 *
 * A button rather than a checkbox because it is an action with a consequence at
 * the table — a handout appearing in front of the players — and because what it
 * says should be what happens when you press it. Its label is the next state,
 * not the current one; the colour carries the current one.
 */
function ShareToggle({ note, onShare }) {
  const shared = Boolean(note.shared);
  return (
    <button
      className={`note-share-toggle${shared ? ' on' : ''}`}
      onClick={() => onShare(!shared)}
      title={
        shared
          ? 'Every player can read this. Press to take it back.'
          : 'Only you can see this. Press to hand it to the players, read-only.'
      }
      aria-pressed={shared}
    >
      {shared ? 'Hide note' : 'Share note'}
    </button>
  );
}

function NoteView({ note, readOnly, onEdit, onShare, onDelete, onPopOut, popOutLabel, inWindow }) {
  if (readOnly) {
    return (
      <article className="note-read">
        <h3>{note.title || 'Untitled note'}</h3>
        {/* Whitespace is preserved in CSS, so the DM's line breaks and
            paragraphs survive without a markdown renderer. */}
        <p className="note-body">{note.body || 'This handout is empty.'}</p>
        {onPopOut && (
          <button className="linky" onClick={onPopOut}>
            ⧉ {popOutLabel}
          </button>
        )}
      </article>
    );
  }

  return (
    <div className="note-edit">
      <input
        className="note-title-input"
        value={note.title}
        maxLength={120}
        placeholder="Title"
        onChange={(e) => onEdit({ title: e.target.value })}
      />

      <div className="note-controls">
        <div className="spacer" />
        {onPopOut && (
          <button onClick={onPopOut} title="Open this note in a window you can move and resize">
            ⧉ {popOutLabel}
          </button>
        )}
        {/* In a window this pair lives in the window's own header instead, so
            neither of them appears twice in the same frame. */}
        {!inWindow && (
          <>
            <ShareToggle note={note} onShare={onShare} />
            <button className="del" onClick={onDelete}>
              Delete note
            </button>
          </>
        )}
      </div>

      <textarea
        className="note-body-input"
        value={note.body}
        maxLength={20000}
        placeholder="Prep, secrets, the text of a letter the party just found…"
        onChange={(e) => onEdit({ body: e.target.value })}
      />
    </div>
  );
}
