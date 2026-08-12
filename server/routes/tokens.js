'use strict';

/**
 * The built-in token library - whatever you drop into `public/tokens/`.
 *
 * Same bargain as the maps beside it: served off disk, listed on demand, so
 * adding artwork is a file copy rather than a rebuild. The difference is scale
 * and shape. There are getting on for two thousand of these arranged in nested
 * folders, which changes two things.
 *
 * First, the walk is cached. Reading a tree that size on every request - and
 * every open of the token picker is a request - is real work for an answer that
 * changes when somebody copies a file in, which is to say almost never. A short
 * TTL means new artwork shows up within the minute without anyone restarting
 * anything.
 *
 * Second, the URL is built here. These names are meant to be read by people -
 * "D&D Iconic Characters", "monk, fighting stance (1)" - so they carry spaces,
 * commas, parentheses and one ampersand. Encoding them at the point they become
 * a URL, once, is better than trusting every future caller to remember; the `&`
 * in particular would silently truncate a path that was merely concatenated.
 *
 * Read-only and public, like the maps: players need to see the art, and nothing
 * here writes.
 */

const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');

const router = express.Router();

const TOKENS_DIR = path.join(__dirname, '..', '..', 'public', 'tokens');

// A listing filter, not a security check - nothing here is executed, and a
// file's extension says nothing about its real contents.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

const CACHE_MS = 60_000;
// How deep the walk will go before deciding something is wrong. The library is
// two or three levels; this only exists so a symlink loop can't hang the
// server.
const MAX_DEPTH = 8;

let cache = null; // { at, files }

/**
 * Every image under the library, each with the folder path that leads to it.
 *
 * Flat rather than nested: the client builds its own tree from these in one
 * pass, and search - which is the other half of what this feeds - wants the
 * flat list anyway. A nested payload would have to be flattened back out.
 */
async function walk(dir, relative = '', depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out; // no library yet is fine
    throw err;
  }
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), rel, depth + 1, out);
    } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push({
        // What a person reads: the file's name without its extension.
        name: path.basename(entry.name, path.extname(entry.name)),
        // Where it sits, for the tree and for the full path search results show.
        folder: relative,
        // Ready to use. Every segment encoded, the slashes left alone.
        url: '/tokens/' + rel.split('/').map(encodeURIComponent).join('/'),
      });
    }
  }
  return out;
}

async function listing() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.files;
  const files = await walk(TOKENS_DIR);
  files.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), files };
  return files;
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await listing());
  } catch (err) {
    next(err);
  }
});

module.exports = { router, TOKENS_DIR };
