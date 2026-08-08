import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';

/**
 * The thing that actually makes noise.
 *
 * It lives in App, beside the chat, and *not* in the Music tab — a component
 * unmounts when you switch tabs, and an unmounted player is silence. So the tab
 * is only a list of buttons; this is what plays.
 *
 * No audio crosses the wire. The server broadcasts "this video, started at this
 * moment" and each browser plays its own copy, seeking to how far in the track
 * should be by now. That's what lets someone arriving late join a track already
 * running, and it's why sync is within a second rather than exact.
 *
 * Only the DM sees any of it. For everyone else the music is meant to be
 * scenery — they hear it and are told nothing: no video, no title, no controls.
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
    // The host PC is the server, so if it's off you're offline anyway — but
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

export default function MusicPlayer({ canControl }) {
  const [playing, setPlaying] = useState(null);
  const [blocked, setBlocked] = useState(false); // browser refused to autoplay
  const [error, setError] = useState('');
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const graceTimer = useRef(null);

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
  useEffect(() => {
    let cancelled = false;
    clearTimeout(graceTimer.current);

    if (!playing) {
      playerRef.current?.stopVideo?.();
      setBlocked(false);
      return;
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        // Where the track should be by now — this is the whole sync mechanism.
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
  }, [playing?.videoId, playing?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * If the browser refused to start, try again the moment the user touches
   * anything at all.
   *
   * Any click or keypress is the gesture autoplay was waiting for, and it need
   * not be aimed at the music — switching tabs or typing in the chat will do.
   * This is what keeps the players' experience contentless: most of them get
   * sound without ever being shown a button, because they were going to click
   * something anyway.
   */
  useEffect(() => {
    if (!blocked) return;
    const retry = () => {
      playerRef.current?.playVideo?.();
      setTimeout(checkStarted, 800); // did it actually take?
    };
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
    return () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
    };
  }, [blocked, checkStarted]);

  useEffect(
    () => () => {
      clearTimeout(graceTimer.current);
      playerRef.current?.destroy?.();
      playerRef.current = null;
    },
    []
  );

  // The click that unblocks it is itself the gesture the browser was waiting
  // for, so playing from here always works.
  function enableAudio() {
    playerRef.current?.playVideo?.();
    setBlocked(false);
  }

  const stop = () => api.stopMusic().catch((e) => setError(e.message));

  // Nothing playing: keep the iframe mounted but out of the way, so the next
  // play command doesn't have to build a player from scratch.
  const idle = !playing;

  return (
    <aside className={`music-bar${idle ? ' idle' : ''}${canControl ? '' : ' hidden'}`}>
      <div className="music-frame">
        <div ref={hostRef} />
      </div>

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
          <button className="linky" onClick={stop}>
            Stop for everyone
          </button>
        </div>
      )}

      {/* Everyone else gets nothing — except, when their browser has actually
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
