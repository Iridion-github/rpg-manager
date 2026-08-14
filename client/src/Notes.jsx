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
 * note and a sheet hold the same z - and clicking the one behind could not
 * bring it forward. A band each is predictable and never traps a window; the
 * cost is that a sheet can't be raised over a note. Both stay under the map's
 * context menu (450) and the dialogs (500).
 */
const WIN_Z_BASE = 402;
const WIN_Z_CEILING = 440;

/**
 * Notes (DM) and handouts (everyone else) - the same records, seen from two
 * sides. The server sends each person only the notes they may read, so this
 * component never has to decide what to hide: it renders what it was given.
 *
 * What it does decide is what may be *changed*, and that is per note rather
 * than per person: a note belongs to whoever wrote it, so a second DM reads
 * another's shared prep exactly the way a player reads a handout. See mayEdit.
 *
 * Mounted for as long as the campaign is, not for as long as its tab is shown:
 * a note popped out into a window has to survive a trip to the map. `showList`
 * is what the tab actually switches - off, this renders nothing but the open
 * windows, and keeps saving and syncing in the background.
 */
export default function Notes({
  actor,
  players = [],
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

  // Whether new notes can be written at all: the DM's drawer, and not while the
  // server is unreachable. Whether an *existing* note can be changed is a
  // different question - see mayEdit.
  const readOnly = !canEdit || offline;
  const open = notes.find((n) => n.id === openId) || null;

  /**
   * May this person change this note?
   *
   * The author, and nobody else, however widely it is shared - being given a
   * note is being given something to read. A note with no author predates the
   * field and belongs to the DM's chair rather than to a person, which is what
   * it always did; the server draws the same line, and this only decides what
   * to put on screen.
   */
  const mayEdit = useCallback(
    (note) =>
      Boolean(note) &&
      !offline &&
      (note.createdBy ? note.createdBy === actor?.userId : Boolean(canEdit)),
    [offline, actor?.userId, canEdit]
  );

  // Skipping any id whose note has gone - deleted here, or unshared by the DM
  // and withdrawn from a player over the socket.
  const openWindows = windowIds.map((id) => notes.find((n) => n.id === id)).filter(Boolean);
  const confirmNote = notes.find((n) => n.id === confirmDeleteId) || null;

  const openWindow = (id) => setWindowIds((prev) => [...prev.filter((x) => x !== id), id]);
  const closeWindow = (id) => setWindowIds((prev) => prev.filter((x) => x !== id));

  const refresh = useCallback(async () => {
    try {
      const data = await api.listNotes();
      // Server truth for everything except what we're mid-edit on - otherwise
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
  // for discrete clicks (sharing) rather than typing - waiting out a debounce
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

  // A note change arrives as a bare signal - see the server's announce() - so
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
  // load - re-picking after every refresh would fight with the reader.
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
      // start private - sharing is a decision, not a default.
      const record = await api.createNote({
        title: 'New note',
        body: '',
        visibility: 'private',
        sharedWith: [],
      });
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
                {/* Only on the notes you could change: a note somebody has
                    handed you is one you can read, and saying "shared" over it
                    describes your own screen back to you. */}
                {mayEdit(n) && (
                  <span className={`note-flag ${n.visibility || 'private'}`}>
                    {flagLabel(n, players)}
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
                  : "Nothing shared yet - your DM hasn't handed anything out."}
            </li>
          )}
        </ul>

        <div className="note-pane">
          {!open && notes.length > 0 && <p className="hint">Pick a note to read it.</p>}

          {open && (
            <NoteView
              note={open}
              readOnly={!mayEdit(open)}
              players={players}
              actor={actor}
              onEdit={edit}
              // Sharing is a click with a consequence at the table rather than
              // typing, so it goes at once instead of waiting out the debounce.
              onShare={(patch) => queueSave({ ...open, ...patch }, { immediate: true })}
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
          reached for - the same arrangement the character sheets use. */}
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
              {!mayEdit(note) && <span className="badge role anon">read-only</span>}
              <div className="spacer" />
              {mayEdit(note) && (
                <button className="del" onClick={() => setConfirmDeleteId(note.id)}>
                  Delete note
                </button>
              )}
            </>
          }
        >
          <NoteView
            note={note}
            readOnly={!mayEdit(note)}
            players={players}
            actor={actor}
            onEdit={(patch) => queueSave({ ...note, ...patch })}
            onShare={(patch) => queueSave({ ...note, ...patch }, { immediate: true })}
            // Delete lives in the window's own header, where every other
            // window keeps it, rather than twice in the same frame. Sharing
            // does not: it is a panel rather than a button now, and a panel
            // that unfolds inside a header would push the note out of view.
            inWindow
          />
        </FloatingWindow>
      ))}

      {confirmNote && (
        <ConfirmDeleteModal
          name={confirmNote.title || 'Untitled note'}
          description={
            confirmNote.visibility === 'private'
              ? 'This deletes the note for good. It can’t be undone.'
              : 'Somebody else can read this note, so it disappears from their handouts too. It can’t be undone.'
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
 * Who can read this note, said in as few words as fit on a list row.
 *
 * "3 people" rather than their names: a row in the list is a title with a tag
 * beside it, and three names is a second title. The panel below spells it out.
 */
function flagLabel(note, players) {
  const visibility = note.visibility || 'private';
  if (visibility === 'public') return 'everyone';
  if (visibility !== 'shared') return 'private';
  // Counted against the people who are actually here. An id left behind by
  // somebody who has left the table grants them nothing (the server checks
  // membership before it checks a note), so counting it would be reporting a
  // reader who does not exist.
  const n = (note.sharedWith || []).filter((id) => players.some((p) => p.id === id)).length;
  if (n === 0) return 'nobody';
  return n === 1 ? '1 person' : `${n} people`;
}

/** The same answer at length, for the panel's own summary line. */
function shareSummary(note, players) {
  const visibility = note.visibility || 'private';
  if (visibility === 'public') return 'Everyone at this table';
  if (visibility !== 'shared') return 'Nobody but you';
  const names = (note.sharedWith || [])
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => p.name);
  if (names.length === 0) return 'Nobody yet';
  if (names.length <= 3) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} and ${names.length - 2} others`;
}

/**
 * Who else may read this note: nobody, some people, or the whole table.
 *
 * Three states rather than the switch this replaced, because "shared" turned
 * out to be two different decisions wearing one word - handing the party a
 * letter they all just read, and telling one player what their character alone
 * noticed. A switch can only do the first.
 *
 * Public is deliberately not "everyone, as a list of names": it asks the
 * campaign who its members are at the moment somebody reads it, so a player who
 * joins next month gets the handouts the table already has rather than a
 * silence nobody remembers to fix.
 *
 * Folded away by default, like the character sheets' access panel and for the
 * same reason: it is consulted when a note changes hands, against a note that
 * is read every session. The summary is on the fold, so it never has to be
 * opened to be answered.
 */
function SharePanel({ note, players, actor, onShare }) {
  const visibility = note.visibility || 'private';
  const sharedWith = note.sharedWith || [];
  // Everybody at the table except whoever is doing the sharing - the author
  // reads their own note by definition, so a tick beside their own name would
  // be a control that changes nothing.
  const others = players.filter((p) => p.id !== actor?.userId);

  const choose = (next) => {
    if (next === visibility) return;
    // The list of names is kept when the answer moves off Shared, rather than
    // emptied: switching to Public to read something out and back again should
    // not cost the DM the three ticks they set before.
    onShare({ visibility: next, sharedWith });
  };

  const toggle = (id) => {
    const next = sharedWith.includes(id)
      ? sharedWith.filter((x) => x !== id)
      : [...sharedWith, id];
    onShare({ visibility: 'shared', sharedWith: next });
  };

  return (
    <details className="share-panel">
      <summary>
        Who can read this - <strong>{shareSummary(note, players)}</strong>
      </summary>

      <div className="share-choices">
        {[
          ['private', 'Private', 'Yours alone. Nobody else at the table sees it, DM or player.'],
          ['shared', 'Shared with…', 'Only the people you tick below.'],
          ['public', 'Public', 'Everyone here, and anyone who joins later.'],
        ].map(([value, label, hint]) => (
          <label key={value} className={`share-choice${visibility === value ? ' on' : ''}`}>
            <input
              type="radio"
              name={`share-${note.id}`}
              checked={visibility === value}
              onChange={() => choose(value)}
            />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>

      {/* Only under the answer it belongs to. A list of names beside a note
          marked Public would invite the reading that those are the only
          people who can see it. */}
      {visibility === 'shared' &&
        (others.length === 0 ? (
          <p className="hint">
            Nobody else is at this table yet. Add players under Campaigns → Members and they will
            appear here.
          </p>
        ) : (
          <ul className="share-list">
            {others.map((p) => (
              <li key={p.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={sharedWith.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span>{p.name}</span>
                </label>
                {/* A co-DM is a person at this table like any other, and gets
                    no more of your prep than you give them. Saying which they
                    are is worth one word. */}
                {p.role === 'dm' && <span className="badge role gm">DM</span>}
              </li>
            ))}
          </ul>
        ))}

      <p className="hint">
        Whoever you share it with can read it and nothing more - a note is only ever edited by the
        person who wrote it. Take it back and it disappears from their screen at once, even if they
        have it open.
      </p>
    </details>
  );
}

/**
 * One note, read or edited - the same thing whether it's in the side pane or
 * floating in a window of its own, so both render this rather than each growing
 * its own copy that drifts from the other.
 */
function NoteView({
  note,
  readOnly,
  players = [],
  actor,
  onEdit,
  onShare,
  onDelete,
  onPopOut,
  popOutLabel,
  inWindow,
}) {
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

      {/* In both places, unlike Delete: sharing is the question you ask *about*
          the note you are looking at, so it belongs beside it whether that is
          in the pane or in a window of its own. */}
      <SharePanel note={note} players={players} actor={actor} onShare={onShare} />

      <div className="note-controls">
        <div className="spacer" />
        {onPopOut && (
          <button onClick={onPopOut} title="Open this note in a window you can move and resize">
            ⧉ {popOutLabel}
          </button>
        )}
        {/* In a window this lives in the window's own header instead, so it
            doesn't appear twice in the same frame. */}
        {!inWindow && (
          <button className="del" onClick={onDelete}>
            Delete note
          </button>
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
