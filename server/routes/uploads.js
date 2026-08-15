'use strict';

/**
 * Map image uploads - the first binary assets in the project.
 *
 * Files land in DATA_DIR/uploads and are served read-only from /uploads. What
 * an image is, how big it may be and what it ends up called all live in
 * imageStore.js now, because the image cloud (routes/cloud.js) is a second door
 * into the same room and the two must not answer those questions differently.
 *
 * Uploading needs an identity but not a campaign: an image is the same image
 * whichever table it ends up on, and anyone who can run a campaign needs to be
 * able to bring maps to it. It stops at "signed in" because this writes to your
 * actual disk, which makes it the one endpoint where getting the gate wrong is
 * expensive.
 *
 * Nothing here counts against the cloud's quota. This route is what a character
 * portrait, a profile picture and the tabletop's own paste-a-map still use: a
 * picture that is filed in nobody's folders is not taking up room in them
 * either, and the cloud is the thing that is metered.
 */

const express = require('express');
const multer = require('multer');

const limits = require('../rateLimit');
const { requireUser } = require('../auth');
const { UPLOAD_DIR, MAX_BYTES, ALLOWED, megabytes, sniffBytes, saveImage } = require('../imageStore');

const router = express.Router();

const uploaderFor = (fileSize) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize, files: 1 },
    fileFilter: (req, file, cb) => {
      // A first pass only. `file.mimetype` is the browser's claim about its own
      // upload, not a fact - sniffBytes is what actually decides.
      if (!ALLOWED.has(file.mimetype)) {
        return cb(new Error(`Unsupported image type: ${file.mimetype}`));
      }
      cb(null, true);
    },
  });

// One per size, built once: a multer instance carries its limits, so the choice
// between them is made by picking the uploader rather than by reconfiguring one.
const uploaders = {
  map: uploaderFor(MAX_BYTES.map),
  portrait: uploaderFor(MAX_BYTES.portrait),
};

router.post('/', requireUser, (req, res, next) => {
  // Charged before the body is read, so a caller who is over their quota costs
  // nothing but the refusal - no 20 MB held in memory to be thrown away.
  const wait = limits.uploads.take(limits.bucketOf(req));
  if (wait) return limits.refuse(res, wait);

  // Anything this route doesn't recognise is a map, which is what every caller
  // written before the portraits sends.
  const kind = req.query.kind === 'portrait' ? 'portrait' : 'map';

  uploaders[kind].single('image')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Image too large (max ${megabytes(MAX_BYTES[kind])} MB)` : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image")' });

    // The bytes decide, and the extension is taken from what they say rather
    // than from what the upload claimed - so a PNG announced as a JPEG is
    // simply stored as a PNG, and anything that is not an image at all is
    // refused before it touches the disk.
    const actual = sniffBytes(req.file.buffer);
    if (!actual) {
      return res.status(400).json({ error: 'That file is not a PNG, JPEG, WEBP or GIF.' });
    }

    try {
      res.status(201).json(await saveImage(req.file.buffer, actual));
    } catch (e) {
      next(e);
    }
  });
});

module.exports = { router, UPLOAD_DIR };
