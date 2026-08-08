// Thin API client.
//
// Two credentials can be in play:
//   GM password — typed by you, kept in localStorage, sent as x-gm-password.
//   Player key   — arrives in an invite link (?key=…), sent as x-player-key.
// The server turns whichever it sees into a role; the client never decides its
// own permissions, it only renders what the server says it may do.

const GM_KEY = 'rpg-manager:gm-password';
const PLAYER_KEY = 'rpg-manager:player-key';
const CLIENT_KEY = 'rpg-manager:client-id';

// Per-tab identity. Sent on every write so the server can tag its broadcast with
// the originator; we then ignore the echo of our own change (we already applied
// it optimistically, and re-applying it would clobber whatever we've typed
// since). sessionStorage — not localStorage — so two tabs count as two clients.
export const clientId = (() => {
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
})();

export function getGmPassword() {
  return localStorage.getItem(GM_KEY) || '';
}

export function setGmPassword(value) {
  if (value) localStorage.setItem(GM_KEY, value);
  else localStorage.removeItem(GM_KEY);
}

export function getPlayerKey() {
  return localStorage.getItem(PLAYER_KEY) || '';
}

export function setPlayerKey(value) {
  if (value) localStorage.setItem(PLAYER_KEY, value);
  else localStorage.removeItem(PLAYER_KEY);
}

/**
 * Claim an invite link. The key is moved out of the URL and into storage so it
 * doesn't linger in the address bar, get bookmarked, or leak through a shared
 * screenshot. Returns true if a new key was claimed.
 *
 * Called at module scope below — see the note there for why the timing matters.
 */
export function claimKeyFromUrl() {
  const url = new URL(window.location.href);
  const key = url.searchParams.get('key');
  if (!key) return false;
  setPlayerKey(key);
  url.searchParams.delete('key');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  return true;
}

// Claim the invite key here, at import time, rather than from a component.
// socket.js imports this module and reads the key while *its* module body runs,
// which happens before any component body does. Claiming later would leave the
// first socket of an invited player's session authenticated as a spectator,
// so their tokens wouldn't move until they reloaded the page.
claimKeyFromUrl();

export function authHeaders() {
  const headers = { 'x-client-id': clientId };
  const pw = getGmPassword();
  const playerKey = getPlayerKey();
  if (pw) headers['x-gm-password'] = pw;
  if (playerKey) headers['x-player-key'] = playerKey;
  return headers;
}

async function json(res) {
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status; // callers sometimes handle a status differently
    throw err;
  }
  return res.json();
}

const send = (method) => (url, data) =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  }).then(json);

const post = send('POST');
const put = send('PUT');
const get = (url) => fetch(url, { headers: authHeaders() }).then(json);
const del = (url) => fetch(url, { method: 'DELETE', headers: authHeaders() }).then(json);

export const api = {
  status: () => get('/api/status'),
  whoami: () => get('/api/players/me'),

  listSheets: () => get('/api/sheets'),
  createSheet: (data) => post('/api/sheets', data),
  updateSheet: (id, data) => put(`/api/sheets/${id}`, data),
  deleteSheet: (id) => del(`/api/sheets/${id}`),

  listPlayers: () => get('/api/players'),
  listPlayerKeys: () => get('/api/players/keys'),
  createPlayer: (data) => post('/api/players', data),
  updatePlayer: (id, data) => put(`/api/players/${id}`, data),
  rotatePlayerKey: (id) => post(`/api/players/${id}/rotate-key`, {}),
  deletePlayer: (id) => del(`/api/players/${id}`),

  listChat: () => get('/api/chat'),
  sendChat: (text) => post('/api/chat', { text }),
  rollDice: ({ count, sides, modifier, advantage, label }) =>
    post('/api/chat/roll', { count, sides, modifier, advantage, label }),

  listMaps: () => get('/api/maps'),

  listScenes: () => get('/api/scenes'),
  createScene: (data) => post('/api/scenes', data),
  updateScene: (id, data) => put(`/api/scenes/${id}`, data),
  deleteScene: (id) => del(`/api/scenes/${id}`),

  addToken: (sceneId, data) => post(`/api/scenes/${sceneId}/tokens`, data),
  updateToken: (sceneId, tokenId, data) => put(`/api/scenes/${sceneId}/tokens/${tokenId}`, data),
  moveToken: (sceneId, tokenId, x, y) =>
    put(`/api/scenes/${sceneId}/tokens/${tokenId}/position`, { x, y }),
  deleteToken: (sceneId, tokenId) => del(`/api/scenes/${sceneId}/tokens/${tokenId}`),

  uploadImage: (file) => {
    const form = new FormData();
    form.append('image', file);
    // No Content-Type header: the browser must set the multipart boundary.
    return fetch('/api/uploads', { method: 'POST', headers: authHeaders(), body: form }).then(json);
  },
};
