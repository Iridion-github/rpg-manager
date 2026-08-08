import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';

/**
 * The campaign's playlist.
 *
 * Only a list and some buttons — the audio itself is MusicPlayer's job, and it
 * deliberately lives outside this tab so that switching to the Tabletop doesn't
 * unmount the player and stop the music mid-scene.
 *
 * Players see the list and what's playing; only the DM can add, remove, or
 * press play. It's the table's soundtrack, not a shared jukebox.
 */
export default function Music({ canControl, offline }) {
  const [tracks, setTracks] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getMusic();
      setTracks(data.tracks);
      setPlaying(data.playing);
    } catch (e) {
      if (!offline) setError(e.message);
    }
  }, [offline]);

  useEffect(() => {
    load();
    const onTracks = () => load();
    const onState = ({ playing: now }) => setPlaying(now);
    socket.on('music:tracks', onTracks);
    socket.on('music:state', onState);
    socket.on('connect', load);
    return () => {
      socket.off('music:tracks', onTracks);
      socket.off('music:state', onState);
      socket.off('connect', load);
    };
  }, [load]);

  async function guard(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const add = (e) => {
    e.preventDefault();
    return guard(async () => {
      // Not optimistic: the server decides whether the link is a video at all,
      // and — when you haven't named it yourself — it's the one that goes and
      // asks YouTube for the title.
      const record = await api.addTrack(url, title);
      setTracks((prev) => [...prev, record]);
      setUrl('');
      setTitle('');
    });
  };

  const rename = (track, next) =>
    guard(async () => {
      const updated = await api.renameTrack(track.id, next);
      setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    });

  /**
   * Put the YouTube link on the clipboard.
   *
   * The clipboard API needs a secure context, which the tunnel gives you but a
   * plain-http LAN address does not — so a refusal falls back to showing the
   * link in a prompt, where it can still be copied by hand.
   */
  async function copyLink(track) {
    try {
      await navigator.clipboard.writeText(track.url);
      setCopied(track.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt(`Link for ${track.title}:`, track.url);
    }
  }

  const play = (id) => guard(() => api.playTrack(id));
  const stop = () => guard(() => api.stopMusic());
  const remove = (id) =>
    guard(async () => {
      await api.deleteTrack(id);
      setTracks((prev) => prev.filter((t) => t.id !== id));
    });

  return (
    <div className="music-view">
      <div className="sheet-toolbar">
        <h2 className="notes-title">Music</h2>
        {playing && <span className="badge on">playing</span>}
        <div className="spacer" />
        {canControl && playing && (
          <button onClick={stop} disabled={busy}>
            ■ Stop
          </button>
        )}
      </div>

      <p className="hint">
        {canControl
          ? 'Paste a YouTube link and save it — name it yourself, or leave that blank and take the title from YouTube. Pressing play starts it for everyone at the table; they join wherever the track has got to, so nobody restarts it by arriving late.'
          : "Your DM's playlist. They choose what plays."}
      </p>

      {error && <p className="error">{error}</p>}

      {canControl && !offline && (
        <form className="new-campaign" onSubmit={add}>
          <input
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            placeholder="Title (optional)"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" disabled={busy || !url.trim()}>
            Save
          </button>
        </form>
      )}

      <ul className="track-list">
        {tracks.map((t) => {
          const isPlaying = playing?.trackId === t.id;
          return (
            <li key={t.id} className={isPlaying ? 'playing' : ''}>
              <span className="track-mark">{isPlaying ? '♪' : ''}</span>
              {canControl && !offline ? (
                // Keyed on the title so a rename from another browser resets
                // the field, which an uncontrolled input wouldn't otherwise see.
                <input
                  key={`${t.id}:${t.title}`}
                  className="track-title-input"
                  defaultValue={t.title}
                  maxLength={200}
                  disabled={busy}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    // Blank means "I didn't mean to change it" rather than a
                    // nameless track — put the old name back.
                    if (!next) return (e.target.value = t.title);
                    if (next !== t.title) rename(t, next);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              ) : (
                <span className="track-title" title={t.title}>
                  {t.title}
                </span>
              )}
              <button onClick={() => copyLink(t)} disabled={busy} title={t.url}>
                {copied === t.id ? 'Copied!' : 'Copy link'}
              </button>
              {canControl && !offline && (
                <>
                  <button onClick={() => play(t.id)} disabled={busy} title="Play for everyone">
                    ▶ Play
                  </button>
                  <button className="del" onClick={() => remove(t.id)} disabled={busy}>
                    ✕
                  </button>
                </>
              )}
            </li>
          );
        })}
        {tracks.length === 0 && (
          <li className="empty">
            {canControl ? 'No music saved yet.' : "Your DM hasn't added any music yet."}
          </li>
        )}
      </ul>
    </div>
  );
}
