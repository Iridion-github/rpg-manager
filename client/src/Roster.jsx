import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// GM-only roster. Creating a player mints a key; the key becomes an invite link
// you send to that friend. Their browser claims it and remembers who they are.
export default function Roster({ onPlayersChanged }) {
  const [rows, setRows] = useState([]); // players *including* keys — GM only
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.listPlayerKeys());
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
      onPlayersChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const inviteLink = (key) =>
    `${window.location.origin}${window.location.pathname}?key=${encodeURIComponent(key)}`;

  async function copyInvite(player) {
    const link = inviteLink(player.key);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(player.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      // Clipboard blocked (non-https origin, denied permission) — show the link
      // so it can still be copied by hand rather than failing silently.
      window.prompt(`Invite link for ${player.name}:`, link);
    }
  }

  const add = (e) => {
    e.preventDefault();
    return guard(async () => {
      const created = await api.createPlayer({ name: name || 'Player' });
      setRows((prev) => [...prev, created]);
      setName('');
    });
  };

  const remove = (id) =>
    guard(async () => {
      await api.deletePlayer(id);
      setRows((prev) => prev.filter((p) => p.id !== id));
    });

  const rotate = (id) =>
    guard(async () => {
      const updated = await api.rotatePlayerKey(id);
      setRows((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    });

  return (
    <div className="roster">
      <p className="hint">
        Add a friend, then send them their invite link. Anyone holding a link can
        move that player's tokens — rotate the key if one leaks.
      </p>

      {error && <p className="error">{error}</p>}

      <form className="new-player" onSubmit={add}>
        <input
          placeholder="Player name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          + Add player
        </button>
      </form>

      <ul className="player-list">
        {rows.map((p) => (
          <li key={p.id}>
            <span className="swatch" style={{ background: p.color }} />
            <strong>{p.name}</strong>
            <button onClick={() => copyInvite(p)} disabled={busy}>
              {copied === p.id ? 'Copied!' : 'Copy invite link'}
            </button>
            <button onClick={() => rotate(p.id)} disabled={busy} title="Invalidate the old link">
              Rotate key
            </button>
            <button className="del" onClick={() => remove(p.id)} disabled={busy}>
              ✕
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="empty">No players yet.</li>}
      </ul>
    </div>
  );
}
