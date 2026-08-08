'use strict';

/**
 * Built-in maps — whatever image files you drop into `public/maps/`.
 *
 * Served straight off disk and listed on demand rather than baked into the
 * client bundle, so adding a map is a file copy: no rebuild, no redeploy.
 *
 * Read-only and public. Players need to see the map they're standing on, and
 * nothing here writes, so there's no gate. Only the GM can *choose* a map,
 * which is a scene edit and gated there.
 */

const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');

const router = express.Router();

const MAPS_DIR = path.join(__dirname, '..', '..', 'public', 'maps');

// Extensions we're willing to hand to an <img>. Note that a file's extension
// says nothing about its real format — browsers sniff content — so this is a
// listing filter, not a security check. Nothing here is executed.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

router.get('/', async (req, res, next) => {
  try {
    let entries;
    try {
      entries = await fsp.readdir(MAPS_DIR, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json([]); // no folder yet is fine
      throw err;
    }
    const maps = entries
      .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => ({
        name: path.basename(e.name, path.extname(e.name)),
        file: e.name,
        url: `/maps/${encodeURIComponent(e.name)}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(maps);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, MAPS_DIR };
