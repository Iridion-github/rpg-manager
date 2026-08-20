import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { socket } from './socket.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.jsx';
import AddTrackModal from './AddTrackModal.jsx';

/**
 * The campaign's playlist.
 *
 * Only a list and some buttons - the audio itself is MusicPlayer's job, and it
 * deliberately lives outside this tab so that switching to the Tabletop doesn't
 * unmount the player and stop the music mid-scene.
 *
 * Players see the list and what's playing; only the DM can add, remove, or
 * press play. It's the table's soundtrack, not a shared jukebox.
 *
 * A track is either a YouTube link or a file the DM uploaded. The difference
 * shows up in exactly two places here - the badge on the row, and what the
 * confirmation says is about to happen - because everywhere else the two are
 * the same thing: a name with a play button beside it.
 */
export default function Music({ canControl, offline }) {
  const [tracks, setTracks] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  // Whether the Add new track dialog is up.
  const [adding, setAdding] = useState(false);
  // The track a confirmation dialog is currently asking about.
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

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

  const rename = (track, next) =>
    guard(async () => {
      const updated = await api.renameTrack(track.id, next);
      setTracks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    });

  /**
   * Put the track's link on the clipboard.
   *
   * An uploaded file's URL is stored relative to this server, so it is made
   * absolute on the way out: what people do with a copied link is paste it
   * somewhere else, where /uploads/... means nothing.
   *
   * The clipboard API needs a secure context, which the tunnel gives you but a
   * plain-http LAN address does not - so a refusal falls back to showing the
   * link in a prompt, where it can still be copied by hand.
   */
  async function copyLink(track) {
    const link = new URL(track.url, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(track.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt(`Link for ${track.title}:`, link);
    }
  }

  // Resolved from the live list rather than captured when the dialog opened, so
  // a track that vanished in the meantime can't be asked about.
  const confirmTrack = tracks.find((t) => t.id === confirmDeleteId) || null;

  const play = (id) => guard(() => api.playTrack(id));
  const stop = () => guard(() => api.stopMusic());
  // Thrown as well as shown, so the confirmation dialog that called this stays
  // open on a failure rather than closing as though the track had gone.
  async function remove(id) {
    setError('');
    try {
      await api.deleteTrack(id);
      setTracks((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }

  return (
    <div className="music-view">
      <div className="sheet-toolbar">
        <h2 className="notes-title">Music</h2>
        {playing && (
          <span className={`badge${playing.pausedAt == null ? ' on' : ''}`}>
            {playing.pausedAt == null ? 'playing' : 'paused'}
          </span>
        )}
        <div className="spacer" />
        {canControl && playing && (
          <button onClick={stop} disabled={busy}>
            ■ Stop
          </button>
        )}
      </div>

      <p className="hint">
        {canControl
          ? 'Add a YouTube link or a music file of your own. Pressing play starts it for everyone at the table; they join wherever the track has got to, so nobody restarts it by arriving late.'
          : "Your DM's playlist. They choose what plays."}
      </p>

      {error && <p className="error">{error}</p>}

      {/* Above the list and hard left, where the thing it adds to begins. It
          used to sit in the toolbar beside Stop, which put the button you press
          often at the far end of the row from everything it affects. */}
      {canControl && !offline && (
        <button className="add-track-btn" onClick={() => setAdding(true)} disabled={busy}>
          + Add new track
        </button>
      )}

      <ul className="track-list">
        {tracks.map((t) => {
          const isPlaying = playing?.trackId === t.id;
          const isFile = t.kind === 'file';
          return (
            <li key={t.id} className={isPlaying ? 'playing' : ''}>
              <span className="track-mark">{isPlaying ? '♪' : ''}</span>
              {/* Where the sound comes from, in one word. It changes what
                  removing the track does, so it is worth being able to see
                  without opening anything. */}
              <span className={`track-kind${isFile ? ' file' : ''}`}>
                {isFile ? 'file' : 'YouTube'}
              </span>
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
                    // nameless track - put the old name back.
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
                  <button
                    className="del"
                    onClick={() => setConfirmDeleteId(t.id)}
                    disabled={busy}
                    title={`Remove ${t.title}`}
                  >
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

      {/* Just asks, for a link: a track is a title and a URL, and adding it
          back is a paste. An uploaded file is a different matter - the audio
          goes with the entry - so the dialog says which of the two this is. */}
      {confirmTrack && (
        <ConfirmDeleteModal
          name={confirmTrack.title || 'this track'}
          description={
            confirmTrack.kind === 'file'
              ? "This takes the track off the playlist and deletes the file from the server, giving you the space back. You'd have to upload it again."
              : "This takes the track off the campaign's playlist for everyone. The music itself isn't yours to delete - only the link to it."
          }
          confirmLabel="Remove track"
          onConfirm={() => remove(confirmTrack.id)}
          onClose={() => setConfirmDeleteId('')}
        />
      )}

      {/* Added straight into the list rather than by reloading it: the server
          has just answered with the record, and the socket's own nudge is on
          its way to everybody else. */}
      {adding && (
        <AddTrackModal
          onAdded={(record) => setTracks((prev) => [...prev, record])}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
