import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import Avatar from './Avatar.jsx';
import { formatDateTime } from './dateFormat.js';

/**
 * Who is at this table - everyone's view, not just the DM's.
 *
 * Membership has never been a secret from the people inside a campaign (the
 * members endpoint has always been readable by any of them), so this shows the
 * same list to a player as to the DM. What differs is what you can *do* with a
 * row: the DM gets a right-click menu, and only on other people.
 *
 * Presence is live and unstored. The server reads it from the open sockets and
 * nudges everyone whenever it moves, which is what this listens for.
 */

// How the three states read on screen, in the order they'd worry you.
const STATUS_LABEL = { present: 'Present', online: 'Online', offline: 'Offline' };
const STATUS_HINT = {
  present: 'At this table right now',
  online: 'Signed in, looking at something else',
  offline: 'Not connected',
};

function lastLogin(iso) {
  return formatDateTime(iso) || 'Never';
}

export default function Players({ campaignId, actor, isDm, offline }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The row a right-click menu is open on: { userId, clientX, clientY }.
  const [menu, setMenu] = useState(null);
  // The person whose role is being changed, and the role chosen so far.
  const [roleFor, setRoleFor] = useState(null);
  const [removeId, setRemoveId] = useState('');
  const menuRef = useRef(null);

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      setRows(await api.listMembers(campaignId));
      setError('');
    } catch (e) {
      // Offline, this list is simply unavailable - it is nothing but live
      // facts about a server we can't reach, so there is nothing to cache.
      if (!offline) setError(e.message);
    }
  }, [campaignId, offline]);

  useEffect(() => {
    load();
  }, [load]);

  // Presence moves on every connect, disconnect and table change; membership
  // moves when a DM edits it. Both arrive as a nudge with nothing in them, and
  // both mean the same thing here: ask again.
  useEffect(() => {
    const again = () => load();
    socket.on('presence:changed', again);
    socket.on('campaigns:changed', again);
    return () => {
      socket.off('presence:changed', again);
      socket.off('campaigns:changed', again);
    };
  }, [load]);

  // An open menu is dismissed by anything that isn't using it - the same rule
  // the map's right-click menu follows.
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (e?.target && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);

  /**
   * Rewrite the whole membership map with one entry changed.
   *
   * That's the shape the endpoint takes, and sending it whole is what lets a
   * removal be expressed at all: it is the absence of a key, not a value.
   * Built from the list on screen, which the nudges above keep current.
   */
  async function writeMembers(userId, role) {
    setBusy(true);
    setError('');
    try {
      const next = {};
      for (const m of rows) next[m.id] = m.role;
      if (role === 'none') delete next[userId];
      else next[userId] = role;
      await api.setMembers(campaignId, next);
      await load();
    } catch (e) {
      setError(e.message);
      throw e; // so the dialog that asked stays open and says so
    } finally {
      setBusy(false);
    }
  }

  const menuRow = menu ? rows.find((r) => r.id === menu.userId) : null;
  const removeRow = rows.find((r) => r.id === removeId) || null;

  return (
    <div className="players-view">
      <p className="hint">
        The campaign's players. {isDm && 'Right-click someone to change their role or kick them out of the campaign.'}
      </p>

      {error && <p className="error">{error}</p>}

      <ul className="player-rows">
        {rows.map((u) => {
          const isMe = u.id === actor?.userId;
          return (
            <li
              key={u.id}
              className={isMe ? 'me' : ''}
              // Never on yourself, and never for a player: there is nothing on
              // the menu either of them may do, and a menu of nothing is worse
              // than no menu at all.
              onContextMenu={(e) => {
                if (!isDm || isMe || offline) return;
                e.preventDefault();
                setMenu({ userId: u.id, clientX: e.clientX, clientY: e.clientY });
              }}
            >
              {/* Their face where the plain colour swatch used to be. It keeps
                  what the swatch said - their token colour rings the picture,
                  and fills in behind their initial when there is none - and
                  says who they are as well. */}
              <Avatar url={u.avatarUrl} name={u.name} color={u.color} />
              <strong className="player-name">
                {u.name}
                {isMe && <span className="you"> (you)</span>}
              </strong>

              <span className={`status ${u.status}`} title={STATUS_HINT[u.status]}>
                <i className="status-dot" />
                {STATUS_LABEL[u.status] || 'Offline'}
              </span>

              <span className="player-seen" title="Last signed in">
                {lastLogin(u.lastLoginAt)}
              </span>

              <span className={`badge role${u.role === 'dm' ? ' gm' : ''}`}>
                {u.role === 'dm' ? 'DM' : 'Player'}
              </span>
            </li>
          );
        })}
        {rows.length === 0 && <li className="empty">Nobody at this table yet.</li>}
      </ul>

      {menu && menuRow && (
        <div className="map-menu" ref={menuRef} style={{ left: menu.clientX, top: menu.clientY }}>
          <button
            onClick={() => {
              setRoleFor({ id: menuRow.id, name: menuRow.name, role: menuRow.role });
              setMenu(null);
            }}
          >
            Update role
          </button>
          <button
            className="danger"
            onClick={() => {
              setRemoveId(menuRow.id);
              setMenu(null);
            }}
          >
            Remove from campaign
          </button>
        </div>
      )}

      {roleFor && (
        <RoleModal
          person={roleFor}
          busy={busy}
          onSave={(role) => writeMembers(roleFor.id, role)}
          onClose={() => setRoleFor(null)}
        />
      )}

      {removeRow && (
        <ConfirmDeleteModal
          name={removeRow.name}
          title={`Remove ${removeRow.name} from this campaign?`}
          description="They lose access to this campaign - its map, sheets, notes and chat. Nothing of theirs is deleted, and you can add them back later."
          confirmLabel="Remove from campaign"
          onConfirm={() => writeMembers(removeRow.id, 'none')}
          onClose={() => setRemoveId('')}
        />
      )}
    </div>
  );
}

/**
 * "Player or DM?" - the whole of what Update role asks.
 *
 * A dialog rather than two more menu items, because the menu would then have to
 * say which one they already are, and a menu that reports state is a menu you
 * have to read twice.
 */
function RoleModal({ person, busy, onSave, onClose }) {
  const [role, setRole] = useState(person.role);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    try {
      await onSave(role);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal" role="dialog" aria-modal="true" aria-label={`Role for ${person.name}`} onSubmit={save}>
        <div className="modal-head">
          <h2>{person.name}’s role</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="token-field">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)} autoFocus>
            <option value="player">Player</option>
            <option value="dm">DM</option>
          </select>
        </label>

        <p className="hint">
          A DM can edit scenes, tokens and everyone’s sheets. A player moves their own token and
          reads what they’ve been given.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || role === person.role}>
            {busy ? 'Saving…' : 'Save role'}
          </button>
        </div>
      </form>
    </div>
  );
}
