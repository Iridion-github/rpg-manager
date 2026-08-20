'use strict';

/**
 * What a music file is allowed to be.
 *
 * The tracks land on the same disk as the pictures, under the same generated
 * names, so the part that writes them is imageStore's `saveUpload` rather than
 * a second copy of it here. What is different is the question this module
 * answers: not "is this a picture" but "is this something a browser will
 * actually play", and how much room one song may take.
 *
 * The declared type is not evidence, exactly as with images: anyone can post a
 * page and call it audio/mpeg, and it would then sit on this origin under a
 * name we chose. The first bytes decide, and the extension is picked from what
 * they say - so a file that is not audio at all never reaches the disk.
 */

const { saveUpload, deleteUpload } = require('./imageStore');

/**
 * How big one track may be.
 *
 * A five minute song is about 5 MB at the bitrates people actually have, so
 * this leaves room for a long ambient loop or a short lossless file without
 * letting a single upload eat a fifth of somebody's allowance. The account
 * quota (cloudTree.js) is the real ceiling; this only stops one file from
 * being silly on its own.
 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// Extension is chosen by us from the detected type, never from the upload.
const ALLOWED_AUDIO = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/mp4', '.m4a'],
  ['audio/webm', '.webm'],
  ['audio/flac', '.flac'],
]);

// What to say when none of the signatures match. Written as the list a person
// would need in order to go and convert their file.
const AUDIO_TYPES_TEXT = 'MP3, OGG, WAV, M4A, WEBM or FLAC';

/**
 * What this file actually is, read from its first bytes.
 *
 * Six signatures for six types. MP3 is the awkward one: it may open with an
 * ID3 tag or straight into a frame, and a frame is only recognisable by its
 * eleven sync bits - which is why that branch is last, after every container
 * with a real magic number has had its say.
 */
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  const at = (offset, text) => buf.toString('latin1', offset, offset + text.length) === text;

  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  // EBML: Matroska and WebM share it. A file with video in it plays its audio
  // track and nothing is shown, which for a soundtrack is the right outcome.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  // ISO base media: .m4a, .m4b, and the .mp4s that are audio-only.
  if (at(4, 'ftyp')) return 'audio/mp4';
  if (at(0, 'ID3')) return 'audio/mpeg';
  // A bare MPEG frame: 0xFF then three more sync bits.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/** Put a track on the disk and answer with the address it now lives at. */
const saveAudio = (buffer, mime) => saveUpload(buffer, ALLOWED_AUDIO.get(mime));

/** Take one back off it. A file already gone is not an error. */
const deleteAudio = (url) => deleteUpload(url);

module.exports = {
  MAX_AUDIO_BYTES,
  ALLOWED_AUDIO,
  AUDIO_TYPES_TEXT,
  sniffAudio,
  saveAudio,
  deleteAudio,
};
