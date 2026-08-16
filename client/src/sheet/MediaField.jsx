import { useRef, useState } from 'react';
import { api } from '../api.js';
import ClipboardImage from '../ClipboardImage.jsx';
import CloudPicker from '../CloudPicker.jsx';

/**
 * A picture on one row of the sheet: what an attack looks like when it lands,
 * what a piece of kit looks like, what the armour looks like.
 *
 * One component for all three, for the reason ItemList gives about the lists
 * themselves: they differ only in whether an animation belongs there, and two
 * copies of this would be two places to fix the next thing an upload has to
 * cope with.
 *
 * Deliberately *not* the portrait picker. That one sends every picture through
 * the cropping dialog, which draws the image onto a canvas - and a canvas keeps
 * one frame. A GIF taken through it would arrive as a still of whatever moment
 * happened to be first, which is the one thing an attack's picture exists to
 * avoid. So the file goes up as it is, and what keeps it small is the thumbnail
 * here rather than a resize on the way in.
 *
 * The same three roads in as everywhere else pictures are accepted: a file, the
 * clipboard, and - for the DM, whose folders they are - this campaign's own
 * images.
 */

/**
 * The most a picture may weigh, and which door it goes through.
 *
 * The portrait door, at five megabytes rather than the map's twenty: an
 * attack's picture is something the whole table downloads every time somebody
 * swings, and an animation is heavier than it looks. Checked here as well as on
 * the server so an enormous file is refused in the instant it is picked. See
 * MAX_BYTES in server/imageStore.js.
 */
const MAX_MB = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const STILLS = ['image/png', 'image/jpeg', 'image/webp'];
const ANIMATED = 'image/gif';

/**
 * A picture on a row: a thumbnail, and the three ways to change it.
 *
 * `animation` is whether a GIF belongs here. An attack is a moment - a swing, a
 * bolt landing - and moves; a rope in a bag does not, and a list of kit where
 * every third row is playing to itself is a list nobody can read. So the file
 * picker offers what the row accepts, and a GIF picked anyway is refused with a
 * reason rather than quietly stored.
 */
export default function MediaField({
  url,
  alt,
  readOnly,
  canCloud,
  onChange,
  animation = false,
  hint,
  className = '',
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const fileRef = useRef(null);

  const accept = [...STILLS, ...(animation ? [ANIMATED] : [])].join(',');

  // Without this, choosing the same file again after a failure is silent: its
  // value never changed.
  const forgetPick = () => {
    if (fileRef.current) fileRef.current.value = '';
  };

  async function upload(file) {
    if (!file || busy) return;
    setError('');
    if (!animation && file.type === ANIMATED) {
      setError('This one takes a still picture - a GIF would only sit here playing to itself.');
      forgetPick();
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_MB} MB.`);
      forgetPick();
      return;
    }
    setBusy(true);
    try {
      const { url: stored } = await api.uploadImage(file, 'portrait');
      onChange(stored);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      forgetPick();
    }
  }

  /**
   * A picture already in the cloud is used where it lies.
   *
   * Nothing about it needs changing - unlike a portrait, which is framed on the
   * way past - so this takes the address rather than fetching the bytes back to
   * send them again. Which means the only thing left to check is the one the
   * file picker checks: the extension, since that is all an address says about
   * what it points at.
   */
  function useFromCloud(chosen) {
    setPicking(false);
    if (!chosen) return;
    if (!animation && /\.gif($|\?)/i.test(chosen)) {
      setError('This one takes a still picture - a GIF would only sit here playing to itself.');
      return;
    }
    setError('');
    onChange(chosen);
  }

  // Nothing to show and nothing to be done about it: a read-only sheet with no
  // picture on this row draws no strip at all rather than an empty frame.
  if (readOnly && !url) return null;

  return (
    <div className={`row-media ${className}`.trim()}>
      {url ? (
        <img className="row-media-thumb" src={url} alt={alt || 'Picture'} />
      ) : (
        <span className="row-media-thumb empty" aria-hidden="true">
          {animation ? '⚔' : '▣'}
        </span>
      )}

      {readOnly ? (
        <small className="hint">{hint}</small>
      ) : (
        <div className="row-media-actions">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            disabled={busy}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          {/* The same act by another road, as everywhere else a picture is
              accepted: one you have copied has nowhere on disk to be picked
              from. */}
          <ClipboardImage onImage={upload} disabled={busy} />
          {canCloud && (
            <button type="button" className="linky" disabled={busy} onClick={() => setPicking(true)}>
              My images
            </button>
          )}
          {url && !busy && (
            <button type="button" className="linky" onClick={() => onChange('')}>
              Remove
            </button>
          )}
          {busy && <small>Uploading…</small>}
          {/* One short line: the strip sits inside a sheet, and a paragraph of
              guidance under every row would be more of the section than the
              rows are. */}
          <small className="row-media-hint">
            PNG, JPEG{animation ? ', WEBP or GIF' : ' or WEBP'}, up to {MAX_MB} MB{hint ? ` - ${hint}` : ''}
          </small>
          {error && <small className="clipboard-error">{error}</small>}
        </div>
      )}

      {picking && (
        <CloudPicker
          title="Choose from my images"
          purpose="for this row"
          onPick={useFromCloud}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
