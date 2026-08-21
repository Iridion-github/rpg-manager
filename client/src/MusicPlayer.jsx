import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';

/**
 * The thing that actually makes noise.
 *
 * It lives in App, beside the chat, and *not* in the Music tab - a component
 * unmounts when you switch tabs, and an unmounted player is silence. So the tab
 * is only a list of buttons; this is what plays.
 *
 * The server broadcasts "this track, started at this moment" and each browser
 * plays its own copy, seeking to how far in it should be by now. That's what
 * lets someone arriving late join a track already running, and it's why sync is
 * within a second rather than exact.
 *
 * Two players, because a track is either a YouTube video or a file the DM
 * uploaded, and only one of them can be making noise at a time. The iframe and
 * the audio element both stay mounted whichever is in use: building either one
 * on demand would cost a beat at the start of every track, and the one being
 * left behind is silenced rather than removed.
 *
 * The DM gets a transport - hold it, let it go, drag it to a point - and the
 * same one whichever kind of track is on. A video used to be handed to
 * YouTube's own controls instead, on the reasoning that a second set of
 * buttons over the top of them would be two scrubbers disagreeing about one
 * video. The trouble was that they disagreed about something more important:
 * YouTube's buttons move the DM's browser, and pausing on them left the DM
 * conducting a table that could still hear the music. So the embed is not
 * shown at all, and none of the buttons here touch this browser's player
 * directly: they ask the server to move the *table*, and every browser
 * including this one then follows the answer. That is what keeps a scrub from
 * desynchronising the room.
 *
 * Only the DM sees what is playing. For everyone else the music is meant to be
 * scenery - they are told nothing about it: no video, no title, and nothing
 * that could move the table. What they do get is a volume slider, because how
 * loud somebody else's music is in your room is the one thing about it that is
 * genuinely yours to decide, and the alternative was reaching for the system
 * mixer. The iframe still has to exist for them, so it's parked off-screen
 * rather than removed, because a frame that isn't rendered can have its
 * playback suspended.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';

// YT.PlayerState, without needing the API loaded to name it.
const PLAYING = 1;

/**
 * How long to give the player before deciding the browser refused to start it.
 *
 * Longer than it used to be, and it can afford to be: `onStateChange` now says
 * the moment playback really begins, so this timer is only ever the *negative*
 * answer. Erring long costs a slow connection nothing, where erring short used
 * to put an Enable sound button in front of somebody whose track was about to
 * start on its own.
 */
const AUTOPLAY_GRACE_MS = 3000;

/**
 * This browser's own volume, 0 to 1, remembered between visits.
 *
 * Local, and deliberately not part of the table's playback state. The DM's
 * transport moves the room - pause it and everybody holds - because where in a
 * track the table is has to be one answer. How loud it is in your room is not:
 * it depends on your speakers and who else is in the house, and a shared
 * number would mean the DM turning themselves down turning everybody down.
 *
 * In localStorage rather than state alone so it is already right when the next
 * track starts, including the first one after a reload.
 */
const VOLUME_KEY = 'rpg-manager:music-volume';

function storedVolume() {
  // Read as text first and only then as a number. `Number(null)` is 0, not
  // NaN, so asking a browser that has never stored this what it stored gets
  // you a perfectly valid zero - which is to say full silence, as the default,
  // for everybody who had never touched the slider.
  const raw = localStorage.getItem(VOLUME_KEY);
  if (raw === null) return 1;
  const level = Number(raw);
  return Number.isFinite(level) && level >= 0 && level <= 1 ? level : 1;
}

/**
 * Load YouTube's iframe API once per page.
 *
 * It signals readiness by calling a global, so the promise is shared: two
 * players asking at once must not both inject the script, and whoever asks
 * after it's ready must not wait for a callback that has already fired.
 */
let apiPromise = null;
function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = API_SRC;
    // The host PC is the server, so if it's off you're offline anyway - but
    // YouTube itself can be blocked separately, and that shouldn't hang here.
    script.onerror = () => reject(new Error('Could not reach YouTube.'));
    document.head.appendChild(script);
  });
  return apiPromise;
}

// 101 and 150 are the same thing: the owner does not allow embedding.
const errorText = (code) =>
  code === 101 || code === 150
    ? "That video's owner doesn't allow it to be played outside YouTube."
    : code === 100
      ? 'That video is private or has been removed.'
      : 'YouTube refused to play that one.';

/**
 * Seconds as a clock, the way every music player writes them.
 *
 * Not through dateFormat.js: that is for dates and times of day, where the
 * order of the numbers is a real question. This is a length, and 3:07 means
 * the same thing at every table.
 */
/**
 * How far into the track the table is, right now.
 *
 * The twin of positionOf in server/routes/music.js, and the whole of how a
 * browser works out where it should be: a running track is timed from
 * `startedAt` against the clock, a held one has its position written down,
 * because a clock is exactly what a pause stops. Both players ask this the
 * same question, which is what makes the transport mean the same thing
 * whichever kind of track is on.
 */
const positionOf = (playing) =>
  Math.max(
    0,
    playing.pausedAt != null
      ? Number(playing.pausedAt) || 0
      : (Date.now() - Date.parse(playing.startedAt)) / 1000
  );

/**
 * How often the readout for a video is redrawn.
 *
 * An <audio> element says where it is several times a second, through
 * `timeupdate`. The iframe has no such event, so the number is worked out
 * instead - see the effect that uses this - and twice a second is often enough
 * that the seconds never visibly stick.
 */
const YT_TICK_MS = 500;

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const ss = String(whole % 60).padStart(2, '0');
  // Hours only once there are any. This never came up while the transport was
  // for uploaded files, which run to a few minutes each; a three-hour ambience
  // video is the ordinary case for the other kind, and "184:12" is not a
  // length anybody reads as a bit over three hours.
  const hours = Math.floor(whole / 3600);
  if (!hours) return `${Math.floor(whole / 60)}:${ss}`;
  return `${hours}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${ss}`;
}

export default function MusicPlayer({ canControl }) {
  const [playing, setPlaying] = useState(null);
  const [blocked, setBlocked] = useState(false); // browser refused to autoplay
  const [error, setError] = useState('');
  // The transport's own three numbers. `scrub` is non-null only while a thumb
  // is being dragged, and it wins over `position` for as long as it is: the
  // slider must follow the finger rather than the playhead it is about to
  // move.
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState(null);
  // The same value again, where a listener on the window can read it without
  // being re-attached for every pixel of the drag.
  const scrubRef = useRef(null);
  // This browser's loudness, 0 to 1. Zero is what the speaker button means by
  // muted - one number rather than a volume and a flag, because the two would
  // have to be kept in step and there is nothing a separate flag could say
  // that a zero cannot.
  const [volume, setVolume] = useState(storedVolume);
  // What to come back to when the speaker button is pressed again. A track
  // turned down to nothing and then unmuted has to land somewhere, and silence
  // is not an answer.
  const lastAudible = useRef(volume || 1);
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  // Which video the iframe player is currently holding. The player itself
  // could be asked, but not reliably at the moment this is needed: right after
  // loadVideoById it still answers with the one before.
  const loadedVideo = useRef(null);
  const audioRef = useRef(null);
  const graceTimer = useRef(null);
  // Read from inside callbacks that must not be rebuilt for every drag of the
  // slider - the YouTube player's onReady, in particular, is handed over once
  // when the player is built and keeps whatever closure it was given.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  /**
   * Put the current volume into whichever player is actually making noise.
   *
   * Called from three places for one reason each: when the number changes,
   * when the file element gets a new track, and when the YouTube player is
   * first built - a player created after the last change would otherwise start
   * at full volume for somebody who had turned it down.
   */
  const applyVolume = useCallback(() => {
    const level = volumeRef.current;
    const el = audioRef.current;
    if (el) {
      el.volume = level;
      el.muted = level === 0;
    }
    // The YouTube player counts to a hundred, and has a mute of its own that
    // setVolume(0) does not touch.
    playerRef.current?.setVolume?.(Math.round(level * 100));
    if (level === 0) playerRef.current?.mute?.();
    else playerRef.current?.unMute?.();
  }, []);

  useEffect(() => {
    localStorage.setItem(VOLUME_KEY, String(volume));
    if (volume > 0) lastAudible.current = volume;
    applyVolume();
  }, [volume, applyVolume]);

  const muted = volume === 0;
  const toggleMute = () => setVolume(muted ? lastAudible.current || 1 : 0);

  // Which of the two players this track belongs to.
  const isFile = playing?.kind === 'file';
  // Held rather than running. A paused track is still "playing" as far as the
  // table is concerned - it is the track that is on, and it has a position.
  const held = playing?.pausedAt != null;

  /**
   * Did it actually start? Asked after the grace period, and again after a
   * retry.
   *
   * Playing is the only answer that counts. Buffering used to count as well,
   * on the reasoning that a track about to start is a track that started - but
   * a player the browser has refused to autoplay *parks* in buffering and
   * stays there, so counting it meant deciding "yes, it is playing" about the
   * exact state that means it never will. With nothing checking a second time,
   * a listener was left in silence with no button to fix it, which is what
   * made a track change inaudible until they reloaded the page.
   */
  const checkStarted = useCallback(() => {
    setBlocked(playerRef.current?.getPlayerState?.() !== PLAYING);
  }, []);

  const load = useCallback(async () => {
    try {
      const { playing: now } = await api.getMusic();
      setPlaying(now);
    } catch {
      /* offline; the shell already says so */
    }
  }, []);

  useEffect(() => {
    load();
    const onState = ({ playing: now }) => {
      setError('');
      setPlaying(now);
    };
    socket.on('music:state', onState);
    socket.on('connect', load); // may have missed a change while away
    return () => {
      socket.off('music:state', onState);
      socket.off('connect', load);
    };
  }, [load]);

  /**
   * Drive the embedded player from whatever the table is currently playing.
   *
   * Silence for anything that isn't a YouTube track: a file playing underneath
   * a video would be two songs at once, and the reverse is just as bad.
   *
   * This runs on every change to the table's playback - a new track, a pause,
   * a seek - and asks the same question the <audio> element below is asked:
   * where should this browser be, and should it be moving? Which is what lets
   * one transport drive both kinds. The three cases are told apart by
   * `loadedVideo`, because they want different things of the player: a new
   * video is loaded, a moved one is seeked, and reloading on a seek would
   * throw away the whole buffer to travel four seconds.
   */
  useEffect(() => {
    let cancelled = false;
    clearTimeout(graceTimer.current);

    if (!playing || playing.kind === 'file') {
      playerRef.current?.stopVideo?.();
      loadedVideo.current = null;
      if (!playing) setBlocked(false);
      return;
    }

    const target = positionOf(playing);
    // The readout goes where the table is going, now, rather than waiting for
    // the player to get there and report it - the DM who just dragged the
    // slider should see the number they dropped it on.
    setPosition(target);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        const player = playerRef.current;
        // Held rather than running. Read from the payload this effect ran for,
        // not from the `held` above, so the closure cannot be looking at a
        // different render's answer to the same question.
        const holding = playing.pausedAt != null;

        if (!player) {
          loadedVideo.current = playing.videoId;
          // Until this one says how long it is. Whatever was there belonged to
          // the track before, and a slider whose end is the wrong track's end
          // is a slider that drops the thumb in the wrong place.
          setDuration(0);
          playerRef.current = new YT.Player(hostRef.current, {
            width: '100%',
            height: '100%',
            videoId: playing.videoId,
            // Cued at the right second either way; autoplay is the only
            // difference between arriving at a running track and a held one.
            playerVars: { autoplay: holding ? 0 : 1, start: Math.floor(target), playsinline: 1 },
            events: {
              onReady: (e) => {
                applyVolume();
                setDuration(e.target.getDuration?.() || 0);
                if (!holding) e.target.playVideo();
              },
              // The positive answer, straight from the player. It arrives
              // whenever playback really begins - on its own, or on the retry
              // below, or because somebody pressed play - so the grace timer
              // is left to say only "it didn't". The length rides along with
              // it: a video that has only just been cued does not know its own
              // duration yet, and the slider needs one before it can be
              // dragged.
              onStateChange: (e) => {
                if (e.data === PLAYING) setBlocked(false);
                const total = e.target.getDuration?.() || 0;
                if (total) setDuration(total);
              },
              onError: (e) => setError(errorText(e.data)),
            },
          });
        } else if (loadedVideo.current !== playing.videoId) {
          loadedVideo.current = playing.videoId;
          setDuration(0); // as above: the old length is not this one's

          // Cue rather than load when it arrives held, or the opening second
          // of a track nobody asked to hear yet plays before the pause lands.
          if (holding) player.cueVideoById?.({ videoId: playing.videoId, startSeconds: target });
          else player.loadVideoById?.({ videoId: playing.videoId, startSeconds: target });
        } else {
          // Same video, and the table moved inside it. Only move the playhead
          // when it is really somewhere else: half a second of drift is the
          // network, not an instruction, and seeking on it would put a stutter
          // in the sound every time this effect ran.
          const at = player.getCurrentTime?.() ?? 0;
          if (Math.abs(at - target) > 0.75) player.seekTo?.(target, true);
          if (holding) player.pauseVideo?.();
          else player.playVideo?.();
        }

        if (holding) {
          // A held track is not playing because it was told not to, so there
          // is nothing here for the Enable sound button to fix.
          setBlocked(false);
        } else {
          // Autoplay with sound needs a user gesture, and a listener who hasn't
          // clicked anything yet won't get one. Rather than guess at the rules,
          // watch whether it actually started and offer a button if it didn't.
          graceTimer.current = setTimeout(checkStarted, AUTOPLAY_GRACE_MS);
        }
        // A player built before the volume was last changed would otherwise
        // start at full for somebody who had turned it down.
        applyVolume();
      })
      .catch((e) => setError(e.message));

    return () => {
      cancelled = true;
      clearTimeout(graceTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing?.kind, playing?.videoId, playing?.startedAt, playing?.pausedAt, applyVolume]);

  /**
   * Where the table is in a video, for the readout and the slider.
   *
   * Worked out from the table's own clock rather than asked of the player, and
   * that is the important part. The player *can* be asked - getCurrentTime -
   * and doing so was the obvious thing, but its answer is where this one
   * browser's video has got to, which is not the question the transport is
   * about. Drag the slider to twenty minutes and the player reports the old
   * second until its seek lands, so the readout jumped forward and then
   * visibly fell back; and while a video is buffering or was never allowed to
   * start, it reports a number that has nothing to do with where the room is.
   *
   * `positionOf` is the same clock every browser at the table uses to decide
   * where it should be, so the DM reads the number they are commanding rather
   * than the number their own iframe happens to have reached.
   *
   * Only while a track is running: a held one already shows the second it was
   * held at, and its answer cannot change until somebody moves it.
   */
  useEffect(() => {
    if (!playing || isFile || held) return undefined;
    const tick = setInterval(() => {
      // Never while a thumb is down: the slider belongs to the finger holding
      // it until it is let go.
      if (scrubRef.current != null) return;
      // Past the end, the clock keeps running and the video does not. Parked
      // at the end for the same reason the file player parks there.
      setPosition(duration ? Math.min(positionOf(playing), duration) : positionOf(playing));
    }, YT_TICK_MS);
    return () => clearInterval(tick);
  }, [playing, isFile, held, duration]);

  /**
   * The same job for an uploaded file, done by an <audio> element.
   *
   * This runs on every change to the table's playback - a new track, a pause,
   * a seek - and each time it asks the same question: where should this
   * browser be, and should it be moving? Which makes the DM's own transport
   * nothing special. They press pause, the server says the track is held at
   * 42 seconds, and this puts them at 42 seconds paused exactly as it does for
   * everybody else.
   *
   * The *seek* has to wait for the browser to know how long the file is,
   * because `currentTime` on a file whose metadata has not arrived yet goes
   * nowhere. Starting it does not, and must not: a browser will happily leave
   * an element it has never been asked to play sitting at readyState 0 with
   * the download deferred, so waiting for metadata before calling play() is
   * waiting for something that only playing will produce. That deadlock was
   * silence with no way out of it - not even the Enable sound button, since
   * the code that offers it was on the far side of the same wait.
   */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    if (!playing || playing.kind !== 'file') {
      el.pause();
      return;
    }

    let cancelled = false;
    const wanted = new URL(playing.url, window.location.origin).href;
    const target = Math.max(
      0,
      playing.pausedAt != null
        ? Number(playing.pausedAt) || 0
        : (Date.now() - Date.parse(playing.startedAt)) / 1000
    );

    // Where the table is, put onto this element's playhead. Nothing else: this
    // is the half that genuinely needs the file's metadata first.
    const seek = () => {
      if (cancelled) return;
      // Past the end: park at the end rather than starting the track over for
      // whoever has only just arrived, which is the one thing this whole
      // mechanism exists to avoid.
      if (Number.isFinite(el.duration) && target >= el.duration) {
        el.pause();
        el.currentTime = el.duration;
        return;
      }
      // Only move the playhead when it is really somewhere else. Half a second
      // of drift is the network, not an instruction, and correcting it would
      // put a stutter in the sound every time this effect ran.
      if (Math.abs(el.currentTime - target) > 0.75) el.currentTime = target;
    };

    // Only when it is actually a different file: re-assigning the same src
    // would reload it, and a pause would cost a gap of silence on resume.
    if (el.src !== wanted) {
      el.src = playing.url;
      el.load();
      setDuration(0); // until this file says how long it is
    }
    // The readout goes where the table is going, now, rather than waiting for
    // the element to get there and report it: the DM who just dragged the
    // slider should see the number they dropped it on.
    setPosition(target);
    applyVolume();

    if (el.readyState >= 1) seek(); // metadata already in hand
    else el.addEventListener('loadedmetadata', seek, { once: true });

    // Started - or held - without waiting for any of that. On a cold file the
    // seek above lands a moment later, so a latecomer can hear the opening bar
    // before it jumps to where the table is. That is the price of the fix and
    // it is worth paying: the alternative was not a cleaner start, it was no
    // sound at all.
    if (playing.pausedAt != null) {
      el.pause();
      setBlocked(false);
    } else {
      // Unlike the iframe, this says outright whether it was allowed to start,
      // so there is no grace period to sit through.
      el.play().then(
        () => setBlocked(false),
        () => setBlocked(true)
      );
    }

    return () => {
      cancelled = true;
      el.removeEventListener('loadedmetadata', seek);
    };
  }, [playing?.kind, playing?.url, playing?.startedAt, playing?.pausedAt, applyVolume]);

  /**
   * If the browser refused to start, try again the moment the user touches
   * anything at all.
   *
   * Any click or keypress is the gesture autoplay was waiting for, and it need
   * not be aimed at the music - switching tabs or typing in the chat will do.
   * This is what keeps the players' experience contentless: most of them get
   * sound without ever being shown a button, because they were going to click
   * something anyway.
   */
  useEffect(() => {
    if (!blocked) return;
    const retry = () => {
      if (isFile) {
        audioRef.current?.play().then(
          () => setBlocked(false),
          () => {}
        );
        return;
      }
      playerRef.current?.playVideo?.();
      setTimeout(checkStarted, 800); // did it actually take?
    };
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
    return () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
    };
  }, [blocked, checkStarted, isFile]);

  useEffect(
    () => () => {
      clearTimeout(graceTimer.current);
      playerRef.current?.destroy?.();
      playerRef.current = null;
      audioRef.current?.pause();
    },
    []
  );

  // The click that unblocks it is itself the gesture the browser was waiting
  // for, so playing from here always works.
  function enableAudio() {
    if (isFile) audioRef.current?.play().catch(() => {});
    else playerRef.current?.playVideo?.();
    setBlocked(false);
  }

  const stop = () => api.stopMusic().catch((e) => setError(e.message));

  /**
   * Hold the track, or let it go.
   *
   * Asked of the server rather than of the element in front of us: this is the
   * table's soundtrack, and a pause that only silenced the DM would leave them
   * conducting a room they can no longer hear.
   */
  const togglePause = () =>
    (held ? api.resumeMusic() : api.pauseMusic()).catch((e) => setError(e.message));

  /**
   * Let go of the slider: move the whole table to where the thumb landed.
   *
   * Committed on release rather than as it moves. A seek per pixel would be a
   * request per pixel, and every browser at the table jumping about while
   * somebody is still deciding where to drop it.
   */
  const commitSeek = useCallback(() => {
    const seconds = scrubRef.current;
    if (seconds == null) return;
    scrubRef.current = null;
    setScrub(null);
    setPosition(seconds); // hold the thumb still until the server's answer lands
    api.seekMusic(seconds).catch((e) => setError(e.message));
  }, []);

  /**
   * The release that ends a drag, wherever it happens.
   *
   * On the window rather than on the slider: a thumb dragged off the end of
   * the control and let go over the chat would otherwise leave the seek
   * uncommitted, and the slider stuck where nobody put it.
   */
  const scrubbing = scrub != null;
  useEffect(() => {
    if (!scrubbing) return;
    window.addEventListener('pointerup', commitSeek);
    window.addEventListener('pointercancel', commitSeek);
    return () => {
      window.removeEventListener('pointerup', commitSeek);
      window.removeEventListener('pointercancel', commitSeek);
    };
  }, [scrubbing, commitSeek]);

  // Nothing playing: keep the iframe mounted but out of the way, so the next
  // play command doesn't have to build a player from scratch.
  const idle = !playing;

  return (
    <aside className={`music-bar${idle ? ' idle' : ''}${canControl ? '' : ' hidden'}`}>
      {/* The iframe, which nobody sees any more. It used to be the DM's window
          onto the video and their only way to pause it; the transport below
          does that job now, and does it for the whole table rather than for
          the one browser. What is left of the embed is a sound source, so it
          is parked off-screen for the DM exactly as it always was for
          everybody else - removed or display:none'd, a frame can have its
          playback suspended by the browser, and silence is the one outcome
          this must not produce. */}
      <div className="music-frame">
        <div ref={hostRef} />
      </div>

      {/* No controls attribute on it: the DM's transport below is the control,
          and it moves the table rather than this one browser. Mounted always,
          playing only when the track is a file. */}
      <audio
        ref={audioRef}
        preload="auto"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          // Never while a thumb is down: the slider belongs to the finger
          // holding it until it is let go.
          if (scrub == null) setPosition(e.currentTarget.currentTime);
        }}
        onError={() => {
          if (isFile) setError('That file could not be played.');
        }}
      />

      {/* The classic three - hold it, stop it, drag it somewhere - and the two
          numbers that say where in the track the table is. The DM's alone.

          One transport for both kinds of track now. A video used to be handed
          to YouTube's own controls instead, which looked like the same thing
          and was not: those move the DM's browser, and these move the room.
          Pausing on the embed left the DM conducting a table that could still
          hear the music. */}
      {!idle && canControl && (
        <div className="music-transport">
          <button
            type="button"
            className="music-btn"
            onClick={togglePause}
            title={held ? 'Play for everyone' : 'Pause for everyone'}
            aria-label={held ? 'Play' : 'Pause'}
          >
            {held ? '▶' : '❚❚'}
          </button>
          <button
            type="button"
            className="music-btn"
            onClick={stop}
            title="Stop for everyone"
            aria-label="Stop"
          >
            ■
          </button>
          <span className="music-time">{clock(scrub ?? position)}</span>
          <input
            className="music-seek"
            type="range"
            min={0}
            max={Math.max(duration || 0, 0.1)}
            step={0.1}
            value={Math.min(scrub ?? position, duration || 0)}
            disabled={!duration}
            aria-label="Position in the track"
            onChange={(e) => {
              const seconds = Number(e.target.value);
              scrubRef.current = seconds;
              setScrub(seconds);
            }}
            // The pointer's release is caught on the window above. This is for
            // the arrow keys, which move the thumb without ever pressing it.
            onKeyUp={commitSeek}
          />
          <span className="music-time">{clock(duration)}</span>
        </div>
      )}

      {/* The DM gets the whole thing: what's playing, what went wrong, and the
          way to stop it. */}
      {!idle && canControl && (
        <div className="music-meta">
          <span className="music-title" title={playing.title}>
            ♪ {playing.title}
          </span>
          {error && <span className="music-error">{error}</span>}
          {blocked && !error && (
            <button className="music-enable" onClick={enableAudio}>
              🔊 Enable audio
            </button>
          )}
          {/* No second Stop here. There used to be one for a video, because the
              transport with the ■ on it was for uploaded files only; now every
              track has that button, and two stops on one bar is one too many. */}
        </div>
      )}

      {/* Everyone else gets nothing about *what* is playing - except, when
          their browser has actually refused to play, one button that says
          nothing about it either. That isn't a music control, it's the
          browser's consent gate: without it a blocked listener would sit in
          silence with no way out. It only appears if the retry-on-any-click
          above has already failed. */}
      {!idle && !canControl && blocked && !error && (
        <button className="music-enable" onClick={enableAudio}>
          🔊 Enable sound
        </button>
      )}

      {/* How loud it is here, for everybody at the table including the DM.
          This is the one music control a player gets, and it is theirs alone -
          it moves this browser's speakers and tells the server nothing, unlike
          every other button on this bar. Still nothing about what is playing:
          a listener learns that there is music and how loud it is, which is
          all they could act on anyway. */}
      {!idle && (
        <div className="music-volume">
          <button
            type="button"
            className="music-btn"
            onClick={toggleMute}
            title={muted ? 'Sound on, for you' : 'Silence it, for you'}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <input
            className="music-vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Volume"
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </div>
      )}
    </aside>
  );
}
