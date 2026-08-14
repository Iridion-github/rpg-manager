'use strict';

/**
 * Map image uploads - the first binary assets in the project.
 *
 * Files land in DATA_DIR/uploads and are served read-only from /uploads.
 *
 * Uploading needs an identity but not a campaign: an image is the same image
 * whichever table it ends up on, and anyone who can run a campaign needs to be
 * able to bring maps to it. It stops at "signed in" because this writes to your
 * actual disk, which makes it the one endpoint where getting the gate wrong is
 * expensive.
 *
 * Filenames are generated, never taken from the client. A name like
 * "../../index.js" would otherwise let an upload escape the uploads directory.
 */

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const multer = require('multer');

const store = require('../store');
const limits = require('../rateLimit');
const { requireUser } = require('../auth');

const router = express.Router();

const UPLOAD_DIR = path.join(store.DATA_DIR, 'uploads');

/**
 * How big an upload may be, by what it is for.
 *
 * A map is the whole board and is looked at on its own, so it gets the room it
 * needs. A profile picture and a character portrait are drawn an inch across
 * beside a name, and every person at the table downloads every one of them - so
 * a 20 MB photograph straight off a phone would be twenty megabytes spent to
 * fill a thumbnail, over and over, on somebody's home connection. 5 MB is far
 * more than a picture that size can use and still leaves an unedited photo
 * through, which is the file people actually have to hand.
 *
 * The caller says which it is (?kind=portrait); the cap is applied here rather
 * than believed from the browser, so an oversized file is refused as it arrives
 * instead of after it has been carried.
 */
const MAX_BYTES = { map: 20 * 1024 * 1024, portrait: 5 * 1024 * 1024 };

const megabytes = (bytes) => bytes / 1024 / 1024;

// Extension is chosen by us from the detected mime type, not from the upload.
const ALLOWED = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const uploaderFor = (fileSize) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize, files: 1 },
    fileFilter: (req, file, cb) => {
      // A first pass only. `file.mimetype` is the browser's claim about its own
      // upload, not a fact - sniffBytes below is what actually decides.
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

/**
 * What this file actually is, read from its first bytes.
 *
 * The declared type is worth nothing on its own: anyone can post a script, a
 * page, or a zip and label it image/png. It would then sit on this origin under
 * a name we chose, and the only thing standing between that and a script
 * running in someone's session would be the browser declining to sniff it.
 * Deciding here means the file never lands at all.
 *
 * Four signatures, because four types are allowed. WEBP is a RIFF container, so
 * it needs the tag twelve bytes in as well.
 */
function sniffBytes(buf) {
  if (!buf || buf.length < 12) return null;
  const startsWith = (...bytes) => bytes.every((b, i) => buf[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif'; // GIF8
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) && // RIFF
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

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
      await fsp.mkdir(UPLOAD_DIR, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED.get(actual)}`;
      // Same temp-then-rename dance as the JSON store: a half-written image
      // should never be reachable at its final URL.
      const finalPath = path.join(UPLOAD_DIR, name);
      const tmpPath = `${finalPath}.tmp`;
      await fsp.writeFile(tmpPath, req.file.buffer);
      await fsp.rename(tmpPath, finalPath);
      res.status(201).json({ url: `/uploads/${name}`, bytes: req.file.size });
    } catch (e) {
      next(e);
    }
  });
});

module.exports = { router, UPLOAD_DIR };
