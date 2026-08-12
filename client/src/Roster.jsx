import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import { exactTime, timeAgo } from './timeAgo.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';

/**
 * The people this server knows about.
 *
 * A list rather than a place to make accounts, and no longer a place to hand
 * out credentials either. Registration is how somebody arrives, a password is
 * how they get back in, and both belong to them rather than to the admin.
 *
 * Everyone signed in may read it: it carries names and colours and nothing else
 * - the server strips the rest before it leaves (publicUser) - and knowing who
 * else is at the server is what lets a player recognise the person a DM just
 * added to their table. Only the admin sees a way to remove anybody, and the
 * server refuses it from anyone else regardless of what this draws.
 */
export default function Roster({ isAdmin, onUsersChanged }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  // The person a confirmation dialog is currently asking about.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  // A reset link the admin has just been handed: { name, link, minutes }. One
  // at a time - two on screen is two chances to send the wrong person's.
  const [issued, setIssued] = useState(null);

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

  /**
   * Who is connected changes without this page doing anything, so the server
   * says when it moves. The nudge carries nothing - it's a signal to ask again,
   * which keeps the server from having to work out who may be told what.
   */
  useEffect(() => {
    socket.on('presence:changed', load);
    // A reconnection of our own is also a moment the list is stale: we were the
    // ones missing while it was down.
    socket.on('connect', load);
    return () => {
      socket.off('presence:changed', load);
      socket.off('connect', load);
    };
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

  /**
   * Get a reset link for somebody the server can't write to.
   *
   * The last resort, and only that. Anybody with an address on file gets their
   * own link from the sign-in screen without the admin ever hearing about it -
   * this is for the account registered under a signup code, which was never
   * asked for a mailbox and so has nowhere for a letter to go.
   */
  async function issueReset(user) {
    setError('');
    setIssued(null);
    try {
      const { link, minutes } = await api.resetUserPassword(user.id);
      setIssued({ name: user.name, link, minutes });
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="roster">
      {error && <p className="error">{error}</p>}

      {/* A header, because the second column is a date and a column of dates
          with nothing above it is a column of numbers you have to guess at. */}
      <div className="roster-head">
        <span className="roster-who">Name</span>
        <span className="roster-seen">Last online</span>
      </div>

      <ul className="player-list">
        {rows.map((u) => (
          <li key={u.id}>
            {/* Was the person's own colour, which said nothing you couldn't
                already read off their name. Green or red says the one thing a
                list of people is usually consulted for. */}
            <span
              className={`presence-dot${u.online ? ' on' : ''}`}
              title={u.online ? 'Online now' : 'Not connected'}
              aria-label={u.online ? 'Online' : 'Offline'}
              role="img"
            />
            <strong className="roster-who">{u.name}</strong>
            {u.globalRole === 'admin' && <span className="badge role gm">admin</span>}
            {/* Someone connected right now has no "last time" worth printing -
                it is this moment, and it would tick over as you read it. */}
            <span className="roster-seen" title={u.online ? '' : exactTime(u.lastSeenAt)}>
              {u.online ? 'Online now' : timeAgo(u.lastSeenAt) || 'Never'}
            </span>
            {/* Nothing to press unless you're the admin - and the admin account
                has no delete even then, since removing it would leave a server
                whose password authenticates as nobody. The server refuses this
                from anyone else regardless; hiding it only means not offering a
                button whose whole answer would be "no". */}
            {isAdmin && u.globalRole !== 'admin' && (
              <>
                {/* The admin's half of password recovery. Not hidden behind a
                    confirmation the way removal is: nothing is destroyed by
                    asking, the link expires on its own, and issuing a second
                    one silently retires the first. */}
                <button
                  className="linky"
                  onClick={() => issueReset(u)}
                  title={`Get a password reset link for ${u.name}`}
                >
                  🔑
                </button>
                <button
                  className="del"
                  onClick={() => setConfirmDeleteId(u.id)}
                  title={`Remove ${u.name}`}
                >
                  ✕
                </button>
              </>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="empty">Nobody yet.</li>}
      </ul>

      {/* Said plainly rather than softened: for the next hour this string is
          that account. The admin could already reach into the files on the
          machine and do worse, so this isn't a new power - but a button is
          easier to press than a text editor is to open, and the screen offering
          it should be the thing that says so. */}
      {issued && (
        <div className="reset-issued">
          <p className="hint">
            A reset link for <strong>{issued.name}</strong>. Send it to them however you normally
            reach them. Whoever opens it can set the password on that account, so don't post it
            anywhere you wouldn't post the password itself. It works once, and expires in{' '}
            {issued.minutes} minutes.
          </p>
          <input readOnly value={issued.link} onFocus={(e) => e.target.select()} />
          <div className="confirm-actions">
            <button onClick={() => navigator.clipboard?.writeText(issued.link)}>Copy link</button>
            <button type="button" className="linky" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </div>
      )}

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
