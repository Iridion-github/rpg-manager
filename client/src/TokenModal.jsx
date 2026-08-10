import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import TokenLibrary from './TokenLibrary.jsx';

/**
 * "What token?" — the step between choosing Create token on the map and a
 * token appearing there, and the same form again for editing one.
 *
 * The position isn't asked for and isn't shown as a field: it's already been
 * decided by where the right-click happened, or by where the token already
 * stands. Offering coordinates to type would be a worse way to say the same
 * thing. Everything here is what the map can't tell us — what it's called, what
 * it looks like, how much room it takes.
 *
 * Pass `token` to edit it; leave it out to create a new one.
 */

// Cells. The server clamps to the same range (routes/scenes.js sanitizeToken),
// so a value outside it can't be saved and shouldn't be offered.
const SIZE_MIN = 0.5;
const SIZE_MAX = 10;

// What the stylesheet draws when no border colour has been chosen. Offered as
// the starting point when someone turns the ring on, so the first thing they
// see is roughly what was already there.
const DEFAULT_BORDER = '#0d1017';

// An untouched stat field is null, not zero. The server reads it the same way.
const blankToNull = (v) => (String(v).trim() === '' ? null : Number(v));

export default function TokenModal({ token, onSubmit, onClose }) {
  const editing = Boolean(token);
  const [label, setLabel] = useState(token?.label ?? 'NPC');
  const [color, setColor] = useState(token?.color ?? '#e5534b');
  // Null is a real value here, not a missing one: it means "leave the ring as
  // the stylesheet draws it" rather than any particular colour.
  const [borderColor, setBorderColor] = useState(token?.borderColor ?? null);
  const [imageUrl, setImageUrl] = useState(token?.imageUrl ?? '');
  const [size, setSize] = useState(token?.size ?? 1);
  // Kept as the strings the inputs hold rather than as numbers: blank is a
  // meaningful answer here — "not tracking this" — and Number('') is 0, which
  // would quietly turn an empty box into a token with no hit points left.
  const [initiative, setInitiative] = useState(token?.initiative ?? '');
  const [hp, setHp] = useState(token?.hp ?? '');
  const [maxHp, setMaxHp] = useState(token?.maxHp ?? '');
  const [uploading, setUploading] = useState(false);
  // Whether the library is open over this form. One at a time: the browser is
  // the whole dialog while it's up, because a grid of tokens needs the room.
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Escape closes the thing in front. With the library open that's the
      // library — losing a half-filled form because you were done browsing
      // would be a poor trade.
      if (browsing) setBrowsing(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, browsing]);

  /**
   * Put the chosen file on the server and keep the URL it comes back with.
   *
   * Uploaded on pick rather than on save, so the preview below is the real
   * image at its real address — not a blob URL that would have to be swapped
   * for the true one later. The cost is an orphaned file if the form is then
   * cancelled, which is a few kilobytes on the host's own disk.
   */
  async function pickImage(file) {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const { url } = await api.uploadImage(file);
      setImageUrl(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      // Clear the input, or choosing the same file twice in a row is silent.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy || uploading) return;
    setBusy(true);
    setError('');
    try {
      // An unnamed token is still a token — fall back rather than refuse, since
      // the name is the least important thing about a blob you're about to drag
      // somewhere. It's still worth having with a picture on: it's what the
      // tooltip says, and what the chat calls it.
      await onSubmit({
        label: label.trim() || 'Token',
        color,
        borderColor,
        size,
        imageUrl,
        initiative: blankToNull(initiative),
        hp: blankToNull(hp),
        maxHp: blankToNull(maxHp),
      });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal token-form"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit token' : 'Create token'}
        onSubmit={submit}
      >
        <div className="modal-head">
          <h2>{editing ? 'Edit token' : 'Create token'}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="token-field">
          Name
          <input
            autoFocus
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="NPC"
          />
        </label>

        {/* Left blank on the tokens nobody rolls for — scenery, a door, a pile
            of crates. An empty stat prints no line in the tooltip at all. */}
        <label className="token-field">
          Initiative
          <span className="token-stat">
            <input
              type="number"
              value={initiative}
              onChange={(e) => setInitiative(e.target.value)}
              placeholder="—"
            />
          </span>
        </label>

        {/* Two controls, so not a <label>: it can only speak for the first. */}
        <div className="token-field">
          <span>Hit points</span>
          <span className="token-stat">
            <input
              type="number"
              min={0}
              value={hp}
              onChange={(e) => setHp(e.target.value)}
              placeholder="—"
              aria-label="Current hit points"
            />
            <small>out of</small>
            <input
              type="number"
              min={0}
              value={maxHp}
              onChange={(e) => setMaxHp(e.target.value)}
              placeholder="—"
              aria-label="Total hit points"
            />
          </span>
        </div>

        <label className="token-field">
          Colour
          <span className="token-colour">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <code>{color}</code>
          </span>
        </label>

        {/* Not a label: the checkbox and the colour well are two controls, and
            one label can only speak for the first of them. */}
        <div className="token-field">
          <span>Border</span>
          <span className="token-colour">
            <input
              type="checkbox"
              checked={borderColor !== null}
              onChange={(e) => setBorderColor(e.target.checked ? DEFAULT_BORDER : null)}
              aria-label="Give this token a coloured border"
            />
            {borderColor === null ? (
              <small>Default dark ring</small>
            ) : (
              <>
                <input
                  type="color"
                  value={borderColor}
                  aria-label="Border colour"
                  onChange={(e) => setBorderColor(e.target.value)}
                />
                <code>{borderColor}</code>
              </>
            )}
          </span>
        </div>

        {/* Two ways to the same field. The library is offered first because it
            is the answer almost every time — a couple of thousand pictures are
            already here, and uploading is for the one your table needs that
            isn't. */}
        <div className="token-field">
          <span>Picture</span>
          <span className="token-image">
            <button type="button" onClick={() => setBrowsing(true)}>
              Choose from library
            </button>
            {uploading && <small>Uploading…</small>}
            {/* Removing it puts the name back — the picture stands in for the
                name rather than sitting alongside it. */}
            {imageUrl && !uploading && (
              <button type="button" className="linky" onClick={() => setImageUrl('')}>
                Remove
              </button>
            )}
          </span>
        </div>

        <div className="token-field">
          <span>Or upload</span>
          <span className="token-image">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={uploading}
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
          </span>
        </div>

        {/* The three appearance choices only mean something together, so show
            the token itself rather than asking anyone to picture it. */}
        <div className="token-field">
          <span>Preview</span>
          <span
            className="token-preview"
            style={{
              background: imageUrl ? `center / cover no-repeat url(${JSON.stringify(imageUrl)})` : color,
              ...(borderColor ? { borderColor } : {}),
            }}
          >
            {!imageUrl && <span className="token-label">{label.trim() || 'Token'}</span>}
          </span>
        </div>

        <label className="token-field">
          Size
          <span className="token-size">
            <input
              type="range"
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={0.5}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            {/* In cells, because that's the unit the map is measured in — "2"
                means it covers two squares across, not two of anything else. */}
            <small>{size} {size === 1 ? 'cell' : 'cells'} across</small>
          </span>
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || uploading}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>

    {/* A sibling of the form rather than a child of it: a dialog nested inside
        a <form> would be markup that only accidentally works, and this needs
        the whole screen anyway. */}
    {browsing && (
      <div
        className="modal-backdrop token-picker-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setBrowsing(false);
        }}
      >
        <div className="modal token-picker" role="dialog" aria-modal="true" aria-label="Choose a token picture">
          <div className="modal-head">
            <h2>Choose a picture</h2>
            <button type="button" className="linky" onClick={() => setBrowsing(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <TokenLibrary
            selectedUrl={imageUrl}
            onPick={(file) => {
              setImageUrl(file.url);
              setBrowsing(false);
            }}
          />
        </div>
      </div>
    )}
    </>
  );
}
