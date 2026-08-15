import { useRef, useState } from 'react';
import { api } from './api.js';
import ClipboardImage from './ClipboardImage.jsx';
import CropModal from './CropModal.jsx';
import CloudPicker from './CloudPicker.jsx';

/**
 * One picture of a person: a profile picture, or a character's portrait.
 *
 * The same three ways in wherever a face is wanted - choose a file, use what you
 * have copied, or take the one that's there off again - and one place to fix
 * them. What differs between an account and a character sheet is the shape of
 * the frame and where the address ends up, and both of those are the caller's
 * business: this hands back a URL and knows nothing about what is holding it.
 *
 * Nothing is uploaded straight from the file that was picked. It goes to the
 * cropping dialog first, and what is sent is what came back from there - already
 * the right shape, and a few hundred kilobytes rather than whatever came off the
 * camera. Sent as soon as that dialog is confirmed rather than when some form is
 * submitted, so what you see is the real file at its real address; on a
 * character sheet there is no submit to wait for anyway, since the sheet saves
 * itself as you type.
 */

/**
 * The most a picked file may weigh, and the server's own answer.
 *
 * Checked here as well so a 40 MB photograph is refused in the instant it is
 * picked rather than after it has been carried across somebody's home
 * connection to be turned away. It is the *original* this applies to - what
 * leaves the cropper is far smaller - because that is the file the browser has
 * to decode to show it at all. The server is what actually enforces it: see
 * MAX_BYTES in server/routes/uploads.js, and keep the two in step.
 */
const MAX_MB = 5;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export default function PicturePicker({
  url,
  onChange,
  disabled = false,
  // Width over height of the frame this picture is drawn in. The cropper is cut
  // to the same shape, so what is saved needs no fitting afterwards.
  aspect = 1,
  cropTitle = 'Frame the picture',
  placeholder = 'No picture',
  alt = '',
  // Whether this campaign's own images are offered as a third way in. The DM's
  // alone, and it needs a campaign to be in - so the account screen, which has
  // neither, simply doesn't pass it.
  cloud = false,
  cloudPurpose = 'as this picture',
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The file waiting to be framed. Non-null is what puts the dialog on screen.
  const [cropping, setCropping] = useState(null);
  // Whether the cloud is open over this. Its own window, closed the moment
  // something is chosen from it.
  const [picking, setPicking] = useState(false);
  const fileRef = useRef(null);

  // Clearing the input matters more than it looks: without it, choosing the same
  // file again after cancelling the crop is silent, because its value never
  // changed.
  const forgetPick = () => {
    if (fileRef.current) fileRef.current.value = '';
  };

  function pick(file) {
    if (!file || busy) return;
    setError('');
    if (file.size > MAX_BYTES) {
      // Said in the units the picture was picked in. Nothing is sent.
      setError(`That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB - the limit is ${MAX_MB} MB.`);
      forgetPick();
      return;
    }
    setCropping(file);
  }

  /**
   * A picture out of the cloud, brought to the same cropping dialog.
   *
   * Fetched back into a file rather than used where it lies, and that is the
   * whole point of routing it through here: the frame is what makes a portrait
   * a portrait, and a battle map dropped into one unframed would show its
   * middle. What gets saved is the part somebody chose, a few hundred
   * kilobytes of it, exactly as when the file came off their disk.
   *
   * So it leaves a copy. That is the honest trade for the promise the cropper
   * makes, the copy is the small one, and the picture in the cloud is untouched
   * and still counts once against the allowance.
   */
  async function pickFromCloud(chosen) {
    if (!chosen || busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await fetch(chosen);
      if (!res.ok) throw new Error('That picture could not be opened.');
      const blob = await res.blob();
      const name = chosen.split('/').pop() || 'picture';
      setCropping(new File([blob], name, { type: blob.type || 'image/png' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Send what came back from the cropper and keep where it landed.
   *
   * A failure is deliberately not caught: the dialog is what called this, and
   * letting it through is what keeps that dialog open with the reason on it,
   * rather than closing as though the picture had been saved.
   */
  async function upload(cropped) {
    setBusy(true);
    try {
      const { url: stored } = await api.uploadImage(cropped, 'portrait');
      await onChange(stored);
      setCropping(null);
    } finally {
      setBusy(false);
      forgetPick();
    }
  }

  return (
    <div className="picture-picker">
      <span className="picture-frame" style={{ aspectRatio: String(aspect) }}>
        {url ? (
          <img src={url} alt={alt} />
        ) : (
          <span className="picture-empty">{placeholder}</span>
        )}
      </span>

      {/* Read-only leaves the picture and takes the controls away. A row of
          buttons that answer "no" is worse than no row at all. */}
      {!disabled && (
        <div className="picture-actions">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {/* The same act by another road: a picture already on the clipboard
              has nowhere on disk to be chosen from, and saving it out just to
              pick it up again is a step for the sake of one. It lands in the
              same cropping dialog. */}
          <ClipboardImage onImage={pick} disabled={busy} />
          {/* The third road in, for whoever keeps their pictures in this
              campaign's folders: it lands in the same cropping dialog as the
              other two, so a portrait is framed however it was found. */}
          {cloud && (
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
          <small className="picture-limit">PNG, JPEG, WEBP or GIF, up to {MAX_MB} MB.</small>
          {error && <small className="clipboard-error">{error}</small>}
        </div>
      )}

      {picking && (
        <CloudPicker
          title="Choose from my images"
          purpose={cloudPurpose}
          onPick={pickFromCloud}
          onClose={() => setPicking(false)}
        />
      )}

      {cropping && (
        <CropModal
          file={cropping}
          aspect={aspect}
          title={cropTitle}
          onDone={upload}
          onCancel={() => {
            setCropping(null);
            forgetPick();
          }}
        />
      )}
    </div>
  );
}
