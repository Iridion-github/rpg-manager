// Thin API client.
//
// You sign in and get a session token; that is the credential. The admin
// password is the one exception - it is the server's own configuration rather
// than an account, and is sent as x-admin-password.
//
// There was a third: a key in an invite link, which signed you in by being
// opened. It is gone. A bearer credential that lives in a URL ends up in
// bookmarks, in browser history and in whatever chat it was pasted into, and it
// never expired. People arrive by registering now - with SIGNUP_CODE, if the
// server has one.
//
// The server turns what it sees into a role; the client never decides its own
// permissions, it only renders what the server says it may do.

const GM_KEY = 'rpg-manager:gm-password';
const CLIENT_KEY = 'rpg-manager:client-id';
const SESSION_KEY = 'rpg-manager:session';

// Per-tab identity. Sent on every write so the server can tag its broadcast with
// the originator; we then ignore the echo of our own change (we already applied
// it optimistically, and re-applying it would clobber whatever we've typed
// since). sessionStorage - not localStorage - so two tabs count as two clients.
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
 * The session token from logging in - the normal credential now.
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

/**
 * Forget a key left behind by the invite-link era.
 *
 * The links stopped working when the server stopped reading them, but the key
 * itself would sit in this browser's storage forever - a dead secret nobody can
 * see to delete. Run once at import, and after that there is nothing to find.
 */
(function forgetOldInviteKey() {
  try {
    localStorage.removeItem('rpg-manager:player-key');
  } catch {
    // Private mode, or a storage that refuses. Nothing to clean up, then.
  }
})();

export function authHeaders() {
  const headers = { 'x-client-id': clientId };
  const session = getSession();
  const pw = getGmPassword();
  // Both can be present and the server prefers the session. The password is the
  // admin's, and is server configuration rather than an account.
  if (session) headers['x-session'] = session;
  if (pw) headers['x-admin-password'] = pw;
  return headers;
}

/**
 * The campaign every table-scoped call belongs to.
 *
 * Held here rather than passed to each call: every one of them is inside a
 * campaign, so threading an id through dozens of call sites would only create
 * dozens of chances to forget one - and forgetting one means reading another
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
  // Your own account. The name changes on the spot; the password and the email
  // either take the signup code or wait for a link to be opened - the server
  // decides which, and says so in its answer.
  updateAccount: (name) => put('/api/auth/account', { name }),
  // Your profile picture, saved the moment one is chosen. An empty string takes
  // it off again - the picture is a label, not something to be confirmed.
  setAvatar: (avatarUrl) => put('/api/auth/avatar', { avatarUrl }),
  changePassword: (current, password, code) =>
    post('/api/auth/password', { current, password, code }),
  changeEmail: (email, code) => post('/api/auth/email', { email, code }),
  confirmChange: (token) => post('/api/auth/confirm', { token }),
  // Getting back in. `who` is a username or an address - somebody who has
  // forgotten their password may not remember which they signed up with. The
  // answer is the same either way and says nothing about whether the account
  // exists, so there is nothing here for the caller to branch on.
  forgotPassword: (who) => post('/api/auth/forgot', { who }),
  resetPassword: (token, password) => post('/api/auth/reset', { token, password }),

  // --- global: people, and the campaigns they belong to ---
  listUsers: () => get('/api/users'),
  updateUser: (id, data) => put(`/api/users/${id}`, data),
  deleteUser: (id) => del(`/api/users/${id}`),
  // Admin only, and it answers with the link rather than posting it: this is
  // for the person the server has no address for, so there is nowhere to post.
  resetUserPassword: (id) => post(`/api/users/${id}/reset`, {}),

  // Only ever the campaigns you're a member of - someone else's table doesn't
  // appear at all, admin included.
  listCampaigns: () => get('/api/campaigns'),
  createCampaign: (data) => post('/api/campaigns', data),
  updateCampaign: (id, data) => put(`/api/campaigns/${id}`, data),
  deleteCampaign: (id) => del(`/api/campaigns/${id}`),
  listMembers: (id) => get(`/api/campaigns/${id}/members`),

  // A campaign as a file, and back again. The export is a download rather than
  // a value, so it fetches and hands the browser a blob - a plain <a href>
  // couldn't carry the session header.
  exportCampaign: async (id, name) => {
    const res = await fetch(`/api/campaigns/${id}/export`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] ||
      `${name || 'campaign'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  },
  importCampaign: (payload) => post('/api/campaigns/import', payload),
  setMembers: (id, members) => put(`/api/campaigns/${id}/members`, { members }),

  // --- inside the current campaign ---
  listSheets: () => get(table('/sheets')),
  createSheet: (data) => post(table('/sheets'), data),
  updateSheet: (id, data) => put(table(`/sheets/${id}`), data),
  deleteSheet: (id) => del(table(`/sheets/${id}`)),
  /**
   * Who may read and change one character - the DM's call, and a route of its
   * own rather than a field on updateSheet.
   *
   * That separation is the point: a player editing their own sheet sends the
   * whole sheet back, and if access travelled in that body they could promote
   * themselves in the act of filling in their hit points. The server refuses to
   * read access from an edit at all (routes/sheets.js), so the only way to
   * change it is through here, and only the DM may.
   *
   * `access` is the whole map, userId → 'view' | 'edit'. A player left out of it
   * has no access, which is how access is taken away.
   */
  setSheetAccess: (id, access) => put(table(`/sheets/${id}/access`), { access }),

  listChat: () => get(table('/chat')),
  sendChat: (text) => post(table('/chat'), { text }),
  // Your own line, or anybody's if you're the DM. The server decides which -
  // the menu that offers this only hides what it already knows would be
  // refused.
  deleteChat: (id) => del(table(`/chat/${id}`)),
  // A block read off a character sheet, with its own heading. Longer than a
  // typed line is allowed to be, and drawn as a block in the log - see the
  // share route in server/routes/chat.js.
  shareToChat: ({ title, text }) => post(table('/chat/share'), { title, text }),
  // `extras` are named things riding along on this one roll - a sheet's global
  // modifiers - each some dice, some flat bonus, or both. The server rolls them
  // with it and folds them into the same total, so an extra d4 is part of the
  // attack rather than a second line in the chat.
  // `advantage` and `disadvantage` are the two ways a d20 is thrown twice. Both
  // at once is not an error and not refused: the game says they cancel, and the
  // server reads them that way.
  rollDice: ({ count, sides, modifier, advantage, disadvantage, label, secret, extras }) =>
    post(table('/chat/roll'), {
      count,
      sides,
      modifier,
      advantage,
      disadvantage,
      label,
      secret,
      extras,
    }),

  // The list comes back already filtered by role - a player is never sent an
  // unshared note, so there is nothing here for the UI to have to hide.
  listNotes: () => get(table('/notes')),
  createNote: (data) => post(table('/notes'), data),
  updateNote: (id, data) => put(table(`/notes/${id}`), data),
  deleteNote: (id) => del(table(`/notes/${id}`)),

  // Tracks plus what's playing, in one call - the tab needs both and they're
  // read together on every refresh.
  getMusic: () => get(table('/music')),
  addTrack: (url, title) => post(table('/music'), { url, title }),
  renameTrack: (id, title) => put(table(`/music/${id}`), { title }),
  playTrack: (id) => post(table(`/music/${id}/play`), {}),
  stopMusic: () => post(table('/music/stop'), {}),
  deleteTrack: (id) => del(table(`/music/${id}`)),

  listScenes: () => get(table('/scenes')),
  // One scene, read fresh. Undo asks for this before reversing anything: the
  // board it is about to change may not be the board it was recorded on.
  getScene: (id) => get(table(`/scenes/${id}`)),
  createScene: (data) => post(table('/scenes'), data),
  updateScene: (id, data) => put(table(`/scenes/${id}`), data),
  deleteScene: (id) => del(table(`/scenes/${id}`)),

  addToken: (sceneId, data) => post(table(`/scenes/${sceneId}/tokens`), data),
  updateToken: (sceneId, tokenId, data) =>
    put(table(`/scenes/${sceneId}/tokens/${tokenId}`), data),
  moveToken: (sceneId, tokenId, x, y) =>
    put(table(`/scenes/${sceneId}/tokens/${tokenId}/position`), { x, y }),
  deleteToken: (sceneId, tokenId) => del(table(`/scenes/${sceneId}/tokens/${tokenId}`)),
  // The three writes an owner may make to their own token: where it stands,
  // what it rolled, and whether it's on the table at all.
  setInitiative: (sceneId, tokenId, roll) =>
    put(table(`/scenes/${sceneId}/tokens/${tokenId}/initiative`), roll),
  benchToken: (sceneId, tokenId) => put(table(`/scenes/${sceneId}/tokens/${tokenId}/bench`), {}),
  spawnToken: (sceneId, tokenId, x, y) =>
    post(table(`/scenes/${sceneId}/tokens/from-bench`), { tokenId, x, y }),
  // This campaign's cast: every token the caller may see, whether it is
  // standing on a scene (sceneId set) or waiting off one (sceneId null).
  listCampaignTokens: () => get(table('/tokens')),
  createCampaignToken: (data) => post(table('/tokens'), data),
  updateCampaignToken: (tokenId, data) => put(table(`/tokens/${tokenId}`), data),
  deleteCampaignToken: (tokenId) => del(table(`/tokens/${tokenId}`)),
  /**
   * Couple a token to a character sheet, or pass null to set it loose.
   *
   * One call behind both screens - the Characters tab asks it "which token is
   * this character?" and the Tokens tab "which character is this token?", which
   * are the same fact written from two ends. The link is stored on the token
   * alone, so there is only ever one record to change and no way for the two
   * ends to disagree.
   *
   * A route of its own rather than a field on the token edit, for the same
   * reason a sheet's access has one: it releases whatever else held that sheet,
   * checks the caller may edit it, and copies the character's numbers across.
   */
  linkTokenSheet: (tokenId, sheetId) => put(table(`/tokens/${tokenId}/sheet`), { sheetId }),

  // The drawing layer. Anyone playing may add one; the server decides whose is
  // whose from the session, so there is no owner to pass here.
  addShape: (sceneId, data) => post(table(`/scenes/${sceneId}/shapes`), data),
  updateShape: (sceneId, shapeId, data) =>
    put(table(`/scenes/${sceneId}/shapes/${shapeId}`), data),
  deleteShape: (sceneId, shapeId) => del(table(`/scenes/${sceneId}/shapes/${shapeId}`)),
  // Everything you may take off this scene, in one go. Answers with the shapes
  // it removed, so they can be put back.
  clearShapes: (sceneId) => del(table(`/scenes/${sceneId}/shapes`)),

  setTurnMode: (sceneId, on) => put(table(`/scenes/${sceneId}/turn`), { on }),
  nextTurn: (sceneId) => put(table(`/scenes/${sceneId}/turn/next`), {}),
  giveTurn: (sceneId, tokenId) => put(table(`/scenes/${sceneId}/turn/current`), { tokenId }),

  // Campaign-independent: a map image is the same image at any table.
  listMaps: () => get('/api/maps'),

  // The built-in token artwork. Campaign-independent for the same reason the
  // maps are: a picture of a goblin is the same picture at any table.
  listTokens: () => get('/api/tokens'),

  /**
   * Put an image on the server and get back the address it landed at.
   *
   * `kind` is what the picture is for, and all the server does with it is choose
   * how big it may be: a battle map gets far more room than a face drawn an inch
   * across beside a name. Left out, it is a map - which is what every caller
   * that predates the portraits means.
   */
  uploadImage: (file, kind) => {
    const form = new FormData();
    form.append('image', file);
    const where = kind ? `/api/uploads?kind=${encodeURIComponent(kind)}` : '/api/uploads';
    // No Content-Type header: the browser must set the multipart boundary.
    return fetch(where, { method: 'POST', headers: authHeaders(), body: form }).then(json);
  },
};
