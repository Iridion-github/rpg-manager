'use strict';

/**
 * The links this server puts in letters.
 *
 * Built from the request rather than from configuration, because the hostname
 * this app answers on is not something it reliably knows about itself: behind a
 * Cloudflare Tunnel it changes every time the tunnel restarts, and a link built
 * from a stale PUBLIC_URL points at a machine nobody can reach. The request
 * arrived *somewhere*, and that somewhere is by definition an address that
 * works.
 *
 * PUBLIC_URL still wins where it's set, for a deployment with a real name.
 *
 * Here rather than in routes/auth.js because two routers now send links — the
 * account flows, and the admin issuing a reset for somebody with no mailbox —
 * and a second copy of this is a second chance for the two to disagree about
 * what the confirm page is called.
 */

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

/**
 * Where this server appears to live, from the point of view of whoever is
 * asking. `req.protocol` reads X-Forwarded-Proto when TRUST_PROXY says the
 * proxy in front can be believed — without that, every link behind a tunnel
 * would say http:// and be downgraded or refused.
 */
const publicBase = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

/**
 * Two links, two query parameters, on purpose.
 *
 * They open different pages and the client has to know which without asking the
 * server — and it must not have to *guess*, because the two are answered by
 * different routes and presenting one at the other's door is a wasted token.
 * `confirm` finishes something already decided; `reset` opens a form that has
 * still to be filled in.
 */
const confirmLink = (req, token) => `${publicBase(req)}/?confirm=${token}`;
const resetLink = (req, token) => `${publicBase(req)}/?reset=${token}`;

module.exports = { publicBase, confirmLink, resetLink, PUBLIC_URL };
