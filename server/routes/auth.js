'use strict';

/**
 * Register, log in, log out.
 *
 * Sessions are bearer tokens rather than cookies: the app already sends its
 * credentials as headers and the socket sends them in its handshake, so a token
 * fits both without cookie plumbing or CSRF handling. The tradeoff is that a
 * token in localStorage is readable by any script that gets injected into the
 * page - worth knowing, and the reason a session expires rather than lasting
 * forever.
 *
 * Registration is open unless SIGNUP_CODE is set. On your own machine that's
 * the convenient default; on a hostname a stranger can find it is not, which is
 * why the startup banner nags about it.
 */

const express = require('express');
const store = require('../store');
const limits = require('../rateLimit');
const { notifyUser } = require('../realtime');
const { pictureUrl } = require('../pictures');
const { sendMail, mailConfigured } = require('../mailer');
const { confirmLink, resetLink } = require('../links');
const { holdChange, claimChange, forgetChangesFor, TTL_MS } = require('../accountChanges');
const {
  USERS,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  gateEnabled,
  signupIsOpen,
  SIGNUP_CODE,
  hashPassword,
  verifyPassword,
  secretsMatch,
  validateCredentials,
  validateProfile,
  validateEmail,
  requireUser,
  normalizeUsername,
  normalizeEmail,
  findUserByUsername,
  findUserByEmail,
  createSession,
  destroySession,
  destroySessionsFor,
  ensureAdminUser,
  credsFromRequest,
  publicUser,
  colorFor,
} = require('../auth');

const router = express.Router();

const cleanName = (v) => String(v || '').trim();

/**
 * When they last signed in, for the campaign's player list.
 *
 * Written on the way past a successful login rather than tracked per request:
 * this answers "when were you last here", which is a different question from
 * "are you here now" - presence answers that, and it comes from the live
 * sockets rather than from anything stored.
 */
const markLogin = (userId) =>
  store.update(USERS, userId, { lastLoginAt: new Date().toISOString() });

// What the client needs to know about itself after a successful sign-in.
const sessionPayload = (user, session) => ({
  token: session.token,
  expiresAt: session.expiresAt,
  actor: {
    globalRole: user.globalRole === 'admin' ? 'admin' : 'user',
    userId: user.id,
    name: user.name,
    username: user.username || '',
    avatarUrl: user.avatarUrl || '',
  },
});

// Lets the sign-in screen say whether registration is even available, rather
// than offering a form that will be refused.
router.get('/config', (req, res) => {
  res.json({
    signupIsOpen,
    signupNeedsCode: !signupIsOpen,
    writeGate: gateEnabled,
    // What the account screen may offer: whether there's a code to type instead
    // of answering a letter, and whether this server can post one at all. A
    // screen that offered both on a server that has neither would be a screen
    // full of dead ends.
    hasSignupCode: !signupIsOpen,
    canSendMail: mailConfigured,
  });
});

router.post('/register', async (req, res, next) => {
  try {
    const from = limits.addressOf(req);
    const blocked = limits.signup.retryAfter(from);
    if (blocked) return limits.refuse(res, blocked);

    if (!signupIsOpen && !secretsMatch(String(req.body?.code || ''), SIGNUP_CODE)) {
      // Guessing the code is the only failure counted here. A password that's
      // too short is a typo, and holding that against someone would lock out
      // the one honest user fumbling the form.
      limits.signup.fail(from);
      return res.status(403).json({ error: 'That signup code is not right.' });
    }

    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? '');
    const name = cleanName(req.body?.name);
    const email = normalizeEmail(req.body?.email);

    // Getting this far on a closed server means the code was right - the check
    // above returns before this line otherwise. So the code has already
    // established that this is somebody who was invited, and an address is no
    // longer being asked for as a second piece of evidence: it's offered, for
    // the day there is something to send to it. An open server has been told
    // nothing about who is filling the form in, and still asks.
    const emailRequired = signupIsOpen;

    const problem =
      validateCredentials(username, password) || validateProfile(name, email, { emailRequired });
    if (problem) return res.status(400).json({ error: problem });

    if (username === ADMIN_USERNAME || (await findUserByUsername(username))) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    // Both are unique, and both say so plainly. This is an account-enumeration
    // leak by construction - a signup form that accepts duplicates isn't a
    // signup form, and a vaguer message would only make it harder to use
    // without making it harder to probe.
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const users = await store.list(USERS);
    const record = await store.create(USERS, {
      username,
      name,
      // Null, never an empty string. The unique index on this column skips
      // nulls and does not skip '' - so a second account without an address
      // would collide with the first one and fail on the way into the database
      // rather than in front of the person filling in the form.
      email: email || null,
      passwordHash: await hashPassword(password),
      color: colorFor(users.length),
      globalRole: 'user',
    });

    // Registering signs you in - an account you then have to log into
    // separately is a form for its own sake.
    const session = await createSession(record.id);
    limits.signup.clear(from);
    res.status(201).json(sessionPayload(record, session));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? '');

    // Both keys, because one address trying every account and every address
    // trying one account are both brute force. Checked before the password is,
    // so a blocked attempt costs no hashing.
    const keys = [limits.addressOf(req), `user:${username}`];
    for (const key of keys) {
      const blocked = limits.login.retryAfter(key);
      if (blocked) return limits.refuse(res, blocked);
    }
    const failed = () => keys.forEach((k) => limits.login.fail(k));

    /**
     * The admin signs in with ADMIN_PASSWORD rather than a stored hash.
     *
     * That password is the server's own configuration - the thing that says
     * "whoever runs this machine". Copying it into the user file at first login
     * would mean two places to change it and one of them silently winning.
     */
    if (username === ADMIN_USERNAME) {
      if (!gateEnabled || !secretsMatch(password, ADMIN_PASSWORD)) {
        failed();
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      const admin = await ensureAdminUser();
      const session = await createSession(admin.id);
      await markLogin(admin.id);
      keys.forEach((k) => limits.login.clear(k));
      return res.json(sessionPayload(admin, session));
    }

    const user = await findUserByUsername(username);
    // Same message either way: which half was wrong is not information a
    // stranger guessing at accounts should be given.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      failed();
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    const session = await createSession(user.id);
    await markLogin(user.id);
    keys.forEach((k) => limits.login.clear(k));
    res.json(sessionPayload(user, session));
  } catch (err) {
    next(err);
  }
});

// Logging out destroys the token server-side, so a copy of it that leaked
// somewhere stops working too - not merely forgotten by this browser.
router.post('/logout', async (req, res, next) => {
  try {
    await destroySession(credsFromRequest(req).session);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * "I've forgotten my password."
 *
 * The one door into this account system that an unauthenticated stranger may
 * knock on and have something happen. Three things make that safe, and all
 * three are load-bearing:
 *
 *   - **The answer never varies.** Found, not found, found but with no address,
 *     found but it's the admin - every one of them gets the same 202 and the
 *     same words. A form that said "no such account" would be a way to ask this
 *     server, one name at a time, who plays here; that a name is *registered*
 *     is not a thing a stranger is entitled to learn, and the cost of hiding it
 *     is one sentence of vagueness on a screen almost nobody reads twice.
 *   - **Nothing is chosen here.** The request carries no new password - see the
 *     note in accountChanges.js. It buys nothing but the right to type one on
 *     the page the link opens, so a stranger who fires this at your address has
 *     sent you an unwanted letter and gained no other foothold. Even clicking
 *     the link in it changes nothing on its own.
 *   - **The signup code is not accepted, deliberately.** Everywhere else in
 *     this file the code stands in for answering a letter, and everywhere else
 *     it does that *on top of* something only the owner has - being signed in,
 *     knowing the current password. Here there would be nothing underneath it,
 *     so a code shared with the whole table would be a code that takes over any
 *     account at the table, the DM's included. An account with no mailbox is
 *     recovered by the admin instead (routes/users.js).
 *
 * `who` is a username or an address, because somebody who has forgotten their
 * password may well have forgotten which of the two they signed up with.
 */
router.post('/forgot', async (req, res, next) => {
  try {
    const who = String(req.body?.who || '').trim();

    // Both keys spend from the same allowance, so neither a single caller
    // working through a list of names nor a crowd aimed at one mailbox gets
    // more than the honest user asking twice.
    for (const key of [`ip:${limits.addressOf(req)}`, `who:${normalizeUsername(who)}`]) {
      const wait = limits.recovery.take(key);
      if (wait) return limits.refuse(res, wait);
    }

    // 202: taken in, and what follows is out of the caller's sight. Said before
    // any of the work below, and said identically in every case.
    res.status(202).json({ ok: true });

    // Everything past the response is deliberate. Sending a letter takes an
    // SMTP round trip and finding nobody takes none, so a caller with a stopwatch
    // could read the difference as an answer to the question the wording above
    // is careful not to answer. Doing the work after the reply also means a
    // mail server having a slow morning is not a form that appears to hang.
    const user = who.includes('@')
      ? await findUserByEmail(who)
      : (await findUserByUsername(who)) || (await findUserByEmail(who));

    // No such person, nowhere to write to, or the admin - whose password is
    // ADMIN_PASSWORD in the environment and cannot be reset by anything this
    // server stores. All three end here, silently, having already said yes.
    if (!user || !user.email || user.globalRole === 'admin') return;

    const token = await holdChange(user.id, 'reset', {});
    await sendMail({
      to: user.email,
      subject: 'Reset the password on your RPG Manager account',
      text: [
        `Somebody - we hope you - asked to reset the password on the account "${user.username}".`,
        '',
        'Nothing has changed yet, and nothing will until you choose a new password.',
        'To do that, open this link:',
        resetLink(req, token),
        '',
        `The link works once, and stops working in ${Math.round(TTL_MS / 60000)} minutes.`,
        '',
        "If this wasn't you, do nothing at all. Your password stays exactly as it is,",
        'and whoever asked learns nothing - they cannot see this letter, and the link',
        'is the only thing that would let anyone set a new password.',
      ].join('\n'),
    }).catch((err) => {
      // Nobody is left to tell: the reply went out several lines ago, and it
      // could not have carried this news anyway without answering the question
      // of whether the account exists. The person running the server is the one
      // who can act on it.
      console.error(`[recovery] could not send the reset letter for ${user.username}:`, err.message);
    });
  } catch (err) {
    // Only reachable before the response above; after it, the catch below would
    // be trying to send headers twice.
    if (!res.headersSent) return next(err);
    console.error('[recovery] failed after answering:', err.message);
  }
});

/**
 * Finish a reset: here is the link, here is the new password.
 *
 * A separate route from /confirm rather than another `kind` inside it, because
 * it is a different shape of act. /confirm agrees to something already decided
 * and needs nothing but the token; this one *is* the deciding, and the password
 * it carries is the whole substance of it.
 *
 * No session is needed or wanted. The person reading the mail may be on a
 * machine that has never signed in here - that is the ordinary case, not the
 * strange one, since the reason they're here is that they can't sign in.
 */
router.post('/reset', async (req, res, next) => {
  try {
    // Guessing at tokens is brute force like any other.
    const key = `reset:${limits.addressOf(req)}`;
    const blocked = limits.login.retryAfter(key);
    if (blocked) return limits.refuse(res, blocked);

    /**
     * The password is checked before the token is spent.
     *
     * Order matters here and nowhere else in this file: a link that works once
     * and a password that might be refused must not meet in that sequence, or
     * typing seven characters costs the person their only way back in and the
     * screen telling them so is the screen that can no longer help. So the
     * cheap check first, and the irreversible one only once it has passed.
     *
     * A stand-in username, since whose account this is isn't known yet - the
     * same shape as the /password route, and only the password half of the
     * answer is used.
     */
    const password = String(req.body?.password ?? '');
    const problem = validateCredentials('placeholder', password);
    if (problem) return res.status(400).json({ error: problem });

    const record = await claimChange(String(req.body?.token || ''), ['reset']);
    if (!record) {
      limits.login.fail(key);
      return res.status(400).json({ error: 'That link has expired, or has already been used.' });
    }
    limits.login.clear(key);

    const user = await store.get(USERS, record.userId);
    if (!user) return res.status(404).json({ error: 'That account no longer exists.' });

    // Every session goes, this one included - there is no "this one". Somebody
    // who has just had to prove they own the mailbox should not leave behind a
    // browser still signed in from whenever the password was last known.
    await applyPassword(req, user, await hashPassword(password));
    res.json({ ok: true, username: user.username || '' });
  } catch (err) {
    next(err);
  }
});

/**
 * Whether the signup code was given, and was right.
 *
 * The code is the stand-in for answering a letter: on a server that has one,
 * knowing it is already the proof that you belong here. Returns null when no
 * code was offered at all, so a caller can tell "didn't try" from "got it
 * wrong" - the first goes to the mailbox, the second is refused.
 */
function codeGiven(req) {
  const code = String(req.body?.code || '');
  if (!code) return null;
  const ok = Boolean(SIGNUP_CODE) && secretsMatch(code, SIGNUP_CODE);
  if (!ok) limits.signup.fail(limits.addressOf(req));
  return ok;
}

/**
 * Put a new password in place, wherever the decision came from.
 *
 * Every other session goes. Changing a password usually means somebody else has
 * one, and a new password that leaves their session alive has not taken the
 * account back. The browser doing the asking keeps its own - which is nothing
 * at all when the asking is a link opened somewhere else, and that's correct
 * too: the change is finished, so signing in again with the new password is the
 * next thing to do.
 */
async function applyPassword(req, user, passwordHash) {
  await store.update(USERS, user.id, { passwordHash });
  await forgetChangesFor(user.id);
  await destroySessionsFor(user.id, { except: credsFromRequest(req).session });
}

/**
 * Change your own shown name - the one the table sees.
 *
 * The only field here that changes on the strength of being signed in. It isn't
 * a credential and it isn't how anyone is identified: the username is, and that
 * doesn't move. Getting it wrong costs a second edit.
 */
router.put('/account', requireUser, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.actor.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const name = cleanName(req.body?.name);
    // The profile check, asked about the name alone.
    const problem = validateProfile(name, '', { emailRequired: false });
    if (problem) return res.status(400).json({ error: problem });
    const updated = await store.update(USERS, user.id, { name });
    res.json({ user: { ...publicUser(updated), email: updated.email || '' } });
  } catch (err) {
    next(err);
  }
});

/**
 * Change your own profile picture, or take it off.
 *
 * Signed in is the whole of the permission, like the shown name above and for
 * the same reason: a picture is a label rather than a credential, and getting it
 * wrong costs one more press of the button. It is a route of its own rather than
 * a field on the name form because it is saved the moment a picture is chosen -
 * there is nothing else on that form to submit it with.
 *
 * The bytes went to /api/uploads and are already on disk; what arrives here is
 * only the address they landed at. An empty string is a removal, and the file
 * itself stays where it is - a few kilobytes on the host's own disk, which is
 * the same bargain every other upload in this app makes.
 */
router.put('/avatar', requireUser, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.actor.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const wanted = String(req.body?.avatarUrl ?? '');
    const avatarUrl = pictureUrl(wanted);
    // Emptied by the check rather than by the person asking: they sent an
    // address this server will not serve, and quietly storing nothing would look
    // like a picture that failed to save for no reason.
    if (wanted.trim() && !avatarUrl) {
      return res.status(400).json({ error: 'A picture has to be one this server holds.' });
    }

    const updated = await store.update(USERS, user.id, { avatarUrl });
    // Everywhere else this person is signed in is drawing the old picture beside
    // their name. The nudge carries nothing: it means "ask who you are again".
    notifyUser(req, user.id, 'identity:changed', {});
    res.json({ user: { ...publicUser(updated), email: updated.email || '' } });
  } catch (err) {
    next(err);
  }
});

/**
 * Change your own password.
 *
 * The current one is always required, however the change is finished: a session
 * left open on somebody else's machine should not be enough to lock you out of
 * your own account.
 *
 * Then one of two ways. The signup code finishes it on the spot. Without it, a
 * letter goes to the address on file and nothing changes until that link is
 * followed - so a stranger at an unlocked browser can start this, and the
 * person who owns the mailbox simply never finishes it. An account with no
 * address on file has only the first way, which is the same bargain it made at
 * registration.
 */
router.post('/password', requireUser, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.actor.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.globalRole === 'admin') {
      return res.status(400).json({
        error: 'The admin password is server configuration - change ADMIN_PASSWORD instead.',
      });
    }

    // A stolen session shouldn't become a way to guess the password at leisure.
    const key = `pw:${user.id}`;
    const blocked = limits.login.retryAfter(key);
    if (blocked) return limits.refuse(res, blocked);

    const wanted = String(req.body?.password ?? '');
    const problem = validateCredentials(user.username || 'placeholder', wanted);
    if (problem) return res.status(400).json({ error: problem });
    if (!(await verifyPassword(String(req.body?.current ?? ''), user.passwordHash))) {
      limits.login.fail(key);
      return res.status(401).json({ error: 'That current password is not right.' });
    }
    limits.login.clear(key);

    // Hashed before it goes anywhere, including into the waiting room.
    const passwordHash = await hashPassword(wanted);

    const code = codeGiven(req);
    if (code === false) return res.status(403).json({ error: 'That signup code is not right.' });
    if (code === true) {
      await applyPassword(req, user, passwordHash);
      return res.json({ applied: true });
    }

    if (!user.email) {
      return res.status(400).json({
        error:
          'This account has no email address, so a password change has to be confirmed with the signup code.',
      });
    }

    const token = await holdChange(user.id, 'password', { passwordHash });
    const { delivered } = await sendMail({
      to: user.email,
      subject: 'Confirm your new password',
      text: [
        `Somebody - we hope you - asked to change the password on the account "${user.username}".`,
        '',
        'Nothing has changed yet. To finish, open this link:',
        confirmLink(req, token),
        '',
        `The link works once, and stops working in ${Math.round(TTL_MS / 60000)} minutes.`,
        '',
        "If this wasn't you, do nothing at all. The password stays as it is - and since",
        'whoever asked was signed in as you, this is worth knowing about: sign in and',
        'change your password from a device you trust.',
      ].join('\n'),
    });
    res.json({ pending: true, delivered, sentTo: user.email });
  } catch (err) {
    next(err);
  }
});

/**
 * Change your own email address.
 *
 * No current address is asked for - you're signed in, and unlike a password an
 * address isn't a secret you prove you know. What guards it instead is where
 * the letter goes: to the address being *replaced*, so the person who owns it
 * is the one who agrees to lose it. An account with no address to warn has the
 * signup code and nothing else, for the same reason as above.
 */
router.post('/email', requireUser, async (req, res, next) => {
  try {
    const user = await store.get(USERS, req.actor.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const email = normalizeEmail(req.body?.email);
    const problem = validateEmail(email);
    if (problem) return res.status(400).json({ error: problem });
    if (email === normalizeEmail(user.email || '')) {
      return res.status(400).json({ error: 'That is already your address.' });
    }
    const taken = await findUserByEmail(email);
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: 'That email is already registered.' });
    }

    const code = codeGiven(req);
    if (code === false) return res.status(403).json({ error: 'That signup code is not right.' });
    if (code === true) {
      const updated = await store.update(USERS, user.id, { email });
      return res.json({ applied: true, email: updated.email });
    }

    if (!user.email) {
      return res.status(400).json({
        error:
          'This account has no email address yet, so there is nowhere to send the warning - use the signup code to set one.',
      });
    }

    const token = await holdChange(user.id, 'email', { email });
    const { delivered } = await sendMail({
      // Deliberately the old address, not the new one. The letter is a warning
      // to the person about to lose the account's address, not a welcome to the
      // one taking it over.
      to: user.email,
      subject: 'Confirm the new address on your account',
      text: [
        `Somebody - we hope you - asked to move the account "${user.username}" to a new email address.`,
        '',
        `From: ${user.email}`,
        `To:   ${email}`,
        '',
        'Nothing has changed yet. To finish, open this link:',
        confirmLink(req, token),
        '',
        `The link works once, and stops working in ${Math.round(TTL_MS / 60000)} minutes.`,
        '',
        "If this wasn't you, do nothing at all - this address stays on the account.",
      ].join('\n'),
    });
    res.json({ pending: true, delivered, sentTo: user.email });
  } catch (err) {
    next(err);
  }
});

/**
 * Finish a change that was waiting on a letter.
 *
 * Takes the token by POST rather than acting on the GET of the link itself.
 * Mail clients and security scanners follow links in mail without anyone
 * reading it, and a GET that changed a password would be a password changed by
 * a spam filter. So the link opens a page, and the page asks.
 *
 * No session is needed: the token is the whole authorisation, which is what
 * lets the link be opened in whatever browser the mail happened to be read in.
 */
router.post('/confirm', async (req, res, next) => {
  try {
    // Guessing at tokens is brute force like any other.
    const key = `confirm:${limits.addressOf(req)}`;
    const blocked = limits.login.retryAfter(key);
    if (blocked) return limits.refuse(res, blocked);

    // Only the two kinds this route can actually finish. A reset token arriving
    // here is somebody who edited the query parameter, and refusing it without
    // spending it leaves their real link - the one in the letter - still good.
    const record = await claimChange(String(req.body?.token || ''), ['password', 'email']);
    if (!record) {
      limits.login.fail(key);
      return res.status(400).json({ error: 'That link has expired, or has already been used.' });
    }
    limits.login.clear(key);

    const user = await store.get(USERS, record.userId);
    if (!user) return res.status(404).json({ error: 'That account no longer exists.' });

    if (record.kind === 'password') {
      await applyPassword(req, user, record.change.passwordHash);
      return res.json({ kind: 'password' });
    }

    // Asked again at the last moment: the address was free when the letter went
    // out, and somebody else may have registered it in the meantime.
    const taken = await findUserByEmail(record.change.email);
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: 'That email has been registered by somebody else since.' });
    }
    await store.update(USERS, user.id, { email: record.change.email });
    res.json({ kind: 'email', email: record.change.email });
  } catch (err) {
    next(err);
  }
});

// Who am I? The client calls this on boot.
router.get('/me', async (req, res, next) => {
  try {
    if (!req.actor || req.actor.globalRole === 'anon') return res.json(req.actor);
    const user = await store.get(USERS, req.actor.userId);
    // publicUser strips email because other people don't get to see it - but
    // this is you looking at yourself, so it comes back.
    res.json({ ...req.actor, user: { ...publicUser(user), email: user?.email || '' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
