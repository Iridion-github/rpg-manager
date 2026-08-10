import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * The people this server knows about — admin only.
 *
 * Creating someone mints their credential, and that's the one thing reserved to
 * the admin: an endpoint anyone could call would be open registration on a
 * public URL. What each person can *do* isn't decided here at all — that's
 * campaign membership, where admin carries no weight.
 */
export default function Roster({ onUsersChanged }) {
  const [rows, setRows] = useState([]); // users *including* keys — admin only
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  // The person a confirmation dialog is currently asking about.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.listUserKeys());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function guard(fn) {
    setBusy(true);
    try {
      await fn();
      setError('');
      onUsersChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // From the live list, so a dialog can't outlive the person it asks about.
  const confirmPerson = rows.find((u) => u.id === confirmDeleteId) || null;

  const inviteLink = (key) =>
    `${window.location.origin}${window.location.pathname}?key=${encodeURIComponent(key)}`;

  async function copyInvite(user) {
    const link = inviteLink(user.key);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(user.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      // Clipboard blocked (non-https origin, denied permission) — show the link
      // so it can still be copied by hand rather than failing silently.
      window.prompt(`Invite link for ${user.name}:`, link);
    }
  }

  const add = (e) => {
    e.preventDefault();
    return guard(async () => {
      const created = await api.createUser({ name: name || 'Player' });
      setRows((prev) => [...prev, created]);
      setName('');
    });
  };

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

  const rotate = (id) =>
    guard(async () => {
      const updated = await api.rotateUserKey(id);
      setRows((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    });

  return (
    <div className="roster">
      <p className="hint">
        Add someone here and send them their invite link — that link <em>is</em>
        their identity, so rotate the key if one leaks. Being on this list gets
        them onto the server, not into any campaign: that's each DM's call.
      </p>

      {error && <p className="error">{error}</p>}

      <form className="new-player" onSubmit={add}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy}>
          + Add person
        </button>
      </form>

      <ul className="player-list">
        {rows.map((u) => (
          <li key={u.id}>
            <span className="swatch" style={{ background: u.color }} />
            <strong>{u.name}</strong>
            {u.globalRole === 'admin' && <span className="badge role gm">admin</span>}
            <button onClick={() => copyInvite(u)} disabled={busy}>
              {copied === u.id ? 'Copied!' : 'Copy invite link'}
            </button>
            <button onClick={() => rotate(u.id)} disabled={busy} title="Invalidate the old link">
              Rotate key
            </button>
            {/* The admin account has no delete: removing it would leave a server
                whose password authenticates as nobody. */}
            {u.globalRole !== 'admin' && (
              <button
                className="del"
                onClick={() => setConfirmDeleteId(u.id)}
                disabled={busy}
                title={`Remove ${u.name}`}
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="empty">Nobody yet.</li>}
      </ul>

      {/* By name: this is a person, not a thing they own. Their invite link
          stops working and their place at every table goes with them, and with
          a column of identical ✕ buttons the mistake to guard against is
          removing the wrong one. */}
      {confirmPerson && (
        <ConfirmDeleteModal
          name={confirmPerson.name}
          byName
          description="This removes them from the server entirely: their invite link stops working and they leave every campaign they were part of. It can't be undone."
          confirmLabel="Remove person"
          onConfirm={() => remove(confirmPerson.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}
    </div>
  );
}
