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
 * The DM gets a transport for an uploaded track - hold it, let it go, drag it
 * to a point - where the video would be. None of those buttons touch this
 * browser's audio element directly: they ask the server to move the *table*,
 * and this player then follows the answer like every other browser does. That
 * is what keeps a scrub from desynchronising the room.
 *
 * Only the DM sees any of it. For everyone else the music is meant to be
 * scenery - they hear it and are told nothing: no video, no title, no controls.
 * The iframe still has to exist for them, so it's parked off-screen rather than
 * removed, because a frame that isn't rendered can have its playback suspended.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';

// YT.PlayerState, without needing the API loaded to name them.
const PLAYING = 1;
const BUFFERING = 3;

// How long to give the player before deciding the browser refused to start it.
const AUTOPLAY_GRACE_MS = 1500;

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
function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
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
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const audioRef = useRef(null);
  const graceTimer = useRef(null);

  // Which of the two players this track belongs to.
  const isFile = playing?.kind === 'file';
  // Held rather than running. A paused track is still "playing" as far as the
  // table is concerned - it is the track that is on, and it has a position.
  const held = playing?.pausedAt != null;

  // Deciding it started is needed in two places: once after the initial grace
  // period, and again after a retry.
  const checkStarted = useCallback(() => {
    const state = playerRef.current?.getPlayerState?.();
    setBlocked(state !== PLAYING && state !== BUFFERING);
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

  // Drive the embedded player from whatever the table is currently playing.
  // Silence for anything that isn't a YouTube track: a file playing underneath
  // a video would be two songs at once, and the reverse is just as bad.
  useEffect(() => {
    let cancelled = false;
    clearTimeout(graceTimer.current);

    if (!playing || playing.kind === 'file') {
      playerRef.current?.stopVideo?.();
      if (!playing) setBlocked(false);
      return;
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        // Where the track should be by now - this is the whole sync mechanism.
        const startSeconds = Math.max(0, (Date.now() - Date.parse(playing.startedAt)) / 1000);

        if (playerRef.current?.loadVideoById) {
          playerRef.current.loadVideoById({ videoId: playing.videoId, startSeconds });
        } else {
          playerRef.current = new YT.Player(hostRef.current, {
            width: '100%',
            height: '100%',
            videoId: playing.videoId,
            playerVars: { autoplay: 1, start: Math.floor(startSeconds), playsinline: 1 },
            events: {
              onReady: (e) => e.target.playVideo(),
              onError: (e) => setError(errorText(e.data)),
            },
          });
        }

        // Autoplay with sound needs a user gesture, and a player who hasn't
        // clicked anything yet won't get one. Rather than guess at the rules,
        // watch whether it actually started and offer a button if it didn't.
        graceTimer.current = setTimeout(checkStarted, AUTOPLAY_GRACE_MS);
      })
      .catch((e) => setError(e.message));

    return () => {
      cancelled = true;
      clearTimeout(graceTimer.current);
    };
  }, [playing?.kind, playing?.videoId, playing?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

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
   * The seek has to wait for the browser to know how long the file is, because
   * `currentTime` on a file whose metadata has not arrived yet goes nowhere.
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

    const apply = () => {
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

      if (playing.pausedAt != null) {
        el.pause();
        setBlocked(false);
        return;
      }
      // Unlike the iframe, this says outright whether it was allowed to start,
      // so there is no grace period to sit through.
      el.play().then(
        () => setBlocked(false),
        () => setBlocked(true)
      );
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

    if (el.readyState >= 1) apply(); // metadata already in hand
    else el.addEventListener('loadedmetadata', apply, { once: true });

    return () => {
      cancelled = true;
      el.removeEventListener('loadedmetadata', apply);
    };
  }, [playing?.kind, playing?.url, playing?.startedAt, playing?.pausedAt]);

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
      <div className={`music-frame${isFile ? ' file' : ''}`}>
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

      {/* Where the video would be, for a track that has no video: the classic
          three - hold it, stop it, drag it somewhere - and the two numbers that
          say where in the track the table is. The DM's alone, like the frame it
          stands in for. */}
      {!idle && canControl && isFile && (
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
          {/* The transport has its own ■ when there is one, and two stops on
              one bar is one stop too many. */}
          {!isFile && (
            <button className="linky" onClick={stop}>
              Stop for everyone
            </button>
          )}
        </div>
      )}

      {/* Everyone else gets nothing - except, when their browser has actually
          refused to play, one button that says nothing about what's playing.
          That isn't a music control, it's the browser's consent gate: without
          it a blocked player would sit in silence with no way out of it. It
          only appears if the retry-on-any-click above has already failed. */}
      {!idle && !canControl && blocked && !error && (
        <button className="music-enable" onClick={enableAudio}>
          🔊 Enable sound
        </button>
      )}
    </aside>
  );
}
