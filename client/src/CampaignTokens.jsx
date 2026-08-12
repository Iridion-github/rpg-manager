import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import TokenModal from './TokenModal.jsx';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * This campaign's own tokens — its cast, made in advance of needing them.
 *
 * Distinct from the library above it, which is *artwork*: pictures anyone can
 * put on anything. These are the actual pieces this table plays with, each one
 * belonging to somebody, each one either standing on a map or waiting to be
 * placed on one.
 *
 * Two rules shape what this screen offers, and both come from the same idea —
 * a player has a character, a DM runs a cast:
 *
 *   - the DM sees every token here and may make as many as they like;
 *   - everybody else sees the tokens that belong to them, and may make one.
 *
 * The second is counted on who *created* a token, not who owns one, so a DM
 * handing somebody a second character doesn't cost that person the right to
 * have made their own.
 *
 * What isn't here: hit points and initiative. Those are decided in the moment
 * on the tabletop, by whoever is looking at the fight, and a token carries them
 * across untouched by anything on this screen.
 */
export default function CampaignTokens({ actor, players, isDm, offline }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // The token being made or edited: { token } for an edit, {} for a new one.
  const [form, setForm] = useState(null);
  const [confirmId, setConfirmId] = useState('');

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

  useEffect(() => {
    load();
  }, [load]);

  // A token placed, taken off a map, or edited from the tabletop is a token
  // whose row here is out of date. The nudge carries nothing; asking again is
  // cheap and always right.
  useEffect(() => {
    socket.on('scenes:changed', load);
    return () => socket.off('scenes:changed', load);
  }, [load]);

  // A player gets one token of their own making. The DM's list is unbounded.
  const madeOne = rows.some((t) => t.createdBy === actor?.userId);
  const canCreate = !offline && (isDm || !madeOne);

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

      <p className="hint">
        {isDm
          ? "Every token at this table, yours and your players'. Make them before the session and place them when you need them — right-click the map and choose Place Token."
          : 'Your token, made once and kept. Place it from the map with a right-click, take it off again when you are done, and it will be here next time.'}
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {canCreate
            ? 'Nothing yet — make one and it will wait here until you place it.'
            : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="cast-list">
          {rows.map((t) => (
            <li key={t.id}>
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
                <small>
                  {/* Whose it is, and where it is. Both are facts this screen
                      exists to answer, and neither is visible on the map from
                      the Tokens tab. */}
                  {t.ownerId ? (
                    <>
                      <span
                        className="cast-owner-dot"
                        style={{ background: ownerColour(t.ownerId) }}
                      />
                      {ownerName(t.ownerId) || 'someone who has left'}
                    </>
                  ) : (
                    'unassigned'
                  )}
                  {' · '}
                  {t.sceneId ? `on ${t.sceneName}` : 'not placed'}
                </small>
              </span>

              {!offline && (
                <>
                  <button onClick={() => setForm({ token: t })}>Edit</button>
                  <button className="del" onClick={() => setConfirmId(t.id)} title={`Delete ${t.label}`}>
                    ✕
                  </button>
                </>
              )}
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
              : 'This deletes the token for good. To keep it for later, leave it here — it costs nothing to keep.'
          }
          confirmLabel="Delete token"
          onConfirm={() => remove(doomed.id)}
          onClose={() => setConfirmId('')}
        />
      )}
    </section>
  );
}
