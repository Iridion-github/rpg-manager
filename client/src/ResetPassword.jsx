import { useState } from 'react';
import { api } from './api.js';

/**
 * The page a reset link opens: choose a new password.
 *
 * The sibling of ConfirmChange, and different from it in the one way that
 * matters. That page agrees to a change somebody already decided on; this one
 * is where the deciding happens. Nothing was chosen when the link was asked
 * for — see /auth/forgot — precisely so that the password ends up being the one
 * typed *here*, by whoever opened the mail, rather than one a stranger picked
 * and then talked you into confirming.
 *
 * Outside the signed-in app, like its sibling, and for a stronger reason: the
 * person reading this cannot sign in. That's why they're here.
 */
export default function ResetPassword({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  // Typed twice because a mistyped password you cannot see becomes a second
  // forgotten password, and the link that would have fixed it has just been
  // spent. Checked here rather than at the server: the server has no business
  // being told the same secret twice, and this is a typo, not a rule.
  const mismatch = again.length > 0 && password !== again;

  async function submit(e) {
    e.preventDefault();
    if (busy || mismatch) return;
    setBusy(true);
    setError('');
    try {
      setDone(await api.resetPassword(token, password));
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
          <h2>Password set</h2>
          <p className="hint">
            {done.username
              ? `You can sign in as ${done.username} with your new password.`
              : 'You can sign in with your new password.'}{' '}
            Every session that was open on this account has been signed out, wherever it was.
          </p>
          <button onClick={onDone}>Sign in</button>
        </>
      ) : (
        <>
          <h2>Choose a new password</h2>
          <p className="hint">
            This link is the proof that the account is yours. It works once, so what you type here
            is what you will be signing in with.
          </p>
          <form className="auth-form" onSubmit={submit}>
            <label>
              New password <small>8–30 characters</small>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                autoFocus
                required
                minLength={8}
                maxLength={30}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              And again
              <input
                type="password"
                value={again}
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={30}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
            {mismatch && <p className="error">Those two don't match.</p>}
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy || mismatch || !password || !again}>
              {busy ? 'Setting…' : 'Set my password'}
            </button>
          </form>
          <p className="hint">
            <button type="button" className="linky" onClick={onDone}>
              I didn't ask for this
            </button>
          </p>
        </>
      )}
    </div>
  );
}
