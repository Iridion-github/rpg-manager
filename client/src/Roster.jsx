import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * The people this server knows about.
 *
 * A list rather than a place to make accounts, and no longer a place to hand
 * out credentials either. Registration is how somebody arrives, a password is
 * how they get back in, and both belong to them rather than to the admin.
 *
 * Everyone signed in may read it: it carries names and colours and nothing else
 * — the server strips the rest before it leaves (publicUser) — and knowing who
 * else is at the server is what lets a player recognise the person a DM just
 * added to their table. Only the admin sees a way to remove anybody, and the
 * server refuses it from anyone else regardless of what this draws.
 */
export default function Roster({ isAdmin, onUsersChanged }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  // The person a confirmation dialog is currently asking about.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.listUsers());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // From the live list, so a dialog can't outlive the person it asks about.
  const confirmPerson = rows.find((u) => u.id === confirmDeleteId) || null;

  // Thrown as well as shown: the dialog asking about it stays open and says so
  // rather than closing as though the person had been removed.
  async function remove(id) {
    setError('');
    try {
      await api.deleteUser(id);
      setRows((prev) => prev.filter((u) => u.id !== id));
      onUsersChanged?.();
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  return (
    <div className="roster">
      <p className="hint">
        Everyone who has registered on this server. People arrive by registering
        — with the signup code, if you've set one — and sign in with their own
        password. Being on this list gets them onto the server, not into any
        campaign: that's each DM's call.
        {!isAdmin && ' This is a list to read; only the server admin can change it.'}
      </p>

      {error && <p className="error">{error}</p>}

      <ul className="player-list">
        {rows.map((u) => (
          <li key={u.id}>
            <span className="swatch" style={{ background: u.color }} />
            <strong>{u.name}</strong>
            {u.globalRole === 'admin' && <span className="badge role gm">admin</span>}
            {/* Nothing to press unless you're the admin — and the admin account
                has no delete even then, since removing it would leave a server
                whose password authenticates as nobody. The server refuses this
                from anyone else regardless; hiding it only means not offering a
                button whose whole answer would be "no". */}
            {isAdmin && u.globalRole !== 'admin' && (
              <button
                className="del"
                onClick={() => setConfirmDeleteId(u.id)}
                title={`Remove ${u.name}`}
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="empty">Nobody yet.</li>}
      </ul>

      {/* By name: this is a person, not a thing they own. Their account goes and
          their place at every table goes with it, and with a column of identical
          ✕ buttons the mistake to guard against is removing the wrong one. */}
      {isAdmin && confirmPerson && (
        <ConfirmDeleteModal
          name={confirmPerson.name}
          byName
          description="This removes them from the server entirely: they can no longer sign in, and they leave every campaign they were part of. It can't be undone."
          confirmLabel="Remove person"
          onConfirm={() => remove(confirmPerson.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}
    </div>
  );
}
