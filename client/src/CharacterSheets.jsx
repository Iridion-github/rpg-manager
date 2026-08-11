import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced } from './cache.js';
import CharacterSheet from './sheet/CharacterSheet.jsx';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import { abilityMod, blankSheet, signed } from './sheet/rules.js';

// How long we let edits settle before writing them to the server. Typing a
// sentence in a notes field is one save, not one save per keystroke.
const SAVE_DEBOUNCE_MS = 400;

// Open sheets stack from here, one step each. The ceiling matters: without it a
// long enough stack would climb over the map's context menu and the dice
// dialogs, which have to stay on top. See the bands noted in styles.css.
const WIN_Z_BASE = 40;

const clampPercent = (v) => Math.min(100, Math.max(OPACITY_MIN, v));
const WIN_Z_CEILING = 400;

/**
 * The characters at a table: a roster of cards, and one sheet open in a window
 * floating above everything.
 *
 * Mounted for as long as the campaign is, not for as long as its tab is shown —
 * an open sheet has to survive a trip to the map. `showRoster` is what the tab
 * actually switches: off, this renders nothing but the open window (and keeps
 * saving, syncing and caching in the background).
 */
export default function CharacterSheets({
  actor,
  players,
  offline,
  campaignId,
  onOfflineData,
  showRoster = true,
}) {
  const [sheets, setSheets] = useState([]);
  // Every sheet currently open, back to front — the last is the one on top.
  // An array rather than a set because the order *is* the stacking order, and
  // re-opening one that's already up is how you bring it forward.
  const [openIds, setOpenIds] = useState([]);
  /**
   * How solid each open sheet is, by sheet id.
   *
   * Per sheet rather than one setting for all of them, because that is how the
   * windows already work: each remembers its own box under its own key, and a
   * player who fades the sheet they keep over the map has said nothing about
   * the one they keep beside it. Read from storage on first sight of a sheet
   * and written back on every change, exactly like the box.
   */
  const [opacities, setOpacities] = useState({});
  const [error, setError] = useState('');
  // Which sheets have a write in flight or queued, by id. Per sheet, not a
  // count: with several windows open, only the one being typed into should say
  // it's saving.
  const [savingIds, setSavingIds] = useState(() => new Set());
  // The sheet whose deletion is being confirmed. One at a time, however many
  // windows are open — two of these on screen would be a way to answer the
  // wrong one.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and the socket handler
  // needs to read the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const isDm = actor?.role === 'dm';

  // The open sheets, in stacking order, skipping any id whose sheet has since
  // gone — deleted here, or revoked by the DM and withdrawn over the socket.
  const openSheets = openIds
    .map((id) => sheets.find((s) => s.id === id))
    .filter(Boolean);

  // Null once it's gone — a sheet deleted from under us takes its own dialog
  // down rather than leaving one asking about a character that no longer is.
  const confirmSheet = sheets.find((s) => s.id === confirmDeleteId) || null;

  // Bring it to the front if it's already up, otherwise put it there.
  const openSheet = (id) => setOpenIds((prev) => [...prev.filter((x) => x !== id), id]);

  const opacityKey = (id) => `rpg:sheet-opacity:${id}`;

  // Storage is only consulted for a sheet we haven't been asked about yet; from
  // then on the state holds it. Clamped into range on the way out, so a value
  // saved under a different floor is honoured rather than thrown away.
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
  const closeSheet = (id) => setOpenIds((prev) => prev.filter((x) => x !== id));

  const markSaving = (id, busy) =>
    setSavingIds((prev) => {
      if (busy === prev.has(id)) return prev; // nothing to say
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  // Permission is per sheet, and the DM here may be a player at the next
  // table along. The server has already filtered the list to what we may see,
  // so the only question left is whether this particular sheet is ours to
  // change — and the server checks that again on write regardless of what we
  // render.
  const canEditSheet = (sheet) =>
    Boolean(sheet) && (isDm || sheet.access?.[actor?.userId] === 'edit');
  const readOnlyFor = (sheet) => offline || !canEditSheet(sheet);

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
      // visible to the DM alone.
      const record = await api.createSheet({ ...blankSheet(), name: 'New Character' });
      setSheets((prev) => [...prev, record]);
      openSheet(record.id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeSheet(id) {
    if (!canManage) return;
    const prev = sheets;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    pending.current.delete(id);
    markSaving(id, false);
    setSheets((cur) => cur.filter((s) => s.id !== id));
    closeSheet(id);
    try {
      await api.deleteSheet(id);
    } catch (e) {
      setError(e.message);
      setSheets(prev); // put it back
      throw e; // and let the dialog that asked say so, rather than closing
    }
  }

  // --- the roster, with the open sheet floating above it ---
  //
  // The roster is never replaced, and the window is its sibling rather than its
  // child: the sheet floats over whatever tab you're on, so it can't hang off a
  // list that isn't being rendered.
  return (
    <>
      {showRoster && (
        <div className="sheets-view">
          <div className="sheet-toolbar">
            {/* Each open sheet says whether *it* is saving, in its own header.
                This is for the ones that aren't open. */}
            {[...savingIds].some((id) => !openIds.includes(id)) && (
              <span className="badge saving">saving…</span>
            )}
          </div>

          {/* Kept here rather than repeated in every window: with several up,
              one message would become several copies of itself. This sits at
              the top left, the same column as the create tile, which is the
              part of the page a centred window doesn't cover. */}
          {error && <p className="error">{error}</p>}

          <ul className="sheet-cards">
            {/* First in the grid, not last, and not up in the toolbar: an open
                sheet floats over this page, and anything pushed to the right of
                a toolbar ends up underneath it. The top-left cell is the one
                place a centred window can't cover, so the way to make another
                character is always in reach — however many there already are,
                and whichever one is currently open. */}
            {canManage && (
              <li>
                <button className="sheet-card new" onClick={addSheet}>
                  <strong>+ New character</strong>
                  <span>Starts as yours alone until you hand it out</span>
                </button>
              </li>
            )}
            {sheets.map((s) => (
              <li key={s.id}>
                {/* Clicking one already open brings its window to the front
                    rather than doing nothing — the card is how you find a sheet
                    you've lost behind another. */}
                <button
                  className={`sheet-card${openIds.includes(s.id) ? ' open' : ''}`}
                  onClick={() => openSheet(s.id)}
                >
                  <strong>{s.name || 'Unnamed'}</strong>
                  <span>
                    {[s.race, s.class && `${s.class} ${s.level ?? 1}`]
                      .filter(Boolean)
                      .join(' · ') || 'No class yet'}
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
            {/* Only where there's no create tile to say it better. Telling a GM
                with an empty roster "no characters yet" next to the button that
                makes one is just describing what they can already see. */}
            {sheets.length === 0 && !canManage && (
              <li className="empty">
                {offline
                  ? 'No cached characters yet.'
                  : "No characters yet — your GM hasn't given you one."}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* One window per open sheet, painted in the order they were last
          reached for. Each remembers its own box under its own key, so a
          character you always keep in the corner opens back in that corner
          instead of on top of whatever else you have up. */}
      {openSheets.map((sheet, i) => {
        const readOnly = readOnlyFor(sheet);
        return (
          <FloatingWindow
            key={sheet.id}
            title={sheet.name || 'Unnamed'}
            storageKey={`rpg:sheet-window:${sheet.id}`}
            zIndex={Math.min(WIN_Z_BASE + i, WIN_Z_CEILING)}
            cascade={i}
            isTop={i === openSheets.length - 1}
            onFocus={() => openSheet(sheet.id)}
            onClose={() => closeSheet(sheet.id)}
            opacity={opacityOf(sheet.id) / 100}
            onOpacityChange={(next) => setOpacityOf(sheet.id, next)}
            controls={
              <>
                {savingIds.has(sheet.id) && <span className="badge saving">saving…</span>}
                {readOnly && <span className="badge role anon">read-only</span>}
                <div className="spacer" />
                {canManage && (
                  <button className="del" onClick={() => setConfirmDeleteId(sheet.id)}>
                    Delete character
                  </button>
                )}
              </>
            }
          >
            <CharacterSheet sheet={sheet} onChange={queueSave} readOnly={readOnly} />
          </FloatingWindow>
        );
      })}

      {/* Named with the same fallback the window title uses, so what you're
          asked to type is what you can see above the sheet. */}
      {confirmSheet && (
        <ConfirmDeleteModal
          name={confirmSheet.name || 'Unnamed'}
          byName
          description="This removes the sheet for everyone at the table, including the player it belongs to. It can't be undone."
          onConfirm={() => removeSheet(confirmSheet.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}
    </>
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

