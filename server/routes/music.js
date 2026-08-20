'use strict';

/**
 * Shared music for a campaign.
 *
 * The DM keeps a list of tracks and presses play on one; everyone at the table
 * hears it. What travels is not audio - it's an instruction: *this track,
 * started at this moment*. Each browser plays its own copy and seeks to
 * `now - startedAt`, which is what lets someone arriving late join the track
 * already in progress instead of starting it over for themselves.
 *
 * A track is one of two things. A **youtube** track is a video id and nothing
 * else on this disk. A **file** track is audio the DM uploaded, which is bytes
 * on the machine and therefore spends their allowance (cloudTree.js counts
 * them) and is deleted with the entry - the one place the two kinds are not
 * interchangeable, because a link is somebody else's file and this one is
 * ours.
 *
 * The DM's transport - pause, resume, jump to a point - is the same idea said
 * three more ways, and none of it is local: pausing writes down *where* the
 * track was paused and seeking rewrites *when* it started, so every browser at
 * the table lands on the same second as the one that pressed the button. A
 * control that only moved the DM's own audio would be a control that quietly
 * desynchronised the table.
 *
 * That also means sync is as good as the clients' clocks and buffering, which
 * is to say within a second or so. For background music at a table that is
 * fine; it is not a way to play a song in unison for an audience.
 *
 * The DM alone controls playback. A player hearing music they can't stop is
 * the point - it's the table's soundtrack, not a shared jukebox.
 */

const express = require('express');
const multer = require('multer');

const store = require('../store');
const limits = require('../rateLimit');
const { broadcast } = require('../realtime');
const { scoped, requireDm } = require('../campaigns');
const { megabytes } = require('../imageStore');
const { quotaFor } = require('../cloudTree');
const {
  MAX_AUDIO_BYTES,
  ALLOWED_AUDIO,
  AUDIO_TYPES_TEXT,
  sniffAudio,
  saveAudio,
  deleteAudio,
} = require('../audioStore');

const TRACKS = 'music';
const STATE = 'musicState';
const STATE_ID = 'now';
const MAX_TRACKS = 200;
const MAX_TITLE = 200;

const router = express.Router({ mergeParams: true });

const tracksOf = (req) => scoped(req.campaignId, TRACKS);
const stateOf = (req) => scoped(req.campaignId, STATE);

// A YouTube id is exactly 11 characters of URL-safe base64.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const idOrNull = (v) => (ID_RE.test(String(v || '')) ? String(v) : null);
const cleanTitle = (v) => String(v ?? '').trim().slice(0, MAX_TITLE);

// Entries written before uploads existed carry no kind at all, and every one of
// them is a link. Asked this way rather than by backfilling the rows: the
// default is permanent and a migration would only be a slower way to say it.
const kindOf = (track) => (track?.kind === 'file' ? 'file' : 'youtube');

/**
 * The name to hang on a file whose uploader did not type one.
 *
 * Off the filename, minus its extension, because "goblin-market-loop.mp3" is
 * what they called it and is very nearly what they wanted it called here.
 */
const titleFromFilename = (name) =>
  cleanTitle(String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));

/**
 * Pull the video id out of whatever the DM pasted.
 *
 * Parsed here rather than in the browser so a bad link is rejected once, by the
 * one party every client trusts - and so what gets stored is the id, not
 * whichever of the half-dozen URL shapes happened to be in the clipboard.
 */
function videoIdFrom(input) {
  const raw = String(input || '').trim();
  if (ID_RE.test(raw)) return raw; // someone pasted the bare id

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') return idOrNull(url.pathname.slice(1));
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return idOrNull(url.searchParams.get('v'));
    const m = /^\/(embed|v|shorts|live)\/([^/?#]+)/.exec(url.pathname);
    if (m) return idOrNull(m[2]);
  }
  return null;
}

/**
 * Ask YouTube what the video is called.
 *
 * oEmbed is public and needs no API key. It's a best effort: the request goes
 * out from the host machine, which may be offline or firewalled, so a failure
 * costs the track its title and nothing else.
 */
async function fetchTitle(videoId) {
  try {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(`https://www.youtube.com/oembed?url=${target}&format=json`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return String(data.title || '').slice(0, 200);
  } catch {
    return '';
  }
}

// Nothing sensible is longer than this, and a seek beyond it would only be a
// way to hand every browser at the table a nonsense timestamp.
const MAX_SECONDS = 24 * 60 * 60;

/**
 * How far into the track the table is, right now.
 *
 * Two answers because there are two states. A running track is timed from
 * `startedAt` against the server's clock; a paused one has its position
 * written down, because a clock is exactly what a pause stops.
 */
const positionOf = (playing) => {
  if (!playing) return 0;
  if (playing.pausedAt != null) return Math.max(0, Number(playing.pausedAt) || 0);
  return Math.max(0, (Date.now() - Date.parse(playing.startedAt)) / 1000);
};

const readState = async (req) => (await store.get(stateOf(req), STATE_ID))?.playing || null;

function setState(req, playing) {
  return store.mutate(stateOf(req), STATE_ID, (current) => ({ ...current, playing }), {
    createIfMissing: { playing: null },
  });
}

// Everyone at the table gets the same payload: a playlist isn't a secret, and
// the whole point of playback state is that it's shared.
function announce(req, playing) {
  broadcast(req, 'music:state', { playing });
}

router.get('/', async (req, res, next) => {
  try {
    const [tracks, playing] = await Promise.all([store.list(tracksOf(req)), readState(req)]);
    res.json({ tracks, playing });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireDm, async (req, res, next) => {
  try {
    const videoId = videoIdFrom(req.body?.url);
    if (!videoId) {
      return res.status(400).json({ error: "That doesn't look like a YouTube link." });
    }
    const existing = await store.list(tracksOf(req));
    if (existing.length >= MAX_TRACKS) {
      return res.status(400).json({ error: 'That is enough music for one campaign.' });
    }
    if (existing.some((t) => t.videoId === videoId)) {
      return res.status(409).json({ error: "That's already in the list." });
    }

    // A title you typed wins over the one YouTube reports - you know what the
    // track is for at your table better than its uploader does - and it skips
    // the lookup entirely. Failing that, ask YouTube; failing that, the id,
    // so a track added while the host is offline is still recognisable.
    const title = cleanTitle(req.body?.title) || (await fetchTitle(videoId)) || videoId;
    const record = await store.create(tracksOf(req), {
      kind: 'youtube',
      videoId,
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
    broadcast(req, 'music:tracks', { action: 'create', record });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    // A first pass only, and a cheap one: `file.mimetype` is the browser's
    // claim about its own upload. sniffAudio is what actually decides.
    if (!ALLOWED_AUDIO.has(file.mimetype) && !String(file.mimetype || '').startsWith('audio/')) {
      return cb(new Error(`That is not audio (${file.mimetype || 'unknown type'}).`));
    }
    cb(null, true);
  },
});

/**
 * A track that is a file rather than a link.
 *
 * The allowance is checked twice: once here against everything the account has
 * already put on this disk, and once by multer against this single upload.
 * Neither covers the other - the first cannot know the size of a body that has
 * not arrived, and the second knows nothing about the last hundred uploads.
 *
 * The bytes go down before the row does. A file with no row is a few megabytes
 * nobody can see; a row with no file is a track that plays silence, which is
 * the worse half to be holding.
 */
router.post('/files', requireDm, (req, res, next) => {
  // Charged before the body is read, so a caller who is over their limit costs
  // the refusal and nothing else - no 20 MB held in memory to be thrown away.
  const wait = limits.uploads.take(limits.bucketOf(req));
  if (wait) return limits.refuse(res, wait);

  uploader.single('audio')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig
          ? `That file is too large (max ${megabytes(MAX_AUDIO_BYTES)} MB).`
          : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: "audio")' });

    try {
      const actual = sniffAudio(req.file.buffer);
      if (!actual) return res.status(400).json({ error: `That file is not ${AUDIO_TYPES_TEXT}.` });

      const existing = await store.list(tracksOf(req));
      if (existing.length >= MAX_TRACKS) {
        return res.status(400).json({ error: 'That is enough music for one campaign.' });
      }

      const quota = quotaFor(req.actor?.userId);
      if (quota.used + req.file.size > quota.limit) {
        const left = Math.max(0, quota.limit - quota.used);
        return res.status(413).json({
          error: `That would put you over your ${megabytes(quota.limit)} MB. You have ${megabytes(
            left
          ).toFixed(1)} MB left - delete something first.`,
        });
      }

      const saved = await saveAudio(req.file.buffer, actual);
      const record = await store.create(tracksOf(req), {
        kind: 'file',
        title: cleanTitle(req.body?.title) || titleFromFilename(req.file.originalname) || 'Track',
        url: saved.url,
        bytes: saved.bytes,
        mime: actual,
        // Whose allowance this track is spending. Read off the session, never
        // off the request: it is the field the quota is counted from.
        uploadedBy: req.actor?.userId || null,
      });
      broadcast(req, 'music:tracks', { action: 'create', record });
      res.status(201).json({ track: record, quota: quotaFor(req.actor?.userId) });
    } catch (e) {
      next(e);
    }
  });
});

// Rename. The only thing about a track that's editable - the video it points
// at isn't a property of the entry so much as the entry itself.
router.put('/:id', requireDm, async (req, res, next) => {
  try {
    const title = cleanTitle(req.body?.title);
    if (!title) return res.status(400).json({ error: 'A track needs a name.' });

    const record = await store.mutate(tracksOf(req), req.params.id, (current) => ({
      ...current,
      title,
    }));
    if (!record) return res.status(404).json({ error: 'Not found' });
    broadcast(req, 'music:tracks', { action: 'update', record });

    // The playing state carries its own copy of the title, so renaming what's
    // currently on would otherwise leave the player bar showing the old name
    // until the next track. startedAt is preserved deliberately: clients key
    // playback off it, and a new one would restart the song for everybody.
    const playing = await readState(req);
    if (playing?.trackId === record.id) {
      const renamed = { ...playing, title };
      await setState(req, renamed);
      announce(req, renamed);
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/play', requireDm, async (req, res, next) => {
  try {
    const track = await store.get(tracksOf(req), req.params.id);
    if (!track) return res.status(404).json({ error: 'Not found' });

    // Both kinds in one shape, so the browser reads `kind` and then either the
    // video id or the URL. Whichever it is, `startedAt` is the server's clock
    // rather than the DM's browser's - every client works out its seek offset
    // against the same reference.
    const playing = {
      trackId: track.id,
      kind: kindOf(track),
      videoId: track.videoId || null,
      url: kindOf(track) === 'file' ? track.url : null,
      title: track.title,
      startedAt: new Date().toISOString(),
      // Running, not held: pressing play on a track is the one thing that
      // clears a pause left over from the last one.
      pausedAt: null,
    };
    await setState(req, playing);
    announce(req, playing);
    res.json(playing);
  } catch (err) {
    next(err);
  }
});

/**
 * The DM's transport: hold it, let it go, or move it.
 *
 * Uploaded tracks only. A YouTube embed comes with YouTube's own controls, and
 * a second set of buttons over the top of them would be two scrubbers
 * disagreeing about the same video.
 */
async function transport(req, res, change) {
  const playing = await readState(req);
  if (!playing) return res.status(409).json({ error: 'Nothing is playing.' });
  if (playing.kind !== 'file') {
    return res.status(400).json({ error: 'Only an uploaded track can be controlled from here.' });
  }
  const next = change(playing);
  await setState(req, next);
  announce(req, next);
  return res.json(next);
}

// Hold it where it is. The position is written down because that is the one
// thing a stopped clock can no longer be asked for.
router.post('/pause', requireDm, (req, res, next) =>
  transport(req, res, (playing) => ({ ...playing, pausedAt: positionOf(playing) })).catch(next)
);

// Let it go again, from where it was held. A fresh startedAt, backdated by the
// position, is all "resume" means to a client.
router.post('/resume', requireDm, (req, res, next) =>
  transport(req, res, (playing) => ({
    ...playing,
    startedAt: new Date(Date.now() - positionOf(playing) * 1000).toISOString(),
    pausedAt: null,
  })).catch(next)
);

/**
 * Jump to a point in the track.
 *
 * Held or running, the answer is the same edit seen from two sides: the
 * position moves, or the start time moves to put the position there.
 */
router.post('/seek', requireDm, (req, res, next) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
    return res.status(400).json({ error: 'That is not a point in the track.' });
  }
  return transport(req, res, (playing) =>
    playing.pausedAt != null
      ? { ...playing, pausedAt: seconds }
      : { ...playing, startedAt: new Date(Date.now() - seconds * 1000).toISOString() }
  ).catch(next);
});

router.post('/stop', requireDm, async (req, res, next) => {
  try {
    await setState(req, null);
    announce(req, null);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireDm, async (req, res, next) => {
  try {
    const track = await store.get(tracksOf(req), req.params.id);
    const ok = await store.remove(tracksOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });

    // An uploaded track is ours, so removing the entry removes the audio and
    // gives the DM their megabytes back. A YouTube track is a link to somebody
    // else's file and there is nothing here to delete - which is what the
    // browser's confirmation dialog says on the way in.
    if (kindOf(track) === 'file') await deleteAudio(track.url);

    // Deleting what's currently playing stops it. Leaving it running would mean
    // music nobody can name and only the DM can silence, by pressing stop on a
    // track that no longer exists.
    const playing = await readState(req);
    if (playing?.trackId === req.params.id) {
      await setState(req, null);
      announce(req, null);
    }
    broadcast(req, 'music:tracks', { action: 'delete', record: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
