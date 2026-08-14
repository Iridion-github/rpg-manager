import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clientId } from './api.js';
import { socket } from './socket.js';
import { cacheGetAll, cachePutAll, getLastSynced } from './cache.js';
import CharacterSheet from './sheet/CharacterSheet.jsx';
import SheetTokenLink from './SheetTokenLink.jsx';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import { abilityMod, armorClass, blankSheet, signed } from './sheet/rules.js';

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
 * Mounted for as long as the campaign is, not for as long as its tab is shown -
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
  // Every sheet currently open, back to front - the last is the one on top.
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
  // windows are open - two of these on screen would be a way to answer the
  // wrong one.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  /**
   * This campaign's tokens, so a character can be pointed at one.
   *
   * The server sends only the tokens this person may move, which is exactly the
   * set they may link - so the list needs no filtering here, and a player is
   * never shown somebody else's figure as an option they'd be refused.
   */
  const [tokens, setTokens] = useState([]);
  // The token whose link is being changed, so its dropdown can go quiet while
  // the call is in flight rather than the whole page doing so.
  const [linkingId, setLinkingId] = useState('');

  // Edits waiting to be written, keyed by sheet id, plus their debounce timers.
  // Refs, not state: changing them must not re-render, and the socket handler
  // needs to read the *current* value, not the one captured at render time.
  const pending = useRef(new Map());
  const timers = useRef(new Map());

  const isDm = actor?.role === 'dm';

  /**
   * Who a character can be handed to.
   *
   * Players only. A DM is never in a sheet's access map - they can already
   * reach everything at their own table, so an entry for one would be a control
   * that changes nothing, sitting in a list of controls that do.
   */
  const assignable = players.filter((p) => p.role === 'player');

  /**
   * Access entries pointing at somebody who is no longer at this table.
   *
   * The map is not cleaned up when a member is removed, and deliberately so: an
   * id that can't resolve to a role grants nothing, so a leftover entry is dead
   * weight rather than a way in (see sanitizeSheetAccess on the server).
   *
   * It is still worth showing. Without this the roster card reads "former
   * player can edit" while the panel below lists only current players, all of
   * them set to no access - so the one line the DM wants to act on is the one
   * line they cannot reach, and every change they *do* make silently carries
   * the stale entry along with it.
   */
  const strandedIn = (sheet) =>
    Object.keys(sheet?.access || {}).filter((id) => !players.some((p) => p.id === id));

  // The open sheets, in stacking order, skipping any id whose sheet has since
  // gone - deleted here, or revoked by the DM and withdrawn over the socket.
  const openSheets = openIds
    .map((id) => sheets.find((s) => s.id === id))
    .filter(Boolean);

  // Null once it's gone - a sheet deleted from under us takes its own dialog
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
  // change - and the server checks that again on write regardless of what we
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
    // Don't overwrite a sheet the user is mid-edit on - our queued write wins.
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

  /**
   * The token list, kept fresh alongside the sheets.
   *
   * Listening to `scenes:changed` as well as loading once: a token created,
   * deleted, placed or linked from anywhere else changes what this picker
   * should offer and what it should say is already taken. Failures are
   * swallowed - being unable to read the tokens costs the link control, not the
   * character sheet somebody is trying to read.
   */
  const loadTokens = useCallback(async () => {
    try {
      setTokens(await api.listCampaignTokens());
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    if (offline) return undefined;
    loadTokens();
    socket.on('scenes:changed', loadTokens);
    socket.on('connect', loadTokens);
    return () => {
      socket.off('scenes:changed', loadTokens);
      socket.off('connect', loadTokens);
    };
  }, [loadTokens, offline]);

  /**
   * Put this character on a figure, or take it off one.
   *
   * Always names the token, because the link is a field on the token. Moving a
   * character from one figure to another is a single call: the route releases
   * whatever else held the sheet as part of taking it, so there is no moment in
   * between where two tokens claim the same character.
   *
   * Not optimistic. The call can move hit points at both ends and can release a
   * second token, and guessing at the result would mean drawing a board that is
   * briefly wrong in two places rather than one - so both lists are re-read from
   * the answer instead. It is one small request against a list of a few dozen.
   */
  async function setLink(sheet, tokenId, attach) {
    if (!tokenId) return;
    setLinkingId(sheet.id);
    setError('');
    try {
      await api.linkTokenSheet(tokenId, attach ? sheet.id : null);
      await loadTokens();
      // The sheet's own hit points may have moved to match the token's, so it
      // is worth re-reading rather than assuming this changed nothing here.
      await refresh();
    } catch (e) {
      setError(e.message);
      await loadTokens();
    } finally {
      setLinkingId('');
    }
  }

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

  /**
   * Two different permissions, deliberately not one.
   *
   * Anybody at the table may make a character - it is the one thing here that
   * belongs to the person playing it, and a blank sheet you have to ask for is
   * a queue for a piece of paper. Deleting one, and deciding who else may see
   * it, stay the DM's: those are the acts that can take something away from
   * somebody else.
   */
  const canCreate = !offline;
  const canManage = isDm && !offline;

  /**
   * Hand a character to somebody, or take it back.
   *
   * Through its own route, never as part of an edit: a player saving their own
   * sheet sends the whole sheet, and if access rode along in that body they
   * could promote themselves while filling in their hit points. The server
   * takes access from the stored record on every edit for exactly that reason,
   * so this is the only door - and it is the DM's alone.
   *
   * `level` is 'view', 'edit', or '' to remove them. The whole map is sent
   * rather than a change to it, because that is the shape the route accepts:
   * absence from the map *is* having no access, so there is nothing else a
   * removal could look like.
   */
  async function setAccess(sheet, userId, level) {
    if (!canManage) return;
    const { [userId]: had, ...rest } = sheet.access || {};
    const access = level ? { ...rest, [userId]: level } : rest;
    // Optimistic: the dropdown should answer the hand that moved it rather than
    // waiting on a round trip. Put back on failure, since a control that
    // silently keeps a value the server rejected is worse than a slow one.
    setSheets((prev) => prev.map((s) => (s.id === sheet.id ? { ...s, access } : s)));
    setError('');
    try {
      await api.setSheetAccess(sheet.id, access);
    } catch (e) {
      setError(e.message);
      setSheets((prev) =>
        prev.map((s) => (s.id === sheet.id ? { ...s, access: sheet.access || {} } : s))
      );
    }
  }

  async function addSheet() {
    if (!canCreate) return;
    try {
      // Not optimistic: only the server can mint the record's id. It also
      // decides who the sheet answers to - DM-only for a DM's, and the maker's
      // own for a player's - so the record that comes back is the one to keep,
      // rather than a guess to be corrected.
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
                character is always in reach - however many there already are,
                and whichever one is currently open. */}
            {canCreate && (
              <li>
                <button className="sheet-card new" onClick={addSheet}>
                  <strong>+ New character</strong>
                  {/* The two answers to "and then who has it?" - worth saying
                      on the button, since it is the one thing about making a
                      character that isn't obvious from making one. */}
                  <span>
                    {isDm
                      ? 'Starts as yours alone until you hand it out'
                      : 'Yours, from the moment you make it'}
                  </span>
                </button>
              </li>
            )}
            {sheets.map((s) => (
              <li key={s.id}>
                {/* Clicking one already open brings its window to the front
                    rather than doing nothing - the card is how you find a sheet
                    you've lost behind another. */}
                <button
                  className={`sheet-card${openIds.includes(s.id) ? ' open' : ''}${s.portraitUrl ? ' has-portrait' : ''
                    }`}
                  onClick={() => openSheet(s.id)}
                >
                  {/* Only where there is one, and the card is laid out in two
                      columns only where there is one: an empty frame on every
                      character nobody has drawn yet would cost the whole roster
                      a column to say nothing. */}
                  {s.portraitUrl && (
                    <img className="card-portrait" src={s.portraitUrl} alt="" />
                  )}
                  {/* Everything the card says, in one box beside the picture.
                      A wrapper rather than letting these sit in the card's own
                      grid: the portrait has to stand alongside all of them at
                      once, and a cell can only span rows the grid actually
                      declares - which these, arriving one per character, are
                      not. */}
                  <span className="card-body">
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
                      <span>AC {armorClass(s)}</span>
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
                  </span>
                </button>
              </li>
            ))}
            {/* Only where there's no create tile to say it better. Telling a GM
                with an empty roster "no characters yet" next to the button that
                makes one is just describing what they can already see. */}
            {sheets.length === 0 && !canCreate && (
              <li className="empty">
                {offline
                  ? 'No cached characters yet.'
                  : "No characters yet - your GM hasn't given you one."}
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
            {/* Above the sheet and only for the DM. Folded away by default: it
                is consulted when a character changes hands, which is once,
                against a sheet that is read every session. */}
            {canManage && (
              <details className="access-panel">
                <summary>
                  Who has this character - <strong>{accessSummary(sheet, players)}</strong>
                </summary>
                {assignable.length === 0 && strandedIn(sheet).length === 0 ? (
                  <p className="hint">
                    Nobody else is at this table yet. Add players under Campaigns → Members and
                    they'll appear here.
                  </p>
                ) : (
                  <>
                    <p className="hint">
                      A player sees only the characters given to them, and this is what gives them
                      one. Take it back and it disappears from their screen at once, even if they
                      have it open.
                    </p>
                    <ul className="access-list">
                      {assignable.map((p) => (
                        <li key={p.id}>
                          <strong>{p.name}</strong>
                          <select
                            value={sheet.access?.[p.id] || ''}
                            aria-label={`What ${p.name} may do with ${sheet.name || 'this character'}`}
                            onChange={(e) => setAccess(sheet, p.id, e.target.value)}
                          >
                            <option value="">No access</option>
                            <option value="view">Can view</option>
                            <option value="edit">Can edit</option>
                          </select>
                        </li>
                      ))}
                      {/* Somebody who has since left the table. It grants them
                          nothing - a user with no role here can't resolve one -
                          but it is what the card is reporting, so it needs a
                          way out rather than an explanation. No dropdown: the
                          only useful thing to do with a ghost is forget it. */}
                      {strandedIn(sheet).map((id) => (
                        <li key={id}>
                          <strong>Former player</strong>
                          <button type="button" onClick={() => setAccess(sheet, id, '')}>
                            Remove ({sheet.access[id]})
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            )}

            {/* Which figure on the map is this character. One, and one only:
                choosing another takes the character off the first.

                Not the DM's alone, unlike the access panel above it: a player
                coupling their own character to their own token is arranging
                their own things, and the server checks both halves regardless
                of what this offers. */}
            {!readOnly && (
              <SheetTokenLink
                label="Linked Token"
                value={figureOf(tokens, sheet)?.id || ''}
                emptyLabel="Not on the map"
                busy={linkingId === sheet.id}
                options={tokens.map((t) => ({
                  id: t.id,
                  name: t.label,
                  // Named so the choice is informed: picking this one takes it
                  // off the character it currently is.
                  note:
                    t.sheetId && t.sheetId !== sheet.id
                      ? `currently ${sheets.find((s) => s.id === t.sheetId)?.name || 'another character'
                      }`
                      : '',
                }))}
                hint=""
                onChange={(tokenId) =>
                  tokenId
                    ? setLink(sheet, tokenId, true)
                    : setLink(sheet, figureOf(tokens, sheet)?.id, false)
                }
              />
            )}

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

/**
 * The figure on the board that is this character, if there is one.
 *
 * `find`, and at most one to find: linking a character to a figure releases
 * whatever else was holding it, so a second is a state the server does not
 * leave behind.
 */
const figureOf = (tokens, sheet) => tokens.find((t) => t.sheetId === sheet.id) || null;

// "GM only" / "Kira can edit · Tom can view" - the GM's answer to "who's got
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

