'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const store = require('./store');
const { gateEnabled, signupIsOpen, attachActor, resolveActor } = require('./auth');
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
const { registerTokenDrag, roomFor } = require('./tokenDrag');
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

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(attachActor); // every request knows who it is

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io); // routes reach io via req.app.get('io')

// Sockets authenticate once at handshake; the resolved actor rides along on the
// connection. A key revoked mid-session takes effect on their next reconnect.
io.use(async (socket, next) => {
  try {
    const { gmPassword, adminPassword, playerKey, userKey, session } = socket.handshake.auth || {};
    socket.data.actor = await resolveActor({
      session,
      adminPassword: adminPassword || gmPassword,
      userKey: userKey || playerKey,
    });
    next();
  } catch (err) {
    next(err);
  }
});

io.on('connection', (socket) => {
  socket.emit('hello', { message: 'connected to rpg-manager', actor: socket.data.actor });

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

      if (!isCampaignId(campaignId)) return ack?.({ ok: true, campaignId: null });

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

// Uploaded maps are public to anyone who can reach the server — they're just
// images, and players need to see the map they're standing on.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));

// Built-in maps: drop a file into public/maps and it's immediately selectable.
app.use('/maps', express.static(MAPS_DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));

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
    server.listen(PORT, HOST, () => {
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
      console.log(
        hasClientBuild
          ? `  app: serving client/dist — open http://localhost:${PORT}`
          : '  app: API only (no client build — run `npm run build` to serve the UI)'
      );
    });
  })
  .catch((err) => {
    console.error('Import failed — refusing to start rather than serving half-moved data:');
    console.error(err);
    process.exit(1);
  });
