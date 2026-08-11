import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Your own account: what the server knows about you, and the three things you
 * can change about it.
 *
 * The three are deliberately not alike, and the screen doesn't pretend they
 * are. Your shown name is a label — it changes when you say so. A password and
 * an address are how you get back in, so each needs something the person at the
 * keyboard might not have: the current password, and then either the signup
 * code or an answer to a letter.
 *
 * Which of those two is offered depends on the server. One with no code set has
 * only the letter; one that can't send mail has only the code; a server with
 * neither says so plainly rather than showing a form that cannot finish.
 */

// What a field says after it's been used: what happened, and whether it worked.
const settled = (kind, text) => ({ kind, text });

function Note({ note }) {
  if (!note) return null;
  return <p className={note.kind === 'bad' ? 'error' : 'hint account-said'}>{note.text}</p>;
}

export default function Account({ actor, config, onChanged, offline }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  // Each form keeps its own state and its own answer, so a failed password
  // change doesn't wipe what was typed into the address below it.
  const [name, setName] = useState('');
  const [nameNote, setNameNote] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  // Typed twice, because a password field shows you nothing. A typo in a change
  // you confirm by email is a lockout that only becomes apparent later, at the
  // sign-in screen, with no way back to the password you meant.
  const [again, setAgain] = useState('');
  const [pwCode, setPwCode] = useState('');
  const [pwNote, setPwNote] = useState(null);
  const [pwBusy, setPwBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [mailCode, setMailCode] = useState('');
  const [mailNote, setMailNote] = useState(null);
  const [mailBusy, setMailBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .whoami()
      .then((data) => {
        if (!alive) return;
        setMe(data.user || null);
        setName(data.user?.name || '');
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const isAdmin = actor?.globalRole === 'admin';
  const hasCode = Boolean(config?.hasSignupCode);
  const canMail = Boolean(config?.canSendMail);
  const hasEmail = Boolean(me?.email);
  // With no address on file there is nowhere to send a confirmation, so the
  // code is the only way through — which is exactly the bargain an account
  // registered without one already made.
  const mustUseCode = !hasEmail;
  // Both boxes agree. Compared rather than trimmed: a space at either end of a
  // password is a character like any other, and quietly removing it here would
  // set a password the person could never type again.
  const passwordsMatch = next === again;

  async function saveName(e) {
    e.preventDefault();
    if (nameBusy) return;
    setNameBusy(true);
    setNameNote(null);
    try {
      const { user } = await api.updateAccount(name.trim());
      setMe(user);
      setName(user.name || '');
      setNameNote(settled('ok', 'Saved. The table sees the new name straight away.'));
      onChanged?.();
    } catch (err) {
      setNameNote(settled('bad', err.message));
    } finally {
      setNameBusy(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    if (pwBusy) return;
    // The button is already disabled on a mismatch; this is the same rule said
    // where a stray Enter key can also reach it.
    if (next !== again) {
      setPwNote(settled('bad', "The two new passwords don't match."));
      return;
    }
    setPwBusy(true);
    setPwNote(null);
    try {
      const answer = await api.changePassword(current, next, pwCode.trim());
      setCurrent('');
      setNext('');
      setAgain('');
      setPwCode('');
      if (answer?.applied) {
        setPwNote(
          settled('ok', 'Password changed. Everywhere else you were signed in has been signed out.')
        );
      } else if (answer?.delivered) {
        setPwNote(
          settled('ok', `Nothing has changed yet. Open the link sent to ${answer.sentTo} to finish.`)
        );
      } else {
        setPwNote(
          settled(
            'ok',
            'Nothing has changed yet — and this server has no mail set up, so the link was written to its log instead of being sent. Whoever runs it can find it there.'
          )
        );
      }
    } catch (err) {
      setPwNote(settled('bad', err.message));
    } finally {
      setPwBusy(false);
    }
  }

  async function saveEmail(e) {
    e.preventDefault();
    if (mailBusy) return;
    setMailBusy(true);
    setMailNote(null);
    try {
      const answer = await api.changeEmail(email.trim(), mailCode.trim());
      setMailCode('');
      if (answer?.applied) {
        setEmail('');
        setMe((u) => ({ ...u, email: answer.email }));
        setMailNote(settled('ok', 'Address changed.'));
      } else if (answer?.delivered) {
        setMailNote(
          settled(
            'ok',
            `Nothing has changed yet. A warning went to ${answer.sentTo} — the address you're leaving — and the link in it finishes the move.`
          )
        );
      } else {
        setMailNote(
          settled(
            'ok',
            'Nothing has changed yet — and this server has no mail set up, so the link was written to its log instead of being sent.'
          )
        );
      }
      onChanged?.();
    } catch (err) {
      setMailNote(settled('bad', err.message));
    } finally {
      setMailBusy(false);
    }
  }

  if (loading) return <div className="account" />;

  return (
    <div className="account">
      <h2>My account</h2>

      {offline && <p className="error">Offline — nothing here can be changed right now.</p>}

      {/* What the server holds. The username is here and has no form beside it
          on purpose: it's how you are identified, to the server and to every
          campaign you're in, and a name that can be handed to somebody else is
          not an identity. */}
      <dl className="account-facts">
        <div>
          <dt>Username</dt>
          <dd>{me?.username || '—'}</dd>
        </div>
        <div>
          <dt>Shown name</dt>
          <dd>{me?.name || '—'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          {/* The same dash every other empty row here uses. "None on file" was a
              sentence explaining an absence that the dash already states. */}
          <dd>{me?.email || '—'}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{isAdmin ? 'Server admin' : 'Player'}</dd>
        </div>
      </dl>

      <form className="account-form" onSubmit={saveName}>
        <h3>Shown name</h3>
        <p className="hint">How the table sees you. Yours to change whenever you like.</p>
        <label>
          <input
            value={name}
            maxLength={60}
            placeholder="Kira the Bold"
            disabled={offline}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="account-actions">
          <button type="submit" disabled={offline || nameBusy || !name.trim() || name.trim() === me?.name}>
            {nameBusy ? 'Saving…' : 'Update the visible name'}
          </button>
        </div>
        <Note note={nameNote} />
      </form>

      {isAdmin ? (
        <section className="account-form">
          <h3>Password</h3>
          <p className="hint">
            The admin password is the server's own configuration — change ADMIN_PASSWORD where the
            server is run, not here.
          </p>
        </section>
      ) : (
        <form className="account-form" onSubmit={savePassword}>
          <h3>Password</h3>
          <p className="hint">
            {mustUseCode
              ? 'This account has no address on file, so the signup code is the only way to finish a password change.'
              : hasCode
                ? 'The current password is always needed. Then either type the signup code to finish here and now, or leave it blank and a link will be sent to your address — nothing changes until you open it.'
                : 'The current password is always needed. A link will be sent to your address, and nothing changes until you open it.'}
          </p>
          <label>
            Current password
            <input
              type="password"
              value={current}
              autoComplete="current-password"
              disabled={offline}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              value={next}
              autoComplete="new-password"
              disabled={offline}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label>
            New password again
            <input
              type="password"
              value={again}
              autoComplete="new-password"
              disabled={offline}
              onChange={(e) => setAgain(e.target.value)}
            />
            {/* Only once there's something to disagree with. Complaining at the
                first keystroke of a field being filled in is a complaint about
                nothing. */}
            {again && !passwordsMatch && (
              <small className="account-mismatch">The two don't match.</small>
            )}
          </label>
          {hasCode && (
            <label>
              Signup code{' '}
              <small>{mustUseCode ? 'required' : 'optional — skips the emailed link'}</small>
              <input
                value={pwCode}
                autoComplete="off"
                disabled={offline}
                onChange={(e) => setPwCode(e.target.value)}
              />
            </label>
          )}
          {!hasCode && !canMail && (
            <p className="error">
              This server has no signup code and no mail set up, so there is no way to finish a
              password change. Whoever runs it can set SMTP_HOST and MAIL_FROM, or a SIGNUP_CODE.
            </p>
          )}
          <div className="account-actions">
            <button
              type="submit"
              disabled={
                offline ||
                pwBusy ||
                !current ||
                !next ||
                !passwordsMatch ||
                (mustUseCode && !pwCode.trim())
              }
            >
              {pwBusy ? 'Working…' : 'Change password'}
            </button>
          </div>
          <Note note={pwNote} />
        </form>
      )}

      <form className="account-form" onSubmit={saveEmail}>
        <h3>Email</h3>
        <p className="hint">
          {mustUseCode
            ? 'There is no address here yet, so there is nowhere to send a warning — the signup code is what sets the first one.'
            : hasCode
              ? 'The warning goes to the address you are leaving, not the one you are moving to: the person who owns it is the one who agrees to lose it. The signup code skips that step.'
              : 'The warning goes to the address you are leaving, not the one you are moving to. Nothing changes until you open the link in it.'}
        </p>
        <label>
          New address
          <input
            type="email"
            value={email}
            autoComplete="email"
            maxLength={254}
            placeholder="you@example.com"
            disabled={offline}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {hasCode && (
          <label>
            Signup code{' '}
            <small>{mustUseCode ? 'required' : 'optional — skips the emailed link'}</small>
            <input
              value={mailCode}
              autoComplete="off"
              disabled={offline}
              onChange={(e) => setMailCode(e.target.value)}
            />
          </label>
        )}
        <div className="account-actions">
          <button
            type="submit"
            disabled={offline || mailBusy || !email.trim() || (mustUseCode && !mailCode.trim())}
          >
            {mailBusy ? 'Working…' : 'Change email'}
          </button>
        </div>
        <Note note={mailNote} />
      </form>
    </div>
  );
}
