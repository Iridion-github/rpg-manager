import { io } from 'socket.io-client';
import { getGmPassword, getPlayerKey } from './api.js';

// Connects to the server through Vite's dev proxy (same origin).
// When the server is your PC and it's offline, this simply fails to connect —
// which is exactly how the app knows to fall back to read-only mode.
//
// Credentials ride in the handshake, so the server can resolve this socket's
// role once and remember it for the connection's lifetime.
export const socket = io({
  autoConnect: true,
  auth: { gmPassword: getGmPassword(), playerKey: getPlayerKey() },
});

/**
 * Re-handshake after the GM password or player key changes. The role is decided
 * at connection time, so a socket opened as "anon" stays anon until it
 * reconnects — without this, saving your GM key wouldn't let you drag tokens
 * until a manual refresh.
 */
export function reauthenticate() {
  socket.auth = { gmPassword: getGmPassword(), playerKey: getPlayerKey() };
  socket.disconnect().connect();
}
