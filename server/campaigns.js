'use strict';

/**
 * Campaigns - the container everything else lives inside.
 *
 * A campaign is a key prefix, not a column:
 *
 *   campaigns                    the list of campaigns
 *   campaigns/<id>/sheets        this campaign's characters
 *   campaigns/<id>/scenes        …its maps and tokens
 *   campaigns/<id>/chat          …its chat log
 *   campaigns/<id>/notes         …its notes and handouts
 *
 * The campaign is part of the collection name, and the collection name is the
 * leading half of the primary key. The obvious alternative - one `sheets` table
 * with a campaignId column - makes every forgotten WHERE clause a silent leak
 * of one table's secrets into another. Here there is no row you can reach
 * without naming its campaign first. Deleting a campaign is deleting a key
 * prefix.
 *
 * The id is still checked against a strict uuid pattern before being built into
 * a collection name - see scoped(). It no longer reaches a filesystem, but a
 * caller that could name any collection could name `users`.
 */

const store = require('./store');
// The sight rules live apart from here, like the ruler's arithmetic does: they
// are geometry, and geometry is the part worth being able to check on its own.
const { fogOn, tokensSeenThroughFog } = require('./fog');

const CAMPAIGNS = 'campaigns';

// The store mints uuids, so anything that isn't one was not minted by us.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isCampaignId = (id) => typeof id === 'string' && UUID_RE.test(id);

/**
 * The name of a collection *inside* a campaign.
 *
 * Every campaign-scoped read and write goes through here, which makes this the
 * single choke point where an id becomes part of a key - and therefore the only
 * place that has to get the validation right.
 */
function scoped(campaignId, collection) {
  if (!isCampaignId(campaignId)) {
    const err = new Error('Bad campaign id');
    err.status = 400;
    throw err;
  }
  return `${CAMPAIGNS}/${campaignId}/${collection}`;
}

// Wipe everything belonging to a campaign. Called after the campaign record is
// gone, so a failure here leaves orphaned rows rather than an unreachable
// campaign. The collection name is the key prefix, so this is one statement.
async function removeCampaignData(campaignId) {
  if (!isCampaignId(campaignId)) return 0;
  return store.removeTree(`${CAMPAIGNS}/${campaignId}`);
}

/**
 * What this person is *at this table*.
 *
 * Returns 'dm', 'player', or null for someone who isn't a member - except for
 * the admin, who is 'dm' everywhere without being a member anywhere.
 *
 * This used to be the opposite, on the reasoning that an admin who was never
 * invited to your campaign is not its DM. That holds on a server whose admin is
 * also somebody's player. It doesn't hold here: this admin is an administrative
 * account that never sits at a table, so refusing it meant the only person who
 * can fix a table had to be invited to it first - by the DM whose table is
 * broken. The confidentiality it bought was already nominal, since
 * /api/admin/backup hands the same password holder the entire database.
 *
 * Admin outranks membership rather than falling back to it, so the answer
 * doesn't depend on whether someone once added this account to their members
 * map. Membership stays the truth about who *plays*: this function is asked what
 * you may do, and nothing writes the admin into a members map.
 */
function roleIn(campaign, actor) {
  if (!campaign || !actor || !actor.userId) return null;
  if (actor.globalRole === 'admin') return 'dm';
  const role = campaign.members?.[actor.userId];
  return role === 'dm' || role === 'player' ? role : null;
}

const isMember = (campaign, actor) => roleIn(campaign, actor) !== null;
const isDm = (campaign, actor) => roleIn(campaign, actor) === 'dm';

/**
 * The ownership rule for tokens, in one place: the DM may move any token, a
 * player may move only a token assigned to them, and nobody else may move
 * anything. Both the HTTP route and the socket drag handler call this - if they
 * each had their own copy, one of them would eventually be wrong.
 */
function canMoveToken(actor, role, token) {
  if (!actor || !token || !role) return false;
  if (role === 'dm') return true;
  return Boolean(token.ownerId) && token.ownerId === actor.userId;
}

/**
 * Whether a token is on the board as far as this person is concerned.
 *
 * `visible` is the DM's switch for the ambush in the trees and the second half
 * of the room: false means the token exists, moves and rolls initiative, and
 * only the DM can see any of it. A token written before the switch existed has
 * no such field, and absent reads as visible - which is the state every token
 * was already in.
 *
 * **Enforced by not sending it.** A hidden token is filtered out of every scene
 * a player receives (see sceneAsSeenBy), out of the campaign's token list, and
 * out of the drag ghosts other people see. Hiding it in the browser instead
 * would put the monster in the page for anyone who opened the dev tools, which
 * is the one thing this switch exists to prevent.
 */
function canSeeToken(role, token) {
  if (role === 'dm') return true;
  return token?.visible !== false;
}

/**
 * Is the person who stuck this pin in the map still at this table?
 *
 * Asked for the same reason notes.js asks it of an author: somebody can be
 * removed from a campaign, and a campaign can be carried to another server as a
 * file, where every id in it names nobody. Either leaves a pin on a map that no
 * living person may edit or take down. See canEditPin, which is where that
 * falls to the DM.
 */
const pinAuthorIsHere = (campaign, pin) =>
  Boolean(pin?.ownerId) && Boolean(campaign?.members?.[pin.ownerId]);

/**
 * Who may change a pin, or take it off the map.
 *
 * Its author, and nobody else - not even the DM, however widely it is shared.
 * Sharing a pin hands over something to read; it is not a transfer of the thing
 * itself, which is the same promise a note makes.
 *
 * The one exception is a pin whose author is no longer here, which would
 * otherwise stand on the map forever. Those fall to the DM's chair, exactly as
 * an orphaned note does, and it costs the same thing there: the private pins of
 * somebody who leaves become the DM's. That is the honest trade for not leaving
 * litter on a board nobody can clear.
 */
function canEditPin(actor, pin, campaign, role) {
  if (!actor || !pin) return false;
  if (pin.ownerId && pin.ownerId === actor.userId) return true;
  return role === 'dm' && !pinAuthorIsHere(campaign, pin);
}

/**
 * Whether a pin on a map is one this person may read.
 *
 * The three answers a pin can give are a note's, and they mean the same things:
 * private is its author's alone, shared is theirs plus the people named on it,
 * public is the whole table's. What is *not* the same is the DM, who has no
 * override here. A pin is somewhere to write down what you have worked out, and
 * a private one that the person running the table can read is not private in
 * the sense anybody means when they choose the word.
 *
 * Asked about the actor rather than about the role for exactly that reason:
 * role says which chair you are in, and a pin does not care about the chair.
 *
 * **Enforced by not sending it**, exactly as a hidden token is: a pin filtered
 * out of the scene is a pin whose text was never in anybody else's browser.
 */
function canSeePin(actor, pin, campaign, role) {
  if (!actor || !pin) return false;
  // Whoever may change it may obviously read it - and this is also what lets an
  // author see their own private pin, which nothing below would.
  if (canEditPin(actor, pin, campaign, role)) return true;
  if (pin.visibility === 'public') return true;
  if (pin.visibility === 'shared') {
    return Array.isArray(pin.sharedWith) && pin.sharedWith.includes(actor.userId);
  }
  return false;
}

/**
 * A scene as this person may see it.
 *
 * The whole scene goes out to every member - that is what the board is drawn
 * from - so this is the one place a token or a pin can be taken back out of it.
 * Anything that isn't a scene carrying them passes through untouched: a delete
 * announcement carries an id and nothing else.
 *
 * A role *and* an actor, because the two layers answer to different things. A
 * hidden token is hidden from a chair, and the DM sees every one of them. A pin
 * is hidden from a person, and the DM is a person like anybody else - which is
 * why this can no longer hand the whole scene straight back to them.
 */
function sceneAsSeenBy(role, scene, actor, campaign) {
  if (!scene || typeof scene !== 'object') return scene;
  let seen = scene;
  if (role !== 'dm' && Array.isArray(scene.tokens)) {
    // Two filters, in this order and for two different reasons. The first is
    // the DM's own switch, which is about a token; the second is the fog, which
    // is about where you are standing. A creature the DM has hidden stays
    // hidden however brightly it is lit.
    let tokens = scene.tokens.filter((token) => canSeeToken(role, token));
    if (fogOn(scene)) {
      tokens = tokensSeenThroughFog({ ...scene, tokens }, actor);
    }
    seen = { ...seen, tokens };
  }
  if (Array.isArray(scene.pins)) {
    seen = { ...seen, pins: scene.pins.filter((pin) => canSeePin(actor, pin, campaign, role)) };
  }
  return seen;
}

/**
 * Who may read and write a character sheet.
 *
 * A sheet carries `access`, a map of userId → 'view' | 'edit'. A player who
 * isn't in it can't see the sheet at all. One map rather than separate viewer
 * and editor lists: those two can disagree - an editor missing from the viewers
 * - and then there are two answers about who can read the sheet.
 *
 * The DM is never in the map. They can always do everything at their own table,
 * which is also why only they can change the map: see routes/sheets.js.
 */
const SHEET_LEVELS = new Set(['view', 'edit']);

function sheetLevel(actor, role, sheet) {
  if (!actor || !sheet || !role) return null;
  if (role === 'dm') return 'edit';
  const level = sheet.access?.[actor.userId];
  return SHEET_LEVELS.has(level) ? level : null;
}

const canViewSheet = (actor, role, sheet) => sheetLevel(actor, role, sheet) !== null;
const canEditSheet = (actor, role, sheet) => sheetLevel(actor, role, sheet) === 'edit';

/**
 * Normalise an access map. Ids aren't checked against the campaign's members: a
 * user removed from the table can no longer resolve a role here at all, so a
 * leftover entry is dead weight rather than a way in.
 */
function sanitizeSheetAccess(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [id, level] of Object.entries(source).slice(0, 50)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    if (SHEET_LEVELS.has(level)) out[id] = level;
  }
  return out;
}

function sanitizeMembers(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [id, role] of Object.entries(source).slice(0, 100)) {
    if (!UUID_RE.test(id)) continue;
    if (role === 'dm' || role === 'player') out[id] = role;
  }
  return out;
}

function sanitizeCampaign(body = {}) {
  return {
    name: String(body.name ?? '').trim().slice(0, 120) || 'New Campaign',
    // Shown as the subtitle in the campaign list, so it's capped at a length
    // that belongs on one line rather than at essay length.
    description: String(body.description ?? '').trim().slice(0, 200),
  };
}

/**
 * What everyone may know about a campaign, member or not.
 *
 * The list of campaigns is public to signed-in users - you can see that a table
 * exists, what it's called, how many people are at it, and whether it's alive.
 * What stays private is *who*: the members map never leaves the server through
 * here, only its size. "Four people play this" is a fact about the campaign;
 * "these four people play this" is a fact about them.
 *
 * Contents - sheets, scenes, chat, notes - remain member-only, and that's
 * enforced elsewhere (attachCampaign). This is a directory, not a door.
 */
function publicSummary(campaign, actor) {
  const { members, ...rest } = campaign;
  return {
    ...rest,
    memberCount: Object.keys(members || {}).length,
    lastActivityAt: campaign.lastActivityAt || null,
    myRole: roleIn(campaign, actor),
  };
}

/**
 * Stamp "a DM was here".
 *
 * Written when a DM opens the campaign, which is the signal that a table is
 * still being run rather than merely still existing. Throttled: a DM refreshing
 * their browser shouldn't mean a disk write per reload, and nobody reading a
 * list of campaigns cares about the difference between "2 minutes ago" and
 * "just now".
 */
const ACTIVITY_THROTTLE_MS = 60_000;

async function touchActivity(campaignId, campaign) {
  const last = Date.parse(campaign?.lastActivityAt || '') || 0;
  if (Date.now() - last < ACTIVITY_THROTTLE_MS) return campaign;
  return store.mutate(CAMPAIGNS, campaignId, (current) => ({
    ...current,
    lastActivityAt: new Date().toISOString(),
  }));
}

/**
 * Load the campaign named in the URL and work out what the caller is in it.
 *
 * Mounted in front of every campaign-scoped router, so a route can never
 * accidentally serve data from a campaign the caller isn't in: by the time any
 * handler runs, req.campaign and req.campaignRole are already decided.
 *
 * A campaign you aren't a member of answers 404, not 403 - the existence of
 * someone else's table is not yours to learn.
 */
function attachCampaign(req, res, next) {
  const { campaignId } = req.params;
  if (!isCampaignId(campaignId)) {
    return res.status(404).json({ error: 'No such campaign' });
  }
  store
    .get(CAMPAIGNS, campaignId)
    .then((campaign) => {
      if (!campaign) return res.status(404).json({ error: 'No such campaign' });
      const role = roleIn(campaign, req.actor);
      if (!role) return res.status(404).json({ error: 'No such campaign' });
      req.campaign = campaign;
      req.campaignRole = role;
      req.campaignId = campaignId;
      next();
    })
    .catch(next);
}

// For the handful of writes only a DM may make.
function requireDm(req, res, next) {
  if (req.campaignRole === 'dm') return next();
  return res.status(403).json({ error: 'Only this campaign’s DM can do that.' });
}

module.exports = {
  CAMPAIGNS,
  isCampaignId,
  scoped,
  removeCampaignData,
  roleIn,
  isMember,
  isDm,
  canMoveToken,
  canSeeToken,
  canSeePin,
  canEditPin,
  sceneAsSeenBy,
  canViewSheet,
  canEditSheet,
  sanitizeSheetAccess,
  sanitizeMembers,
  sanitizeCampaign,
  publicSummary,
  touchActivity,
  attachCampaign,
  requireDm,
};
