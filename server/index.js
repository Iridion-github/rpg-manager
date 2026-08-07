'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const store = require('./store');
const { gateEnabled, attachActor, resolveActor } = require('./auth');
const sheetsRouter = require('./routes/sheets');
const playersRouter = require('./routes/players');
const scenesRouter = require('./routes/scenes');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { registerTokenDrag } = require('./tokenDrag');

const PORT = Number(process.env.PORT) || 3001;

const app = express();
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
    const { gmPassword, playerKey } = socket.handshake.auth || {};
    socket.data.actor = await resolveActor({ gmPassword, playerKey });
    next();
  } catch (err) {
    next(err);
  }
});

io.on('connection', (socket) => {
  socket.emit('hello', { message: 'connected to rpg-manager', actor: socket.data.actor });
});

registerTokenDrag(io);

// Health / status endpoint — also tells the client who it is.
app.get('/api/status', (req, res) => {
  res.json({ ok: true, writeGate: gateEnabled, actor: req.actor, dataDir: store.DATA_DIR });
});

app.use('/api/sheets', sheetsRouter);
app.use('/api/players', playersRouter);
app.use('/api/scenes', scenesRouter);
app.use('/api/uploads', uploadsRouter);

// Uploaded maps are public to anyone who can reach the server — they're just
// images, and players need to see the map they're standing on.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));

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
    if (req.path.startsWith('/uploads/')) return res.status(404).json({ error: 'Not found' });
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

server.listen(PORT, () => {
  console.log(`rpg-manager server on http://localhost:${PORT}`);
  console.log(`  data dir: ${store.DATA_DIR}`);
  console.log(`  write gate: ${gateEnabled ? 'ON (GM password required)' : 'OFF (dev mode)'}`);
  console.log(
    hasClientBuild
      ? `  app: serving client/dist — open http://localhost:${PORT}`
      : '  app: API only (no client build — run `npm run build` to serve the UI)'
  );
});
