'use strict';

/**
 * One place to emit live updates.
 *
 * Every broadcast carries `origin`, the writer's client id (see the client's
 * api.js). The writer already applied the change optimistically, so it uses
 * `origin` to skip its own echo rather than clobbering what it has typed since.
 */

function broadcast(req, event, payload) {
  const io = req.app.get('io');
  if (io) io.emit(event, { ...payload, origin: req.get('x-client-id') || null });
}

module.exports = { broadcast };
