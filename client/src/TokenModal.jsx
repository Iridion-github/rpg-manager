import { useEffect, useState } from 'react';

/**
 * "What token?" — the step between choosing Create token on the map and a
 * token appearing there, and the same form again for editing one.
 *
 * The position isn't asked for and isn't shown as a field: it's already been
 * decided by where the right-click happened, or by where the token already
 * stands. Offering coordinates to type would be a worse way to say the same
 * thing. Everything here is what the map can't tell us — what it's called, what
 * colour it is, how much room it takes.
 *
 * Pass `token` to edit it; leave it out to create a new one.
 */

// Cells. The server clamps to the same range (routes/scenes.js sanitizeToken),
// so a value outside it can't be saved and shouldn't be offered.
const SIZE_MIN = 0.5;
const SIZE_MAX = 10;

export default function TokenModal({ token, onSubmit, onClose }) {
  const editing = Boolean(token);
  const [label, setLabel] = useState(token?.label ?? 'NPC');
  const [color, setColor] = useState(token?.color ?? '#e5534b');
  const [size, setSize] = useState(token?.size ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // An unnamed token is still a token — fall back rather than refuse, since
      // the name is the least important thing about a blob you're about to drag
      // somewhere.
      await onSubmit({ label: label.trim() || 'Token', color, size });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal"
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

        <label className="token-field">
          Colour
          <span className="token-colour">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <code>{color}</code>
          </span>
        </label>

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
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
