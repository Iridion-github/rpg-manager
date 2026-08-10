'use strict';

/**
 * The headers and the cross-origin policy, in one place.
 *
 * Written out rather than pulled from helmet: there are a dozen lines of it,
 * every one of them is a decision this app has to make anyway (the YouTube
 * player alone rules out any default policy), and a header you can read is a
 * header you can argue with. The trade is that new defaults don't arrive for
 * free — if this file is still here in two years, check it against what
 * browsers have learned since.
 */

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

/**
 * Who may call this API from another origin.
 *
 * Empty means "nobody" — which is the right answer for a published server,
 * because the app is served from the same origin as the API and same-origin
 * requests never consult CORS at all. It is only the split dev setup (Vite on
 * 5173, API on 3001) that genuinely needs an entry here.
 *
 * `*` is deliberately not reachable. Requests here carry their credential in a
 * header rather than a cookie, so a wildcard couldn't be ridden by a stranger's
 * browser the way a cookie-authenticated one could — but with the gate open in
 * dev an unauthenticated caller *is* the admin, which turns any page you happen
 * to visit into a remote control for your own machine.
 */
function allowedOrigins({ gateEnabled }) {
  const configured = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (configured.length) return configured;
  return gateEnabled ? [] : DEV_ORIGINS;
}

// The credential headers this API actually reads, plus the ones a JSON POST
// needs. Listed rather than reflected: echoing back whatever was asked for
// makes the allowlist decorative.
const ALLOWED_HEADERS = [
  'content-type',
  'x-session',
  'x-client-id',
  'x-admin-password',
  'x-gm-password',
  'x-user-key',
  'x-player-key',
];

function corsPolicy(origins) {
  const allow = new Set(origins);
  return function cors(req, res, next) {
    const origin = req.get('origin');
    // No Origin header is a same-origin request, a curl, or a native client —
    // none of which CORS governs. Answer normally and add nothing.
    if (origin && allow.has(origin.replace(/\/$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // The response differs by origin, so a shared cache must not hand one
      // origin's response to another.
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(','));
      res.setHeader('Access-Control-Max-Age', '600');
    }
    // A preflight is answered whether or not we allowed it: without the headers
    // above the browser refuses the real request, which is the point.
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

/**
 * The content policy.
 *
 * `style-src` has to allow inline styles: every token on the map is positioned
 * with a style attribute, and CSP counts those as inline. Scripts are not
 * granted the same, so the one thing an injection would need most is missing.
 *
 * YouTube is in here because the music player embeds it — the API script comes
 * from www.youtube.com and loads its widget from s.ytimg.com, and the player
 * itself is an iframe. Everything else is same-origin.
 */
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Nobody frames us. Uploaded images can't be turned into a clickjacking
    // surface over someone's tabletop.
    "frame-ancestors 'none'",
    "form-action 'self'",
    // data: for the chevron the selects draw themselves; blob: for object URLs
    // the backup download makes.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    // 'self' covers the Socket.IO upgrade to ws:// on this same origin.
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
  ].join('; ');
}

function securityHeaders(req, res, next) {
  // The one that matters most here: uploads are served from this origin, and
  // this is what stops a browser from second-guessing their declared type and
  // running one as a document.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy());

  // Only over TLS, and only once we can tell: sending HSTS from a plain-http
  // dev server would pin localhost to https in your browser for months.
  const proto = req.get('x-forwarded-proto') || req.protocol;
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

module.exports = { allowedOrigins, corsPolicy, securityHeaders, contentSecurityPolicy };
