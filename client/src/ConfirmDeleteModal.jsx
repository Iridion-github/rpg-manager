import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * "Delete Kira?" - the step between clicking a delete button and the thing
 * ceasing to exist for everyone at the table.
 *
 * `byName` asks for the name to be typed instead of offering a plain yes/no.
 * That's for deletions worth slowing down: a character sheet is not undoable
 * and not private - it takes the sheet away from the player whose character it
 * is - and with several windows open the mistake to guard against is deleting
 * the *wrong* one. Copying out a name can't be done by reflex. A note is the
 * DM's own and cheaper to lose, so it just asks.
 */
export default function ConfirmDeleteModal({
  name,
  description,
  byName = false,
  confirmLabel = 'Confirm deletion',
  // Not everything this asks about is being destroyed - removing someone from a
  // campaign leaves the person untouched - so the heading can be overridden
  // rather than promising a deletion that isn't going to happen.
  title,
  onConfirm,
  onClose,
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Trimmed, because a stray space either side is a typo and not a different
  // answer. Case is left alone: it's the one part of "type this name" that
  // keeps the check from being a formality.
  const matches = !byName || typed.trim() === name;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function confirm(e) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      // Stay open and say what happened - closing on a failed delete would
      // report success for something that didn't happen.
      setError(err.message);
      setBusy(false);
    }
  }

  // Into <body> for the same reason as the dice dialogs: this is opened from
  // inside the floating sheet window, which is a query container, and layout
  // containment would otherwise pin a fixed backdrop inside it.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal confirm-delete"
        role="dialog"
        aria-modal="true"
        aria-label={title || `Delete ${name}`}
        onSubmit={confirm}
      >
        <div className="modal-head">
          <h2>{title || `Delete ${name}?`}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="hint">{description}</p>

        {byName && (
          <label className="confirm-field">
            <span>
              Type <strong>{name}</strong> to confirm
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={name}
              // The name is the confirmation; letting a manager fill it in would
              // hand back exactly the reflex this is here to interrupt.
              autoComplete="off"
              spellCheck="false"
            />
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="del" disabled={!matches || busy} autoFocus={!byName}>
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
