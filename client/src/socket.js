import { io } from 'socket.io-client';
import { getGmPassword, getSession } from './api.js';

// Connects to the server through Vite's dev proxy (same origin).
// When the server is your PC and it's offline, this simply fails to connect —
// which is exactly how the app knows to fall back to read-only mode.
//
// Credentials ride in the handshake, so the server can resolve this socket's
// identity once and remember it for the connection's lifetime.
export const socket = io({
  autoConnect: true,
  auth: { session: getSession(), adminPassword: getGmPassword() },
});

/**
 * Re-handshake after signing in or out. Identity is decided at connection time,
 * so a socket opened as "anon" stays anon until it reconnects — without this,
 * signing in wouldn't let you drag tokens until a manual refresh.
 */
export function reauthenticate() {
  socket.auth = { session: getSession(), adminPassword: getGmPassword() };
  socket.disconnect().connect();
}

/**
 * Tell the server which campaign this connection is looking at.
 *
 * Live updates are scoped to a campaign and a socket has no URL to read that
 * from, so it has to say — and the server verifies membership before honouring
 * it. Re-sent on every reconnect, because a new connection knows nothing about
 * what the old one had joined.
 */
let watching = null;

export function enterCampaign(campaignId) {
  watching = campaignId || null;
  socket.emit('campaign:enter', { campaignId: watching });
}

socket.on('connect', () => {
  if (watching) socket.emit('campaign:enter', { campaignId: watching });
});
