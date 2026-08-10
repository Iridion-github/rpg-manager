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
const SESSION_KEY = 'rpg-manager:session';

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

/**
 * The session token from logging in — the normal credential now.
 *
 * In localStorage rather than a cookie because the app already sends its
 * credentials as headers and the socket sends them in its handshake, so a token
 * fits both without cookie plumbing or CSRF handling.
 */
export function getSession() {
  return localStorage.getItem(SESSION_KEY) || '';
}

export function setSession(value) {
  if (value) localStorage.setItem(SESSION_KEY, value);
  else localStorage.removeItem(SESSION_KEY);
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
  const session = getSession();
  const pw = getGmPassword();
  const playerKey = getPlayerKey();
  // All three can be present; the server prefers the session. The other two are
  // the pre-login credentials, still sent so old invite links keep working.
  if (session) headers['x-session'] = session;
  if (pw) headers['x-admin-password'] = pw;
  if (playerKey) headers['x-user-key'] = playerKey;
  return headers;
}

/**
 * The campaign every table-scoped call belongs to.
 *
 * Held here rather than passed to each call: every one of them is inside a
 * campaign, so threading an id through dozens of call sites would only create
 * dozens of chances to forget one — and forgetting one means reading another
 * table's data. Set once when the campaign changes (see App.jsx), and the URLs
 * below can't be built without it.
 */
let currentCampaignId = null;

export function setCampaign(id) {
  currentCampaignId = id || null;
}

export function getCampaign() {
  return currentCampaignId;
}

function table(suffix) {
  if (!currentCampaignId) {
    // A bug, not a user error: something rendered a table view before a
    // campaign was chosen. Fail loudly here rather than fetching /undefined/.
    throw new Error('No campaign selected');
  }
  return `/api/campaigns/${currentCampaignId}${suffix}`;
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
  whoami: () => get('/api/auth/me'),

  // --- signing in ---
  authConfig: () => get('/api/auth/config'),
  register: (data) => post('/api/auth/register', data),
  login: (username, password) => post('/api/auth/login', { username, password }),
  logout: () => post('/api/auth/logout', {}),
  changePassword: (current, password) => post('/api/auth/password', { current, password }),

  // --- global: people, and the campaigns they belong to ---
  listUsers: () => get('/api/users'),
  listUserKeys: () => get('/api/users/keys'),
  createUser: (data) => post('/api/users', data),
  updateUser: (id, data) => put(`/api/users/${id}`, data),
  rotateUserKey: (id) => post(`/api/users/${id}/rotate-key`, {}),
  deleteUser: (id) => del(`/api/users/${id}`),

  // Only ever the campaigns you're a member of — someone else's table doesn't
  // appear at all, admin included.
  listCampaigns: () => get('/api/campaigns'),
  createCampaign: (data) => post('/api/campaigns', data),
  updateCampaign: (id, data) => put(`/api/campaigns/${id}`, data),
  deleteCampaign: (id) => del(`/api/campaigns/${id}`),
  listMembers: (id) => get(`/api/campaigns/${id}/members`),
  setMembers: (id, members) => put(`/api/campaigns/${id}/members`, { members }),

  // --- inside the current campaign ---
  listSheets: () => get(table('/sheets')),
  createSheet: (data) => post(table('/sheets'), data),
  updateSheet: (id, data) => put(table(`/sheets/${id}`), data),
  deleteSheet: (id) => del(table(`/sheets/${id}`)),
  // Note: the server still has PUT /sheets/:id/access, deliberately separate
  // from updateSheet — changing who may edit a sheet is a DM act and must not
  // be expressible as part of editing one. Nothing in the client calls it since
  // the per-sheet access panel was removed, so the wrapper went with it.

  listChat: () => get(table('/chat')),
  sendChat: (text) => post(table('/chat'), { text }),
  rollDice: ({ count, sides, modifier, advantage, label, secret }) =>
    post(table('/chat/roll'), { count, sides, modifier, advantage, label, secret }),

  // The list comes back already filtered by role — a player is never sent an
  // unshared note, so there is nothing here for the UI to have to hide.
  listNotes: () => get(table('/notes')),
  createNote: (data) => post(table('/notes'), data),
  updateNote: (id, data) => put(table(`/notes/${id}`), data),
  deleteNote: (id) => del(table(`/notes/${id}`)),

  // Tracks plus what's playing, in one call — the tab needs both and they're
  // read together on every refresh.
  getMusic: () => get(table('/music')),
  addTrack: (url, title) => post(table('/music'), { url, title }),
  renameTrack: (id, title) => put(table(`/music/${id}`), { title }),
  playTrack: (id) => post(table(`/music/${id}/play`), {}),
  stopMusic: () => post(table('/music/stop'), {}),
  deleteTrack: (id) => del(table(`/music/${id}`)),

  listScenes: () => get(table('/scenes')),
  createScene: (data) => post(table('/scenes'), data),
  updateScene: (id, data) => put(table(`/scenes/${id}`), data),
  deleteScene: (id) => del(table(`/scenes/${id}`)),

  addToken: (sceneId, data) => post(table(`/scenes/${sceneId}/tokens`), data),
  updateToken: (sceneId, tokenId, data) =>
    put(table(`/scenes/${sceneId}/tokens/${tokenId}`), data),
  moveToken: (sceneId, tokenId, x, y) =>
    put(table(`/scenes/${sceneId}/tokens/${tokenId}/position`), { x, y }),
  deleteToken: (sceneId, tokenId) => del(table(`/scenes/${sceneId}/tokens/${tokenId}`)),

  setTurnMode: (sceneId, on) => put(table(`/scenes/${sceneId}/turn`), { on }),
  nextTurn: (sceneId) => put(table(`/scenes/${sceneId}/turn/next`), {}),
  giveTurn: (sceneId, tokenId) => put(table(`/scenes/${sceneId}/turn/current`), { tokenId }),

  // Campaign-independent: a map image is the same image at any table.
  listMaps: () => get('/api/maps'),

  // The built-in token artwork. Campaign-independent for the same reason the
  // maps are: a picture of a goblin is the same picture at any table.
  listTokens: () => get('/api/tokens'),

  uploadImage: (file) => {
    const form = new FormData();
    form.append('image', file);
    // No Content-Type header: the browser must set the multipart boundary.
    return fetch('/api/uploads', { method: 'POST', headers: authHeaders(), body: form }).then(json);
  },
};
