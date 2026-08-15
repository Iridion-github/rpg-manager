'use strict';

/**
 * The campaign's image cloud, over HTTP.
 *
 * Everything here is the **DM's alone**, top to bottom: this is where the maps
 * for next week are kept, and half of them are places the party has not been
 * told about. A player has no read of it at all, which is why nothing in this
 * router asks who owns what - being at the table as a DM is the whole of the
 * permission model.
 *
 * The pictures themselves stay reachable at /uploads once they are on a scene,
 * as they always were. What is private is the *tree*: which images exist, what
 * they are called, and which folder somebody filed them in.
 *
 * See cloudTree.js for the shape of a node and for where the quota comes from.
 */

const express = require('express');
const multer = require('multer');

const store = require('../store');
const limits = require('../rateLimit');
const { requireUser } = require('../auth');
const { requireDm } = require('../campaigns');
const { broadcastPerActor } = require('../realtime');
const {
  MAX_BYTES,
  ALLOWED,
  megabytes,
  sniffBytes,
  saveImage,
  deleteImage,
} = require('../imageStore');
const {
  MAX_NODES,
  cloudOf,
  cleanName,
  nodesIn,
  quotaFor,
  parentOk,
  subtree,
  wouldLoop,
  scenesUsing,
  newFolder,
  newImage,
} = require('../cloudTree');

const router = express.Router({ mergeParams: true });

// Every route on this router is the DM's, so the gate is applied once here
// rather than remembered on each of them.
router.use(requireUser, requireDm);

/**
 * The tree changed.
 *
 * To the DMs at this table and nobody else, for the same reason the routes are
 * gated: the cloud is prep, and prep is not a thing the table is shown. A
 * nudge rather than the tree itself, because whoever is looking at it will ask
 * for their own view of it and whoever is not does not need the payload.
 */
const announce = (req) =>
  broadcastPerActor(req, 'cloud:changed', (actor, role) => (role === 'dm' ? {} : null));

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES.map, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

/**
 * The whole tree, and what the caller has left.
 *
 * All of it in one answer rather than a folder at a time: a campaign's worth of
 * maps is a few hundred rows, the browser draws a folder tree that wants the
 * lot anyway, and a request per folder opened would be a request per click.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({ nodes: await nodesIn(req.campaignId), quota: quotaFor(req.actor?.userId) });
  } catch (err) {
    next(err);
  }
});

/** A new, empty folder. */
router.post('/folders', async (req, res, next) => {
  try {
    const nodes = await nodesIn(req.campaignId);
    if (nodes.length >= MAX_NODES) {
      return res.status(409).json({ error: 'This campaign has too many folders and images.' });
    }
    const parentId = req.body?.parentId ? String(req.body.parentId) : null;
    if (!parentOk(nodes, parentId)) {
      return res.status(400).json({ error: 'No such folder.' });
    }
    const folder = newFolder(req.body?.name, parentId, req.actor?.userId);
    await store.put(cloudOf(req.campaignId), folder);
    announce(req);
    res.status(201).json(folder);
  } catch (err) {
    next(err);
  }
});

/**
 * Rename a node, move it, or both.
 *
 * One route for the two, because they are one edit as far as storage is
 * concerned and a browser that lets you drag a folder and rename it in place
 * would otherwise need two calls to describe one drag.
 */
router.put('/nodes/:nodeId', async (req, res, next) => {
  try {
    const nodes = await nodesIn(req.campaignId);
    const node = nodes.find((n) => n.id === req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'Not found' });

    const said = (key) => Object.prototype.hasOwnProperty.call(req.body || {}, key);
    const patch = {};
    if (said('name')) patch.name = cleanName(req.body.name, node.name);
    if (said('parentId')) {
      const parentId = req.body.parentId ? String(req.body.parentId) : null;
      if (!parentOk(nodes, parentId)) return res.status(400).json({ error: 'No such folder.' });
      if (wouldLoop(nodes, node.id, parentId)) {
        return res.status(400).json({ error: 'A folder cannot be moved inside itself.' });
      }
      patch.parentId = parentId;
    }

    const updated = await store.update(cloudOf(req.campaignId), node.id, patch);
    announce(req);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Throw one away, and everything under it.
 *
 * Refused outright while any of the pictures involved is the background of a
 * scene, and the refusal says which scenes: a board going blank in the middle
 * of a session because somebody was tidying folders is not a thing a
 * confirmation dialog makes acceptable. Change those scenes first.
 *
 * The rows go before the files do. A file left on disk with no row is invisible
 * and costs a few megabytes; a row left with no file is a broken picture on
 * somebody's map, which is the worse half to be holding.
 */
router.delete('/nodes/:nodeId', async (req, res, next) => {
  try {
    const nodes = await nodesIn(req.campaignId);
    const node = nodes.find((n) => n.id === req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'Not found' });

    const doomed = subtree(nodes, node.id);
    const images = doomed.filter((n) => n.kind === 'image');
    const inUse = await scenesUsing(req.campaignId, images.map((n) => n.url));
    if (inUse.length) {
      const list = inUse.slice(0, 4).join(', ') + (inUse.length > 4 ? ' and others' : '');
      return res.status(409).json({
        error:
          images.length === 1
            ? `That image is the background of ${list}. Change those scenes first.`
            : `Images in there are the background of ${list}. Change those scenes first.`,
      });
    }

    for (const n of doomed) await store.remove(cloudOf(req.campaignId), n.id);
    for (const image of images) await deleteImage(image.url);
    announce(req);
    res.json({ removed: doomed.length, quota: quotaFor(req.actor?.userId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Put a picture in a folder.
 *
 * The quota is checked twice over: once here against what the account is
 * already using, and once by multer against this one file. Neither is enough on
 * its own - the first cannot know how big the body is until it has arrived, and
 * the second knows nothing about the last hundred uploads.
 */
router.post('/images', (req, res, next) => {
  const wait = limits.uploads.take(limits.bucketOf(req));
  if (wait) return limits.refuse(res, wait);

  uploader.single('image')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Image too large (max ${megabytes(MAX_BYTES.map)} MB)` : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image")' });

    try {
      const actual = sniffBytes(req.file.buffer);
      if (!actual) {
        return res.status(400).json({ error: 'That file is not a PNG, JPEG, WEBP or GIF.' });
      }

      const nodes = await nodesIn(req.campaignId);
      if (nodes.length >= MAX_NODES) {
        return res.status(409).json({ error: 'This campaign has too many folders and images.' });
      }
      const parentId = req.body?.parentId ? String(req.body.parentId) : null;
      if (!parentOk(nodes, parentId)) return res.status(400).json({ error: 'No such folder.' });

      const quota = quotaFor(req.actor?.userId);
      if (quota.used + req.file.size > quota.limit) {
        const left = Math.max(0, quota.limit - quota.used);
        return res.status(413).json({
          error: `That would put you over your ${megabytes(quota.limit)} MB. You have ${megabytes(
            left
          ).toFixed(1)} MB left - delete something first.`,
        });
      }

      const saved = await saveImage(req.file.buffer, actual);
      const image = newImage(req.body?.name, parentId, req.actor?.userId, saved);
      await store.put(cloudOf(req.campaignId), image);
      announce(req);
      res.status(201).json({ image, quota: quotaFor(req.actor?.userId) });
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
