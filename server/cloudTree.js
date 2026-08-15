'use strict';

/**
 * The image cloud: a campaign's own folders full of maps.
 *
 * One tree per campaign, shared by everyone who runs that table - two DMs
 * prepping the same game are prepping it together, and a private tree each
 * would mean one of them uploading a map the other already has. Join a
 * different table and you are looking at a different tree.
 *
 * **Folders are records, not directories.** A node is a row with a parent, and
 * the pictures themselves stay flat on disk under the names imageStore.js gave
 * them. Moving a map between folders is therefore a single field changing, and
 * a URL already written into a scene cannot break because somebody tidied up.
 * It also means a folder cannot collide with the filesystem's opinions about
 * names: a folder here may be called "Session 4: the docks / part two".
 *
 * **Space is metered per person, not per table.** The quota follows the account
 * that uploaded a picture, wherever it was uploaded to, because the thing being
 * rationed is somebody's hard disk. Counted by asking, never by keeping a
 * running total: a stored number drifts the first time a delete half-fails, and
 * the rows are the only thing that cannot be wrong about what is on the disk.
 */

const crypto = require('node:crypto');
const store = require('./store');
const { scoped } = require('./campaigns');

const COLLECTION = 'cloud';

const cloudOf = (campaignId) => scoped(campaignId, COLLECTION);

/**
 * How much room one account gets, across every table they run.
 *
 * A map is a few megabytes and a campaign is a few dozen maps, so this is
 * roughly fifty full-size boards per person - generous for the game and still
 * a number a home PC does not notice. It is deliberately not per campaign:
 * whoever is running six tables is still using one disk.
 *
 * Settable, because the person who owns the machine is the one who knows how
 * much of it they are willing to spend.
 */
const QUOTA_BYTES = Math.max(
  1,
  Math.round(Number(process.env.CLOUD_QUOTA_MB) || 250) * 1024 * 1024
);

const MAX_NAME = 80;
// Enough for a campaign's worth of maps and folders several times over, and low
// enough that a runaway script cannot fill the table with a million rows.
const MAX_NODES = 2000;

const cleanName = (value, fallback = 'Untitled') =>
  String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, MAX_NAME) || fallback;

/** Every node in this campaign's tree, folders and images alike. */
const nodesIn = (campaignId) => store.list(cloudOf(campaignId));

/**
 * What one person is using, everywhere.
 *
 * Asked of the database directly rather than by walking every campaign in
 * JavaScript: the answer is a sum over one indexed column's worth of rows, and
 * the walk would have to know which campaigns exist - a list this module has no
 * business holding an opinion about.
 */
function usedBy(userId) {
  if (!userId) return 0;
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(json_extract(data, '$.bytes')), 0) AS bytes
         FROM records
        WHERE collection LIKE 'campaigns/%/cloud'
          AND json_extract(data, '$.kind') = 'image'
          AND json_extract(data, '$.uploadedBy') = ?`
    )
    .get(String(userId));
  return Number(row?.bytes) || 0;
}

/** What to tell the browser about somebody's allowance. */
const quotaFor = (userId) => ({ used: usedBy(userId), limit: QUOTA_BYTES });

/**
 * The folder a node is going into, checked.
 *
 * Null is the root and is always fine. Anything else has to be a folder in
 * *this* campaign, which is what stops a request naming a folder at another
 * table and grafting a branch across.
 */
function parentOk(nodes, parentId) {
  if (!parentId) return true;
  const parent = nodes.find((n) => n.id === parentId);
  return Boolean(parent && parent.kind === 'folder');
}

/** Everything under this node, itself included, deepest last. */
function subtree(nodes, id) {
  const out = [];
  const walk = (currentId) => {
    const node = nodes.find((n) => n.id === currentId);
    if (!node) return;
    out.push(node);
    for (const child of nodes.filter((n) => n.parentId === currentId)) walk(child.id);
  };
  walk(id);
  return out;
}

/**
 * Would moving `id` into `parentId` make a folder its own ancestor?
 *
 * The one move that has to be refused rather than corrected: a folder dropped
 * inside itself would vanish from the tree entirely, since nothing reachable
 * from the root would lead to it any more, and the rows would sit there
 * pointing at each other forever.
 */
const wouldLoop = (nodes, id, parentId) =>
  Boolean(parentId) && subtree(nodes, id).some((n) => n.id === parentId);

/**
 * The scenes standing on a picture, by name.
 *
 * Deleting an image that a board is currently drawn on is refused rather than
 * allowed with a warning: the alternative is somebody's map going blank
 * mid-session because a folder was being tidied, and "which scenes?" is a
 * question this can answer in the refusal. Backgrounds only - a token's picture
 * never comes from here.
 */
async function scenesUsing(campaignId, urls) {
  const wanted = new Set(urls.filter(Boolean));
  if (!wanted.size) return [];
  const scenes = await store.list(scoped(campaignId, 'scenes'));
  return scenes.filter((s) => wanted.has(s.imageUrl)).map((s) => s.name || 'Untitled scene');
}

/** A new folder, ready to be stored. */
const newFolder = (name, parentId, userId) => ({
  id: crypto.randomUUID(),
  kind: 'folder',
  name: cleanName(name, 'New folder'),
  parentId: parentId || null,
  createdBy: userId || null,
});

/** A new picture, once its bytes are already on the disk. */
const newImage = (name, parentId, userId, { url, bytes }) => ({
  id: crypto.randomUUID(),
  kind: 'image',
  name: cleanName(name, 'Image'),
  parentId: parentId || null,
  url,
  bytes,
  // Whose allowance this picture is spending. Read off the session by the
  // route, never from the request: it is the field the quota is counted from.
  uploadedBy: userId || null,
});

module.exports = {
  COLLECTION,
  QUOTA_BYTES,
  MAX_NODES,
  cloudOf,
  cleanName,
  nodesIn,
  usedBy,
  quotaFor,
  parentOk,
  subtree,
  wouldLoop,
  scenesUsing,
  newFolder,
  newImage,
};
