'use strict';

/**
 * Where image bytes live, and what is allowed to become one.
 *
 * Pulled out of routes/uploads.js when the image cloud arrived, because there
 * are now two doors into the same room: the old one, which takes a picture and
 * hands back a URL, and the cloud's, which does that and then files the result
 * in somebody's folders. Both have to agree about what an image is, where it
 * lands and what it is called - and the part they have to agree about is the
 * part where getting it wrong writes a file somebody chose the name of.
 *
 * Files are flat on disk and named by us. The cloud's folders are *records*,
 * not directories: moving a picture between folders is then a field on a row
 * rather than a rename on disk, and a URL that is written into a scene can
 * never break because somebody tidied up.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');

const store = require('./store');

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

/**
 * Put these bytes on the disk and answer with the address they now live at.
 *
 * The name is generated, never taken from the client: a name like
 * "../../index.js" would otherwise let an upload escape the uploads directory.
 * Written to a temporary path and renamed, the same dance the record store
 * does, so a half-written file is never reachable at its final URL.
 *
 * Extension-in, rather than mime-in, because the music tracks land here too
 * (see audioStore.js) and they have their own table of what an .mp3 is. What
 * both callers must not do differently is *this* part: where the bytes go and
 * what the file ends up called.
 */
async function saveUpload(buffer, extension) {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
  const finalPath = path.join(UPLOAD_DIR, name);
  const tmpPath = `${finalPath}.tmp`;
  await fsp.writeFile(tmpPath, buffer);
  await fsp.rename(tmpPath, finalPath);
  return { url: `/uploads/${name}`, bytes: buffer.length };
}

/** An image, whose extension is chosen from what its bytes turned out to be. */
const saveImage = (buffer, mime) => saveUpload(buffer, ALLOWED.get(mime));

/**
 * Take one back off the disk, given the URL it was stored at.
 *
 * Only ever called for a picture this app wrote, and the name is checked back
 * into shape before it is used: what comes in here is a string off a record,
 * and a record is a thing somebody's request once influenced. A file already
 * gone is not an error - the point was for it to be absent.
 */
async function deleteUpload(url) {
  const name = path.basename(String(url || ''));
  if (!name || !/^[\w.-]+$/.test(name)) return false;
  try {
    await fsp.unlink(path.join(UPLOAD_DIR, name));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  UPLOAD_DIR,
  MAX_BYTES,
  ALLOWED,
  megabytes,
  sniffBytes,
  saveUpload,
  saveImage,
  deleteUpload,
  // The old name, kept because half a dozen callers say it and an image is
  // what all of them are deleting.
  deleteImage: deleteUpload,
};
