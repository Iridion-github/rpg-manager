import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import TokenModal from './TokenModal.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import SheetTokenLink from './SheetTokenLink.jsx';

/**
 * This campaign's own tokens - its cast, made in advance of needing them.
 *
 * Distinct from the library above it, which is *artwork*: pictures anyone can
 * put on anything. These are the actual pieces this table plays with, each one
 * belonging to somebody, each one either standing on a map or waiting to be
 * placed on one.
 *
 * One rule shapes what this screen offers: the DM sees every token here, and
 * everybody else sees the tokens that belong to them. Anybody may make as many
 * as they like, and the DM may hand out as many as they like - a token belongs
 * to one person at a time, which is the only count still kept.
 *
 * What isn't in the *edit form*: hit points and initiative. Those are decided
 * in the moment on the tabletop, by whoever is looking at the fight, and a
 * token carries them across untouched by anything that form can reach.
 *
 * The exception is the character picker on each row, which is the one control
 * here that does touch them - coupling a token to a sheet copies the
 * character's hit points and initiative modifier across, and keeps the hit
 * points in step from then on. That is the point of coupling, and it is why it
 * is a control of its own rather than a field in the form.
 */
export default function CampaignTokens({ actor, players, isDm, offline }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // The token being made or edited: { token } for an edit, {} for a new one.
  const [form, setForm] = useState(null);
  const [confirmId, setConfirmId] = useState('');
  /**
   * The characters this person could couple a token to.
   *
   * The server sends only the sheets they may *see*, which is a wider set than
   * the ones they may link - linking needs edit access, since it writes hit
   * points in both directions afterwards. So this is filtered again below, and
   * the server checks it a third time on the way in.
   */
  const [sheets, setSheets] = useState([]);
  const [linkingId, setLinkingId] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.listCampaignTokens());
      setError('');
    } catch (e) {
      if (!offline) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [offline]);

  const loadSheets = useCallback(async () => {
    try {
      setSheets(await api.listSheets());
    } catch {
      // Being unable to read the characters costs the link picker, not the
      // list of tokens this screen is actually for.
      setSheets([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (offline) return undefined;
    loadSheets();
    socket.on('sheets:changed', loadSheets);
    return () => socket.off('sheets:changed', loadSheets);
  }, [loadSheets, offline]);

  // A token placed, taken off a map, or edited from the tabletop is a token
  // whose row here is out of date. The nudge carries nothing; asking again is
  // cheap and always right.
  useEffect(() => {
    socket.on('scenes:changed', load);
    return () => socket.off('scenes:changed', load);
  }, [load]);

  // Nobody is counted. The only thing that stops you making a token here is
  // having no server to make it on.
  const canCreate = !offline;

  const ownerName = (id) => players.find((p) => p.id === id)?.name || null;
  const ownerColour = (id) => players.find((p) => p.id === id)?.color || '#4a5163';

  async function save(fields) {
    const updated = form?.token
      ? await api.updateCampaignToken(form.token.id, fields)
      : await api.createCampaignToken(fields);
    setRows((prev) =>
      form?.token ? prev.map((t) => (t.id === updated.id ? updated : t)) : [...prev, updated]
    );
    setForm(null);
  }

  // Thrown as well as shown, so the dialog stays open and says what happened
  // rather than closing as though the token had gone.
  async function remove(id) {
    setError('');
    try {
      await api.deleteCampaignToken(id);
      setRows((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  const doomed = rows.find((t) => t.id === confirmId) || null;

  /**
   * Characters this person may actually couple something to.
   *
   * Edit access, not merely sight. A character somebody has been allowed to
   * read is not one they may weld their figure to - the link carries hit points
   * back and forth once it exists, so the right question is "may you change
   * this?" rather than "may you see it?".
   */
  const linkable = sheets.filter((s) => isDm || s.access?.[actor?.userId] === 'edit');

  async function linkToken(token, sheetId) {
    setLinkingId(token.id);
    setError('');
    try {
      // The route releases whatever else held that character, so moving one
      // from figure to figure is a single call with no moment in between where
      // two tokens claim it.
      await api.linkTokenSheet(token.id, sheetId);
      await load();
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setLinkingId('');
    }
  }

  return (
    <section className="campaign-tokens">
      <div className="sheet-toolbar">
        <h2 className="notes-title">This campaign's tokens</h2>
        {canCreate && (
          <button onClick={() => setForm({})}>
            {isDm ? '+ Create token' : '+ Create your own token'}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {/* Above the rows rather than in them, because it is about the two columns
          rather than about any one token - and because the two were being read
          as one thing. Naming them apart is most of the fix; the captions below
          are the rest. */}
      <p className="hint">
        If linked to a <strong>Character</strong>, they share hit points.{" "}<strong>Assigned Player</strong> is who can move and update the token.
      </p>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {canCreate
            ? 'Nothing yet - make one and it will wait here until you place it.'
            : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="cast-list">
          {/* Captions over the columns, sharing the rows' own grid template so
              the two line up. A list item rather than a heading row of its own,
              so it cannot drift out of the list it describes. */}
          <li className="cast-head" aria-hidden="true">
            <span>Token</span>
            <span>{offline ? '' : 'Linked to which Char Sheet'}</span>
            <span>Assigned Player</span>
            <span />
          </li>
          {rows.map((t) => (
            <li key={t.id}>
              <span className="cast-token">
                <span
                  className="cast-face"
                  style={{
                    background: t.imageUrl
                      ? `center / cover no-repeat url(${JSON.stringify(t.imageUrl)})`
                      : t.color,
                    ...(t.borderColor ? { borderColor: t.borderColor } : {}),
                  }}
                />
                <span className="cast-who">
                  <strong>{t.label}</strong>
                  {/* Where it is. Not visible on the map from this tab, and the
                      one fact about a figure that this screen alone answers. */}
                  <small>{t.sceneId ? `on ${t.sceneName}` : 'not placed'}</small>
                </span>
              </span>

              {/* The same coupling the Characters tab offers, asked from this
                  end: which character is this figure. Drawn in the row rather
                  than inside the Edit form, because it is not part of what a
                  token *looks like* - and because acting on change keeps it the
                  same gesture it is over there. */}
              <span className="cast-cell">
                {!offline && (
                  <SheetTokenLink
                    // No caption of its own: the column has one, and repeating
                    // it on every row would be the same words a dozen times
                    // down a screen that is already dense.
                    label=""
                    ariaLabel="Linked to which character sheet"
                    value={t.sheetId || ''}
                    busy={linkingId === t.id}
                    options={linkable.map((s) => {
                      // Said before the choice rather than after it: a character
                      // is on one figure, so picking one that is already
                      // somewhere takes it off there.
                      const holder = rows.find(
                        (other) => other.sheetId === s.id && other.id !== t.id
                      );
                      return {
                        id: s.id,
                        name: s.name || 'Unnamed',
                        note: holder ? `currently ${holder.label}` : '',
                      };
                    })}
                    onChange={(sheetId) => linkToken(t, sheetId)}
                  />
                )}
              </span>

              {/* Read here, changed under Edit. It is the one field on a token
                  that hands something to somebody, so it stays in the form with
                  the confirmation around it rather than becoming a dropdown you
                  can brush past on your way down the list. */}
              <span className="cast-cell cast-owner">
                {t.ownerId ? (
                  <>
                    <span
                      className="cast-owner-dot"
                      style={{ background: ownerColour(t.ownerId) }}
                    />
                    {ownerName(t.ownerId) || 'someone who has left'}
                  </>
                ) : (
                  <em title="Only the DM can move this one">Nobody</em>
                )}
              </span>

              <span className="cast-actions">
                {!offline && (
                  <>
                    <button onClick={() => setForm({ token: t })}>Edit</button>
                    <button
                      className="del"
                      onClick={() => setConfirmId(t.id)}
                      title={`Delete ${t.label}`}
                    >
                      ✕
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <TokenModal
          token={form.token}
          players={players}
          // No hit points, no initiative: this is what a token *is*, not what
          // it is doing in a fight.
          stats={false}
          canAssign={isDm}
          canHide={isDm}
          title={form.token ? 'Edit token' : 'Create token'}
          onSubmit={save}
          onClose={() => setForm(null)}
        />
      )}

      {doomed && (
        <ConfirmDeleteModal
          name={doomed.label}
          description={
            doomed.sceneId
              ? `This deletes the token for good, and takes it off ${doomed.sceneName}. To keep it for later, take it off the table from the map instead.`
              : 'This deletes the token for good. To keep it for later, leave it here - it costs nothing to keep.'
          }
          confirmLabel="Delete token"
          onConfirm={() => remove(doomed.id)}
          onClose={() => setConfirmId('')}
        />
      )}
    </section>
  );
}
