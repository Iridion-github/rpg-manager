'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { allowedOrigins, corsPolicy, securityHeaders } = require('./security');
const limits = require('./rateLimit');
const { Server } = require('socket.io');

const store = require('./store');
const {
  USERS,
  gateEnabled,
  signupIsOpen,
  attachActor,
  resolveActor,
  sweepExpiredSessions,
  dropInviteKeys,
} = require('./auth');
const { mailStatus } = require('./mailer');
const { attachCampaign, isCampaignId, roleIn, touchActivity, CAMPAIGNS } = require('./campaigns');
const { importJson } = require('./importJson');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const campaignsRouter = require('./routes/campaigns');
const sheetsRouter = require('./routes/sheets');
const scenesRouter = require('./routes/scenes');
const { router: chatRouter } = require('./routes/chat');
const notesRouter = require('./routes/notes');
const musicRouter = require('./routes/music');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: mapsRouter, MAPS_DIR } = require('./routes/maps');
const { router: tokensRouter, TOKENS_DIR } = require('./routes/tokens');
const { registerTokenDrag, roomFor } = require('./tokenDrag');
const { announcePresence } = require('./realtime');
const { registerSceneSignals } = require('./sceneSignals');

const PORT = Number(process.env.PORT) || 3001;

/**
 * Listen on localhost only, by default.
 *
 * The tunnel runs on this same machine and dials localhost, so binding here
 * costs it nothing — and it means the only way in from outside is the tunnel,
 * which you can shut off. A default of 0.0.0.0 would quietly put the table on
 * every coffee-shop network you ever join. Set HOST=0.0.0.0 to reach it from
 * another device on your LAN.
 */
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

/**
 * How many proxies sit in front of us.
 *
 * This is load-bearing for rate limiting, not a detail. Behind Render's router
 * or a Cloudflare Tunnel every request arrives from the same address, so
 * without this the limiter would put the entire table in one bucket and one
 * person's mistyped password would lock everybody out.
 *
 * It defaults to off because the opposite mistake is worse: trusting a
 * forwarding header nobody set lets a caller claim any address it likes, and
 * then the limiter can be sidestepped by lying. Render sets TRUST_PROXY=1 in
 * render.yaml; behind a tunnel, set it to 1 too.
 */
const TRUST_PROXY = process.env.TRUST_PROXY || '';
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

const CORS_ORIGINS = allowedOrigins({ gateEnabled });

app.use(securityHeaders);
app.use(corsPolicy(CORS_ORIGINS));
app.use(express.json({ limit: '2mb' }));
app.use(attachActor); // every request knows who it is

// A ceiling over the whole API, spent per account where there is one. After
// attachActor so it knows whose bucket to charge, and scoped to /api so that
// loading the page's own assets can never be what runs someone out of quota.
app.use('/api', (req, res, next) => {
  const wait = limits.api.take(limits.bucketOf(req));
  return wait ? limits.refuse(res, wait) : next();
});

const server = http.createServer(app);
// The same allowlist the HTTP side uses. Socket.IO's handshake is a real
// cross-origin request, so leaving this open would reopen the door the policy
// above just shut.
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS.length ? CORS_ORIGINS : false },
});
app.set('io', io); // routes reach io via req.app.get('io')

// Sockets authenticate once at handshake; the resolved actor rides along on the
// connection. A session destroyed mid-connection takes effect on the next
// reconnect.
io.use(async (socket, next) => {
  try {
    const { gmPassword, adminPassword, session } = socket.handshake.auth || {};
    socket.data.actor = await resolveActor({
      session,
      adminPassword: adminPassword || gmPassword,
    });
    next();
  } catch (err) {
    next(err);
  }
});

/**
 * Note that this person was here just now.
 *
 * Distinct from `lastLoginAt`, which answers "when did they last prove who they
 * are". This answers "when were they last connected", and they part company the
 * moment somebody leaves a tab open for a fortnight.
 *
 * Failures are swallowed on purpose: a socket connecting is not a request
 * anybody is waiting on, and a write that fails should not take the connection
 * down with it.
 */
function markSeen(socket) {
  const userId = socket.data.actor?.userId;
  if (!userId) return;
  store
    .update(USERS, userId, { lastSeenAt: new Date().toISOString() })
    .catch((err) => console.error('could not record presence:', err.message));
}

io.on('connection', (socket) => {
  socket.emit('hello', { message: 'connected to rpg-manager', actor: socket.data.actor });

  // Arriving, leaving and moving between tables are the three things that
  // change who is shown as online or present, so each of them says so.
  announcePresence(io);
  markSeen(socket);
  socket.on('disconnect', () => {
    announcePresence(io);
    // Written on the way out as well as the way in: while a connection is open
    // "last online" is now, and the moment worth remembering is the one it
    // closed. A server that dies without warning leaves the arrival time
    // instead, which is the honest answer to "when were they last *seen*".
    markSeen(socket);
  });

  /**
   * "I'm looking at this campaign now."
   *
   * Live updates are scoped to a campaign, and a socket has no URL to read that
   * from — so it says. Membership is verified here rather than taken on trust,
   * because this is what decides which broadcasts the connection receives: a
   * socket that could name any campaign could listen to any table.
   */
  socket.on('campaign:enter', async ({ campaignId } = {}, ack) => {
    try {
      if (socket.data.campaignId) socket.leave(roomFor(socket.data.campaignId));
      socket.data.campaignId = null;
      socket.data.drag = null; // a drag doesn't survive leaving the table

      // Closing a campaign comes through here too, as an enter with nothing to
      // enter — and leaving the table is exactly the kind of move the people
      // still in it should see.
      if (!isCampaignId(campaignId)) {
        announcePresence(io);
        return ack?.({ ok: true, campaignId: null });
      }

      const campaign = await store.get(CAMPAIGNS, campaignId);
      // Through roleIn, not the members map directly: this is the one gate that
      // decides which broadcasts a connection receives, and reading membership
      // raw here would leave the admin able to open any table over HTTP while
      // silently receiving none of its live updates.
      const role = roleIn(campaign, socket.data.actor);
      if (!role) return ack?.({ ok: false, error: 'You are not at this table.' });

      socket.data.campaignId = campaignId;
      socket.join(roomFor(campaignId));

      // "Last activity" on the campaign list means a DM was here. A player
      // wandering in doesn't make a table active — the person who runs it
      // showing up does. Throttled inside touchActivity so a refresh isn't a
      // disk write.
      if (role === 'dm') await touchActivity(campaignId, campaign);

      announcePresence(io);
      ack?.({ ok: true, campaignId, role });
    } catch (err) {
      ack?.({ ok: false, error: 'Could not open that campaign.' });
    }
  });
});

registerTokenDrag(io);
registerSceneSignals(io);

// Health / status endpoint — also tells the client who it is.
app.get('/api/status', (req, res) => {
  res.json({ ok: true, writeGate: gateEnabled, actor: req.actor, dataDir: store.DATA_DIR });
});

// --- global scope: people and the campaigns they belong to ---
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', usersRouter);
app.use('/api/campaigns', campaignsRouter);

/**
 * --- campaign scope ---
 *
 * Everything below lives inside one campaign. attachCampaign runs first and
 * answers 404 unless the caller is a member, so no handler further down has to
 * remember to check: by the time one runs, the campaign and the caller's role
 * in it are already settled.
 */
app.use('/api/campaigns/:campaignId/sheets', attachCampaign, sheetsRouter);
app.use('/api/campaigns/:campaignId/scenes', attachCampaign, scenesRouter);
app.use('/api/campaigns/:campaignId/chat', attachCampaign, chatRouter);
app.use('/api/campaigns/:campaignId/notes', attachCampaign, notesRouter);
app.use('/api/campaigns/:campaignId/music', attachCampaign, musicRouter);

// Uploads and the built-in map list are campaign-independent: they're files on
// disk, not table data, and a map image is the same image whoever looks at it.
app.use('/api/uploads', uploadsRouter);
app.use('/api/maps', mapsRouter);
app.use('/api/tokens', tokensRouter);

// Uploaded maps are public to anyone who can reach the server — they're just
// images, and players need to see the map they're standing on.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));

// Built-in maps: drop a file into public/maps and it's immediately selectable.
app.use('/maps', express.static(MAPS_DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));

// The token library, same arrangement. Cached hard: these are content-addressed
// by name in a folder nobody edits in place, so a browser that has one has the
// one it wants — and a picker showing hundreds of them at once should ask for
// each exactly once.
app.use(
  '/tokens',
  express.static(TOKENS_DIR, { maxAge: '7d', index: false, dotfiles: 'deny' })
);

// An unmatched /api path is a client bug, not a page — answer in JSON rather
// than falling through to the SPA and handing back HTML.
app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

/**
 * Serve the built client, if there is one.
 *
 * In development Vite hosts the UI on :5173 and proxies here. In production
 * there is no Vite: this process serves both the API and the app from one
 * origin, so the tunnel only has to point at one port.
 *
 * Run `npm run build` first — without it the server still runs as an API and
 * says so at startup, rather than 404ing mysteriously.
 */
const CLIENT_DIST = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.join(__dirname, '..', 'client', 'dist');
const hasClientBuild = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));

if (hasClientBuild) {
  // Vite fingerprints asset filenames, so they can be cached hard and forever.
  app.use(
    '/assets',
    express.static(path.join(CLIENT_DIST, 'assets'), { maxAge: '1y', immutable: true })
  );
  // Everything else (favicon and friends) is unfingerprinted — no caching, or a
  // browser keeps running the previous build after you deploy a new one.
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: 0 }));

  // SPA fallback: any other GET is a client-side route, so hand back the shell.
  app.get('*', (req, res) => {
    // A missing map is a missing file, not a route — don't answer with the app.
    if (req.path.startsWith('/uploads/') || req.path.startsWith('/maps/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// Central error handler. Routes throw errors carrying a `status` for expected
// failures (403/404); anything else is a bug and becomes a generic 500.
app.use((err, req, res, next) => {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Fail closed on the open gate.
 *
 * With no ADMIN_PASSWORD every visitor resolves to the admin (see auth.js) —
 * harmless on your own machine, catastrophic on a hostname a stranger can find.
 * So the password is required unless someone explicitly asks for the open door,
 * which `npm run dev` does by passing --open-gate.
 *
 * A CLI flag rather than an env var because `FOO=1 npm run dev` isn't portable
 * to a Windows shell, and this has to be the *easy* path or it'll be worked
 * around. Defaulting to closed matters more than defaulting to convenient: the
 * mistake this prevents is silent, and you'd discover it when a stranger moves
 * your tokens.
 */
if (!gateEnabled && !process.argv.includes('--open-gate')) {
  console.error(`
Refusing to start: ADMIN_PASSWORD is not set.

Without it, everyone who reaches this server is treated as the admin —
including anyone who finds your tunnel's hostname. Set one:

  PowerShell   $env:ADMIN_PASSWORD='your-secret'; npm start
  bash         ADMIN_PASSWORD=your-secret npm start

Working locally and don't want a password? Use \`npm run dev\`.
`);
  process.exit(1);
}

/**
 * Shout about the one misconfiguration that fails silently.
 *
 * HOST defaults to localhost so a tunnel is the only way in. On a hosting
 * platform that default is wrong and produces no error at all: the app starts
 * happily, the router can't reach it, the health check times out, and the logs
 * say nothing. Better to name it here than to leave you reading a green
 * "deploy succeeded" next to a service nobody can open.
 */
const PLATFORM = ['RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'DYNO', 'K_SERVICE'].find(
  (key) => process.env[key]
);
if ((PLATFORM || process.env.PORT) && /^(127\.|::1|localhost)/.test(HOST)) {
  console.warn(`
  ================================================================
  WARNING: bound to ${HOST}, but this looks like a hosted
  environment${PLATFORM ? ` (${PLATFORM} is set)` : ''}.

  Nothing outside this container can reach the app, and the health
  check will fail without a useful error. Set HOST=0.0.0.0.
  ================================================================
`);
}

/**
 * Give the port back when told to stop.
 *
 * `npm run dev` runs this under `node --watch`, which restarts by killing this
 * process and launching another straight away. Socket.IO connections are
 * long-lived, and a websocket still attached keeps the listening socket — and
 * `server.close()` — waiting, so the replacement can land on a port this
 * process hasn't let go of yet. Hang up deliberately instead of leaving it to
 * chance, and don't wait forever for a client that won't take the hint.
 */
const openSockets = new Set();
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});

let stopping = false;
function shutdown() {
  if (stopping) return; // a second Ctrl-C is impatience, not a new instruction
  stopping = true;
  server.close(() => process.exit(0));
  io.close();
  for (const socket of openSockets) socket.destroy();
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);

/**
 * A busy port is usually busy for a moment, not for good — the watch restart
 * above races the old process's last breath. So retry for a couple of seconds
 * before giving up, and when it really is taken, say so in a sentence. Left
 * alone this arrives as an unhandled 'error' event: a stack trace through
 * node:net that never names the actual problem.
 */
// Enough to ride out a handover, short enough that the far more common case —
// a copy of this server genuinely already running — reaches the message below
// while you're still looking at the terminal.
const BIND_ATTEMPTS = 6;
const BIND_WAIT_MS = 250;
let bindAttempts = 0;

// `announce` is registered once, not passed to each listen() — a listen
// callback is just a one-off 'listening' listener, and retrying with one would
// stack up a fresh copy per attempt (Node starts warning at ten).
server.on('listening', announce);
const bind = () => server.listen(PORT, HOST);

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  if (++bindAttempts < BIND_ATTEMPTS) {
    setTimeout(bind, BIND_WAIT_MS);
    return;
  }
  console.error(`
Port ${PORT} is still in use after ${((BIND_ATTEMPTS * BIND_WAIT_MS) / 1000).toFixed(1)}s.
Another copy of this server is already running — find it and stop it:

  PowerShell   Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  bash         lsof -ti tcp:${PORT} | xargs kill

Or run this one somewhere else with PORT=3002 npm run dev.
`);
  process.exit(1);
});

// Bring a JSON data folder into the database before serving a single request,
// so nothing ever reads the half-imported state.
importJson()
  .then((result) => {
    if (result) {
      console.log(
        `imported ${result.records} record(s) from ${result.files} JSON file(s) into SQLite` +
          (result.foldedIntoCampaign ? ', folding the pre-campaign data into "Imported Campaign"' : '')
      );
    }
    bind();

    // Housekeeping, not a control — an expired token is refused on use either
    // way. Once at startup and daily after that, so a long-lived server stops
    // accumulating every session it has ever issued. unref() so it can never be
    // the reason the process won't exit.
    const sweep = () =>
      sweepExpiredSessions()
        .then((n) => n && console.log(`swept ${n} expired session(s)`))
        .catch((err) => console.error('session sweep failed:', err.message));
    sweep();
    setInterval(sweep, 24 * 60 * 60_000).unref();

    // A one-off, kept because it has to run against whatever database is in
    // front of it rather than only against the one that was here when invite
    // links went away — an import, a restored backup, or a copy from another
    // machine can all bring keys back. Idempotent, and silent when there's
    // nothing to do.
    dropInviteKeys()
      .then((n) => n && console.log(`removed ${n} dead invite key(s) from stored accounts`))
      .catch((err) => console.error('invite key cleanup failed:', err.message));
  })
  .catch((err) => {
    console.error('Import failed — refusing to start rather than serving half-moved data:');
    console.error(err);
    process.exit(1);
  });

function announce() {
  console.log(`rpg-manager server on http://localhost:${PORT}`);
  console.log(`  database: ${store.DB_FILE}`);
  console.log(`  write gate: ${gateEnabled ? 'ON (admin password required)' : 'OFF (dev mode)'}`);
  console.log(
    HOST === '127.0.0.1'
      ? '  bound to: localhost only (a tunnel still works; set HOST=0.0.0.0 for LAN)'
      : `  bound to: ${HOST} — reachable from other machines on this network`
  );
  console.log(
    TRUST_PROXY
      ? `  trust proxy: ${TRUST_PROXY} — client addresses read from X-Forwarded-For`
      : '  trust proxy: off (set TRUST_PROXY=1 behind Render or a tunnel, or rate limits see one address)'
  );
  console.log(
    signupIsOpen
      ? '  signup: OPEN — anyone who reaches this server can register (set SIGNUP_CODE to close it)'
      : '  signup: requires SIGNUP_CODE'
  );
  // Worth saying out loud: with no mailer, the links that confirm a password or
  // an address change are written to a file instead of posted, and whoever is
  // reading this banner is the only person who can fetch them. The line names
  // whatever is still missing, so half-finished setup says which half.
  console.log(`  mail: ${mailStatus}`);
  console.log(
    hasClientBuild
      ? `  app: serving client/dist — open http://localhost:${PORT}`
      : '  app: API only (no client build — run `npm run build` to serve the UI)'
  );
}
