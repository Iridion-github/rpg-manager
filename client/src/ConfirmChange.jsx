import { useState } from 'react';
import { api } from './api.js';

/**
 * The page a confirmation link opens.
 *
 * It asks before it acts, and that is not politeness. Mail clients and security
 * scanners follow links in mail without anybody reading it, so a link that
 * changed a password by being *fetched* would be a password changed by a spam
 * filter. The link brings you here; the button is what tells the server to go
 * ahead.
 *
 * Deliberately outside the signed-in app: the mail may well be read in a
 * different browser from the one that asked for the change, and the token in
 * the link is the whole of the authorisation. Nobody has to sign in first.
 */
export default function ConfirmChange({ token, onDone }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setDone(await api.confirmChange(token));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1>⚔️ RPG Manager</h1>

      {done ? (
        <>
          <h2>{done.kind === 'password' ? 'Password changed' : 'Address changed'}</h2>
          <p className="hint">
            {done.kind === 'password'
              ? 'Your new password is now the one that works, and every session but this browser has been signed out. Sign in again to carry on.'
              : `Your account now uses ${done.email}.`}
          </p>
          <button onClick={onDone}>Carry on</button>
        </>
      ) : (
        <>
          <h2>Confirm this change</h2>
          <p className="hint">
            Somebody asked to change your account, and this link is the proof it was you. Nothing
            has happened yet.
          </p>
          <p className="hint">
            If you didn't ask for this, close this page — the link expires on its own and nothing
            will change.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="confirm-actions">
            <button onClick={confirm} disabled={busy}>
              {busy ? 'Confirming…' : 'Yes, make the change'}
            </button>
            <button type="button" className="linky" onClick={onDone}>
              No, leave it alone
            </button>
          </div>
        </>
      )}
    </div>
  );
}
