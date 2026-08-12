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
  // Whether the "we've sent it, if there was anywhere to send it" note is up.
  const [asked, setAsked] = useState(false);

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

  /**
   * Ask for a reset link.
   *
   * The screen is written to match a server that will not say whether the
   * account exists: it claims nothing was sent, only that if there was
   * somewhere to send to, something has gone. Anything more definite here would
   * put back the account-enumeration leak the route goes out of its way to
   * avoid — and would be a lie in the two cases where nothing was posted.
   */
  async function askForReset(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.forgotPassword(username);
      setAsked(true);
    } catch (err) {
      // Only a rate limit or a dead server reaches this; a request that got
      // through is a success by definition.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const backToLogin = () => {
    setMode('login');
    setAsked(false);
    setError('');
    setPassword('');
  };

  /**
   * Recovery takes over the screen rather than sitting under the form.
   *
   * The two tabs offer the two things you do when you *can* get in; this is
   * what you do when you can't, and leaving them up with neither one lit invites
   * the click that loses whatever has just been typed here.
   */
  if (mode === 'forgot') {
    return (
      <div className="auth">
        <h1>⚔️ RPG Manager</h1>
        <h2>Forgotten your password</h2>

        {asked ? (
          <>
            <p className="hint">
              If that account exists and has an email address on it, a link to set a new password is
              on its way. It works once and expires in an hour.
            </p>
            <p className="hint">
              {config.canSendMail
                ? 'Nothing arrived? An account registered with a signup code may have no address on file — there is no way to reach it, and the server admin can hand you a reset link instead.'
                : "This server has no mail set up, so nothing was actually posted — the link is in the server's outbox file. Ask whoever runs it."}
            </p>
            <button onClick={backToLogin}>Back to signing in</button>
          </>
        ) : (
          <>
            <p className="hint">
              Tell us who you are and we'll send a link to set a new one. Nothing changes until you
              open it and choose the new password yourself.
            </p>
            <form className="auth-form" onSubmit={askForReset}>
              <label>
                Username or email
                <input
                  value={username}
                  autoComplete="username"
                  autoFocus
                  required
                  maxLength={254}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              {error && <p className="error">{error}</p>}
              <button type="submit" disabled={busy || !username.trim()}>
                {busy ? 'Sending…' : 'Send me a link'}
              </button>
            </form>
            <p className="hint">
              <button type="button" className="linky" onClick={backToLogin}>
                Back to signing in
              </button>
            </p>
          </>
        )}
      </div>
    );
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
                better than a regex and reported in the user's language — and it
                still applies to an address that's optional, since a half-typed
                one is a typo rather than a decision to leave it out.

                Optional exactly when a signup code is being asked for: the code
                is already something only an invited person has, so an address
                on top of it is asking twice for the same assurance. The server
                decides this the same way (routes/auth.js) — this only spares
                someone filling in a field that would have been accepted empty. */}
            <label>
              Email{' '}
              <small>
                {config.signupNeedsCode ? 'optional' : 'for recovering your account'}
              </small>
              <input
                type="email"
                value={email}
                autoComplete="email"
                required={!config.signupNeedsCode}
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
          disabled={
            busy ||
            !username.trim() ||
            !password ||
            (registering && (!name.trim() || (!config.signupNeedsCode && !email.trim())))
          }
        >
          {registering ? 'Create account' : 'Log in'}
        </button>

        {/* Under the button, and only when signing in. On the register form it
            would be an offer to recover an account you are in the middle of
            saying you don't have. */}
        {!registering && (
          <button
            type="button"
            className="linky"
            onClick={() => {
              setMode('forgot');
              setError('');
            }}
          >
            Forgotten your password?
          </button>
        )}
      </form>

      <p className="hint">
        {registering
          ? `Making an account gets you onto the server — a DM still has to add you to their campaign. ${
              config.signupNeedsCode
                ? 'The signup code is what gets you in, so an email is up to you; leave it blank and there is simply no way to reach you if you lose your password.'
                : 'Your email is only ever used to get you back in; nobody else can see it.'
            }`
          : 'No account? Register above. A DM can add you to their table once you have one.'}
      </p>
    </div>
  );
}
