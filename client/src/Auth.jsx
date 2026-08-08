import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Sign in, or make an account.
 *
 * Shown in place of the app when nobody is signed in. There's nothing useful
 * behind it — every campaign endpoint needs an identity — so this is a door
 * rather than a banner over a half-usable page.
 */
export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [config, setConfig] = useState({ signupIsOpen: true, signupNeedsCode: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authConfig().then(setConfig).catch(() => {});
  }, []);

  const registering = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = registering
        ? await api.register({ username, password, name, email, code })
        : await api.login(username, password);
      // Registering signs you in, so both paths end the same way.
      onSignedIn(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1>⚔️ RPG Manager</h1>

      <div className="auth-switch">
        <button
          className={!registering ? 'active' : ''}
          onClick={() => {
            setMode('login');
            setError('');
          }}
        >
          Log in
        </button>
        <button
          className={registering ? 'active' : ''}
          onClick={() => {
            setMode('register');
            setError('');
          }}
        >
          Register
        </button>
      </div>

      <form className="auth-form" onSubmit={submit}>
        <label>
          Username <small>{registering ? 'for logging in, 4–30 characters' : ''}</small>
          <input
            value={username}
            autoComplete="username"
            autoFocus
            required
            minLength={registering ? 4 : undefined}
            maxLength={registering ? 30 : undefined}
            // The browser gets the same rule the server enforces, so a typo is
            // caught before a round trip rather than after one.
            pattern={registering ? '[A-Za-z0-9_-]{4,30}' : undefined}
            title={registering ? 'Letters, numbers, dash and underscore' : undefined}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label>
          Password <small>{registering ? '8–30 characters' : ''}</small>
          <input
            type="password"
            value={password}
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
            minLength={registering ? 8 : undefined}
            maxLength={registering ? 30 : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {registering && (
          <>
            <label>
              Shown name <small>how the table sees you</small>
              <input
                value={name}
                required
                maxLength={60}
                placeholder="Kira the Bold"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            {/* type="email" gets the browser's own validation, which is both
                better than a regex and reported in the user's language. */}
            <label>
              Email <small>for recovering your account</small>
              <input
                type="email"
                value={email}
                autoComplete="email"
                required
                maxLength={254}
                placeholder="you@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            {/* Only asked for when the server actually wants one. */}
            {config.signupNeedsCode && (
              <label>
                Signup code
                <input value={code} onChange={(e) => setCode(e.target.value)} required />
              </label>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password || (registering && (!name.trim() || !email.trim()))}
        >
          {registering ? 'Create account' : 'Log in'}
        </button>
      </form>

      <p className="hint">
        {registering
          ? 'Making an account gets you onto the server — a DM still has to add you to their campaign. Your email is only ever used to get you back in; nobody else can see it.'
          : 'No account? Register above. If a DM sent you an invite link, opening it signs you in without one.'}
      </p>
    </div>
  );
}
