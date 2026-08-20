import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';

/**
 * "Add new track": the one door into the playlist, with the two ways in behind
 * a pair of tabs.
 *
 * It used to be a form sitting above the list, which was fine while a track
 * could only be a YouTube link. Uploading is a different act with a different
 * set of things that can go wrong - a file of the wrong sort, a file too big,
 * an allowance already spent - and none of those messages belong on a row of
 * inputs the DM is looking past to read their playlist. So it is a dialog, and
 * the playlist underneath is only a playlist again.
 *
 * The two tabs keep their own state while the dialog is open, so flicking
 * across to check something does not lose a half-typed title.
 */

// What the file tab will take. The server decides for real - it reads the first
// bytes rather than believing an extension - but a file rejected here costs
// nothing to reject, and saying so instantly beats saying so after twenty
// megabytes have gone up the DM's home connection.
const MAX_MB = 20;
const EXTENSIONS = ['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.m4b', '.mp4', '.webm', '.flac'];
const ACCEPT = `audio/*,${EXTENSIONS.join(',')}`;
const TYPES_TEXT = 'MP3, OGG, WAV, M4A, WEBM or FLAC';

const nameWithoutExtension = (name) =>
  String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

const sizeText = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/**
 * Is this a file we are willing to send?
 *
 * By extension as much as by type: browsers disagree about what to call an
 * .m4a, and several of them call an .ogg nothing at all. Anything claiming to
 * be audio is let through on that alone, and the size is the check that
 * actually matters here.
 */
function whyNot(file) {
  if (!file) return 'No file chosen.';
  const named = String(file.name || '').toLowerCase();
  const looksAudio =
    String(file.type || '').startsWith('audio/') || EXTENSIONS.some((ext) => named.endsWith(ext));
  if (!looksAudio) return `That is not a music file. Use ${TYPES_TEXT}.`;
  if (file.size > MAX_MB * 1024 * 1024) {
    return `That file is ${sizeText(file.size)}. The limit is ${MAX_MB} MB per track.`;
  }
  return '';
}

export default function AddTrackModal({ onAdded, onClose }) {
  const [tab, setTab] = useState('youtube');
  const [busy, setBusy] = useState(false);

  // The YouTube tab.
  const [url, setUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');

  // The file tab. `fileError` is the red line about the file itself and is
  // cleared by choosing another one; `error` is what the server said.
  const [file, setFile] = useState(null);
  const [fileTitle, setFileTitle] = useState('');
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);

  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Take a file the DM chose or dropped.
   *
   * A bad one is refused and kept off the form: leaving it selected would leave
   * an Upload button that cannot work sitting under an explanation of why. The
   * title comes free from the filename, and can be typed over.
   */
  function take(chosen) {
    setError('');
    const why = whyNot(chosen);
    if (why) {
      setFile(null);
      setFileError(why);
      return;
    }
    setFileError('');
    setFile(chosen);
    if (!fileTitle.trim()) setFileTitle(nameWithoutExtension(chosen.name).slice(0, 200));
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (tab === 'youtube') {
        // Not optimistic: the server decides whether the link is a video at
        // all, and - when you have not named it yourself - it is the one that
        // goes and asks YouTube for the title.
        onAdded(await api.addTrack(url, linkTitle));
      } else {
        const { track } = await api.uploadTrackFile(file, fileTitle);
        onAdded(track);
      }
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const canSubmit = tab === 'youtube' ? Boolean(url.trim()) : Boolean(file);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal add-track"
        role="dialog"
        aria-modal="true"
        aria-label="Add new track"
        onSubmit={submit}
      >
        <div className="modal-head">
          <h2>Add new track</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs">
          <button
            type="button"
            className={tab === 'youtube' ? 'active' : ''}
            onClick={() => setTab('youtube')}
          >
            YouTube
          </button>
          <button
            type="button"
            className={tab === 'file' ? 'active' : ''}
            onClick={() => setTab('file')}
          >
            File
          </button>
        </div>

        {tab === 'youtube' ? (
          <>
            <p className="hint">
              Paste a link. Name it yourself, or leave the title blank and take the one YouTube
              has.
            </p>
            <input
              autoFocus
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              placeholder="Title (optional)"
              value={linkTitle}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setLinkTitle(e.target.value)}
            />
          </>
        ) : (
          <>
            <p className="hint">
              {TYPES_TEXT}, up to {MAX_MB} MB. The file is kept on the server and counts towards
              your storage, the same allowance your maps come out of.
            </p>

            {/* Dropping is the same act as picking, so the whole panel is the
                target rather than a strip beside the button. */}
            <label
              className={`track-drop${dragging ? ' over' : ''}${fileError ? ' bad' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                take(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                type="file"
                accept={ACCEPT}
                disabled={busy}
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  e.target.value = ''; // let the same file be picked again
                  take(chosen);
                }}
              />
              {file ? (
                <span className="track-drop-file">
                  <strong>{file.name}</strong>
                  <small>{sizeText(file.size)}</small>
                </span>
              ) : (
                <span className="track-drop-empty">
                  <strong>Choose a file</strong>
                  <small>or drop one here</small>
                </span>
              )}
            </label>

            {fileError && <p className="error">{fileError}</p>}

            <input
              placeholder="Title (optional)"
              value={fileTitle}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setFileTitle(e.target.value)}
            />
          </>
        )}

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !canSubmit}>
            {busy ? (tab === 'file' ? 'Uploading…' : 'Saving…') : 'Add track'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
