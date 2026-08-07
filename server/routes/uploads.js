'use strict';

/**
 * Map image uploads — the first binary assets in the project.
 *
 * Files land in DATA_DIR/uploads and are served read-only from /uploads. Only
 * the GM can upload: this writes to your actual disk, so it is the one endpoint
 * where getting the gate wrong is expensive.
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
const { requireGm } = require('../auth');

const router = express.Router();

const UPLOAD_DIR = path.join(store.DATA_DIR, 'uploads');
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — a big battle map, not a video

// Extension is chosen by us from the detected mime type, not from the upload.
const ALLOWED = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

router.post('/', requireGm, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Image too large (max ${MAX_BYTES / 1024 / 1024} MB)` : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image")' });

    try {
      await fsp.mkdir(UPLOAD_DIR, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED.get(req.file.mimetype)}`;
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
