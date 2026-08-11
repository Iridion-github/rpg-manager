'use strict';

/**
 * Sending mail, and what to do when this server can't.
 *
 * There is exactly one thing the app posts: a link that finalises a change
 * somebody asked for. Nothing here is a newsletter and nothing is marketing, so
 * the transport is whatever mailbox the person running the server already has —
 * SMTP settings in the environment, and no account with anybody required.
 *
 * With nothing configured, mail goes to an outbox file and the log instead of
 * nowhere. That is not a pretend success: the route tells the caller the letter
 * wasn't delivered, the screen says so, and the link is somewhere the person
 * running the server can reach it. It's what makes the whole flow usable before
 * any credentials exist, and it's why a missing password is not an outage.
 */

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

/**
 * The mailbox this app sends from.
 *
 * Written here, in the open, because an address is not a secret: it goes out on
 * the front of every letter this sends. The *password* to it is a secret and is
 * never in this file — it arrives as SMTP_PASS from the environment, and with
 * no password nothing is sent at all (see `missing`, below). Keeping the two
 * apart is the point: there is no arrangement of this file that leaks a
 * credential, and no config file next to it inviting one to be pasted in.
 *
 * SITE_EMAIL overrides it, for running a second copy of this server from
 * another mailbox.
 */
const DEFAULT_SITE_EMAIL = 'rpgmanageradmin@gmail.com';

/**
 * One address for the common case: at Gmail and anywhere like it the sender,
 * the login and the account are all the same, and writing it three times is
 * three chances to write it differently. SMTP_USER and MAIL_FROM still override
 * it where they genuinely differ — a relay sending on behalf of an address it
 * doesn't own, say.
 */
const SITE_EMAIL = process.env.SITE_EMAIL || DEFAULT_SITE_EMAIL;
const SMTP_USER = process.env.SMTP_USER || SITE_EMAIL;
const MAIL_FROM = process.env.MAIL_FROM || SITE_EMAIL || SMTP_USER;

// The submission server for the mailboxes people actually have. Only a default:
// SMTP_HOST wins, and anything not listed here has to say. Kept short on
// purpose — a guess that's wrong is worse than no guess, because it fails at
// send time rather than at startup.
const KNOWN_HOSTS = {
  'gmail.com': 'smtp.gmail.com',
  'googlemail.com': 'smtp.gmail.com',
};
const domainOf = (address) => String(address).split('@')[1]?.toLowerCase() || '';
const SMTP_HOST = process.env.SMTP_HOST || KNOWN_HOSTS[domainOf(MAIL_FROM)] || '';

const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_PASS = process.env.SMTP_PASS || '';
// Port 465 is TLS from the first byte; 587 starts plain and upgrades. Set this
// only to override the guess that follows from the port.
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE !== 'false'
  : SMTP_PORT === 465;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUTBOX = path.join(DATA_DIR, 'outbox.log');

/**
 * What's still missing before a letter could go out.
 *
 * Named rather than merely counted, because "mail is off" on a server where
 * someone has plainly been trying to switch it on is the least useful thing
 * this could say. A mailbox that wants a login and hasn't been given a password
 * counts as *not* configured: trying anyway would turn every password change
 * into an authentication failure, which is worse than the outbox it would
 * otherwise have fallen back to.
 */
const missing = [];
if (!MAIL_FROM) missing.push('SITE_EMAIL');
if (!SMTP_HOST) missing.push('SMTP_HOST');
if (SMTP_USER && !SMTP_PASS) missing.push('SMTP_PASS');

/** Whether this server can actually post a letter. */
const mailConfigured = missing.length === 0;

/** One line for the startup banner: what it will do, or what it still needs. */
const mailStatus = mailConfigured
  ? `SMTP configured — sending as ${MAIL_FROM} via ${SMTP_HOST}:${SMTP_PORT}`
  : `off (set ${missing.join(', ')}) — confirmation links go to ${OUTBOX}`;

let transport = null;
if (mailConfigured) {
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    // A mailbox that wants no login is a local relay, and passing empty
    // credentials to one is an authentication failure rather than a skip.
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

function toOutbox(mail) {
  const entry = [
    `--- ${new Date().toISOString()} ---`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    '',
    mail.text,
    '',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(OUTBOX, entry);
  } catch (err) {
    // The log below is the real fallback; the file is a convenience.
    console.error('[mail] could not write the outbox file:', err.message);
  }
  console.warn(
    `[mail] SMTP is not configured, so nothing was sent. The letter for ${mail.to} is in ${OUTBOX}:\n${entry}`
  );
}

/**
 * Post one letter.
 *
 * Resolves with whether it actually went. It does not throw on a server with no
 * mail set up — that's a configuration this deployment is allowed to be in —
 * but it does throw when a configured server fails to send, because then
 * something is wrong that the person asking needs to hear about.
 */
async function sendMail({ to, subject, text }) {
  if (!to) throw new Error('No address to send to.');
  if (!transport) {
    toOutbox({ to, subject, text });
    return { delivered: false };
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text });
  return { delivered: true };
}

module.exports = { sendMail, mailConfigured, mailStatus, OUTBOX };
