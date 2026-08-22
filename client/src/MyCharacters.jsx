import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced, MINE } from './cache.js';
import CharacterSheet from './sheet/CharacterSheet.jsx';
import SheetCard from './SheetCard.jsx';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import SheetImportModal from './SheetImportModal.jsx';
import { downloadSheet } from './sheetFile.js';
import { blankSheet } from './sheet/rules.js';

// The same settling time the tab inside a campaign uses, and for the same
// reason: typing a sentence into a notes field is one save, not one per key.
const SAVE_DEBOUNCE_MS = 400;

const WIN_Z_BASE = 40;
const WIN_Z_CEILING = 400;
const clampPercent = (v) => Math.min(100, Math.max(OPACITY_MIN, v));

/**
 * My Characters: your own shelf, and nobody else's business.
 *
 * These are not the tables' sheets and they are not a view onto them. A
 * character gets here by being copied off a campaign sheet - the button in that
 * sheet's window says so - or by being made here from scratch, and either way
 * what lands is a record of your own that nobody else on this server can see.
 *
 * **The copy is not a link, and that is the feature.** Editing the one at the
 * table does not touch the one here, and editing the one here does not reach
 * into somebody's campaign. So this is where a character can be kept as they
 * were at the end of a campaign, or built up before there is a table to bring
 * them to, without either version moving under the other.
 *
 * Two things the tab inside a campaign has are missing, both because there is
 * no table here to do them to: Sharing mode posts part of a sheet to a chat,
 * and the dice put a throw in that same log. The Campaign box at the top of a
 * sheet is what this one adds, and it is a note rather than a link: the name of
 * the table the copy was taken from, as it was called on the day.
 */
export default function MyCharacters({ offline, onOfflineData, showRoster = true }) {
  const [sheets, setSheets] = useState([]);
  // Open sheets, back to front - the last is the one on top. Same arrangement
  // as the campaign's own tab: the order is the stacking order.
  const [openIds, setOpenIds] = useState([]);
  const [opacities, setOpacities] = useState({});
  const [error, setError] = useState('');
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [importId, setImportId] = useState('');

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs rather than state for the same reason as in the campaign's tab: these
  // must not re-render, and the socket handler has to read the current value.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const openSheets = openIds.map((id) => sheets.find((s) => s.id === id)).filter(Boolean);
  const confirmSheet = sheets.find((s) => s.id === confirmDeleteId) || null;
  const importSheetTarget = sheets.find((s) => s.id === importId) || null;

  const openSheet = (id) => setOpenIds((prev) => [...prev.filter((x) => x !== id), id]);
  const closeSheet = (id) => setOpenIds((prev) => prev.filter((x) => x !== id));

  // Every character here is yours, so the only thing that can make one
  // read-only is having no server to write to.
  const readOnly = offline;

  const opacityKey = (id) => `rpg:sheet-opacity:${id}`;
  const opacityOf = (id) => {
    if (opacities[id] !== undefined) return opacities[id];
    const saved = Number(localStorage.getItem(opacityKey(id)));
    return Number.isFinite(saved) && saved > 0 ? clampPercent(saved) : 100;
  };

  function setOpacityOf(id, next) {
    setOpacities((prev) => ({ ...prev, [id]: next }));
    try {
      localStorage.setItem(opacityKey(id), String(next));
    } catch {
      // Private mode, or a full quota. It still fades; it just won't remember.
    }
  }

  const markSaving = (id, busy) =>
    setSavingIds((prev) => {
      if (busy === prev.has(id)) return prev; // nothing to say
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const refresh = useCallback(async () => {
    try {
      const data = await api.listMySheets();
      setSheets(data);
      setError('');
      await cachePutAll('sheets', MINE, data);
      onOfflineData?.(getLastSynced());
    } catch {
      // Server unreachable → the last snapshot, read-only. Expected behaviour
      // rather than an error to alarm about, exactly as at a table.
      setSheets(await cacheGetAll('sheets', MINE));
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
        await api.updateMySheet(id, payload);
      } catch (e) {
        setError(e.message);
        refresh();
      } finally {
        markSaving(id, false);
      }
    },
    [refresh]
  );

  // Apply an edit locally right away, then schedule the save.
  const queueSave = useCallback(
    (next) => {
      setSheets((prev) => prev.map((s) => (s.id === next.id ? next : s)));
      markSaving(next.id, true);
      pending.current.set(next.id, next);
      clearTimeout(timers.current.get(next.id));
      timers.current.set(next.id, setTimeout(() => flush(next.id), SAVE_DEBOUNCE_MS));
    },
    [flush]
  );

  /**
   * The same shelf, changed in another tab of yours.
   *
   * The only audience these records have is the account that owns them, so this
   * is a much smaller question than the campaign side's: one person, possibly
   * two windows. Saving a character from a campaign in one tab should make it
   * appear here in the other without a reload, which is the whole of it.
   */
  const applyRemote = useCallback(({ action, record, origin }) => {
    if (origin === clientId) return; // our own echo; already applied locally
    if (!record?.id) return;
    // Don't overwrite a sheet being typed into - our queued write wins.
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
    socket.on('mysheets:changed', applyRemote);
    return () => {
      socket.off('connect', refresh);
      socket.off('mysheets:changed', applyRemote);
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

  /**
   * Replace a character with the one out of a file.
   *
   * Written at once rather than through the debounced save, exactly as at the
   * table: this is a whole sheet arriving rather than an edit somebody is in
   * the middle of, and anything already queued describes the character being
   * replaced.
   */
  const importSheet = useCallback(async (id, incoming) => {
    pending.current.delete(id);
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    markSaving(id, false);
    const saved = await api.updateMySheet(id, { ...incoming, id });
    setSheets((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    setError('');
  }, []);

  async function addSheet() {
    if (offline) return;
    try {
      // Not optimistic: only the server mints the id. Nothing else about a new
      // one is in question here - it is yours the moment it exists, there being
      // nobody else it could belong to.
      const record = await api.createMySheet({ ...blankSheet(), name: 'New Character' });
      setSheets((prev) => [...prev, record]);
      openSheet(record.id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeSheet(id) {
    const prev = sheets;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    pending.current.delete(id);
    markSaving(id, false);
    setSheets((cur) => cur.filter((s) => s.id !== id));
    closeSheet(id);
    try {
      await api.deleteMySheet(id);
    } catch (e) {
      setError(e.message);
      setSheets(prev); // put it back
      throw e; // and let the dialog that asked say so, rather than closing
    }
  }

  return (
    <>
      {showRoster && (
        <div className="sheets-view">
          <div className="sheet-toolbar">
            {[...savingIds].some((id) => !openIds.includes(id)) && (
              <span className="badge saving">saving…</span>
            )}
          </div>

          {error && <p className="error">{error}</p>}

          <ul className="sheet-cards">
            {/* First in the grid for the same reason it is at the table: an
                open sheet floats over this page, and the top-left cell is the
                one place a centred window cannot cover. */}
            {!offline && (
              <li>
                <button className="sheet-card new" onClick={addSheet}>
                  <strong>+ New character</strong>
                  <span>Yours alone, at no table</span>
                </button>
              </li>
            )}
            {sheets.map((s) => (
              <li key={s.id}>
                <SheetCard
                  sheet={s}
                  open={openIds.includes(s.id)}
                  onOpen={() => openSheet(s.id)}
                  // Where the copy came from, on the cards that have an answer.
                  // A character made here has none, and a card saying "from
                  // nowhere" would be a line spent on nothing.
                  note={s.savedFrom && `from ${s.savedFrom}`}
                />
              </li>
            ))}
            {sheets.length === 0 && offline && (
              <li className="empty">No cached characters yet.</li>
            )}
          </ul>

          {/* Under the grid rather than over it: it explains the empty shelf
              somebody is looking at, and once there is anything on it the
              answer is on screen instead. */}
          {sheets.length === 0 && !offline && (
            <p className="hint">
              Nothing here yet. Make one above, or open a character at one of your tables and
              press <strong>Save to My Characters</strong> to keep a copy of them here.
            </p>
          )}
        </div>
      )}

      {/* One window per open sheet, sharing its box with the same character's
          window at the table: the storage key is the sheet's, not this view's,
          so a character you keep in the corner opens back in that corner
          wherever you opened them from. */}
      {openSheets.map((sheet, i) => (
        <FloatingWindow
          key={sheet.id}
          title={sheet.name || 'Unnamed'}
          storageKey={`rpg:sheet-window:${sheet.id}`}
          fallbackKey="rpg:sheet-window"
          zIndex={Math.min(WIN_Z_BASE + i, WIN_Z_CEILING)}
          cascade={i}
          isTop={i === openSheets.length - 1}
          poppable
          onFocus={() => openSheet(sheet.id)}
          onClose={() => closeSheet(sheet.id)}
          opacity={opacityOf(sheet.id) / 100}
          onOpacityChange={(next) => setOpacityOf(sheet.id, next)}
          controls={
            <>
              {savingIds.has(sheet.id) && <span className="badge saving">saving…</span>}
              {readOnly && <span className="badge role anon">read-only</span>}
              <div className="spacer" />
              {/* No Sharing mode and no Save to My Characters: the first posts
                  to a table's chat and there is no table here, and the second
                  would be copying this shelf onto itself. */}
              <button onClick={() => downloadSheet(sheet)} title="Save this character as a file">
                Export
              </button>
              {!readOnly && (
                <button
                  onClick={() => setImportId(sheet.id)}
                  title="Replace this character with one from a file"
                >
                  Import
                </button>
              )}
              {/* No DM to ask. This copy is yours, and deleting it takes
                  nothing from anybody - least of all from the table it came
                  from, which has its own. */}
              {!readOnly && (
                <button className="del" onClick={() => setConfirmDeleteId(sheet.id)}>
                  Delete character
                </button>
              )}
            </>
          }
        >
          <CharacterSheet
            sheet={sheet}
            onChange={queueSave}
            readOnly={readOnly}
            // The two things this view hasn't got, and the one it has.
            canRoll={false}
            campaignLabel={sheet.savedFrom || ''}
            // The image cloud belongs to a campaign and is read through it.
            // There is no campaign in scope out here, so the portrait takes the
            // two roads that need none: a file, or the clipboard.
            canCloud={false}
          />
        </FloatingWindow>
      ))}

      {confirmSheet && (
        <ConfirmDeleteModal
          name={confirmSheet.name || 'Unnamed'}
          byName
          description="This removes your copy of the character. Any version of them at a table is a separate sheet and is not touched. It can't be undone."
          onConfirm={() => removeSheet(confirmSheet.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}

      {importSheetTarget && (
        <SheetImportModal
          sheet={importSheetTarget}
          onConfirm={(incoming) => importSheet(importSheetTarget.id, incoming)}
          onClose={() => setImportId('')}
        />
      )}
    </>
  );
}
