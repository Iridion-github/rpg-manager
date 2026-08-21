import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';

/**
 * "This one, here?" - the step between choosing Paste token and another figure
 * appearing on the board.
 *
 * Asked rather than done, because a paste is easy to fire twice and the two
 * results look identical from across the table: the thing it makes is a token
 * that is deliberately indistinguishable from one already standing there. What
 * the dialog is really answering is *which* token is on the clipboard, which is
 * a question about something you did some minutes and several clicks ago.
 *
 * So it shows the face rather than describing it. That is how the token will be
 * recognised once it is on the map, and it is the same reasoning the bench's
 * own list follows (SpawnModal): at a table with three goblins on it, a name is
 * a worse answer than a picture.
 */
export default function PasteTokenModal({ token, name, busy, error, onConfirm, onClose }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal paste-modal" role="dialog" aria-modal="true" aria-label="Paste a token">
        <div className="modal-head">
          <h2>Paste this token?</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="paste-preview">
          <span
            className="spawn-face"
            style={{
              background: token.imageUrl
                ? `center / cover no-repeat url(${JSON.stringify(token.imageUrl)})`
                : token.color,
              ...(token.borderColor ? { borderColor: token.borderColor } : {}),
            }}
          />
          <div className="paste-who">
            {/* The name it will arrive with, not the name it was copied from:
                the number in brackets is the part somebody is about to have to
                live with, and it is the one thing a copy does not share with
                its original. */}
            <strong>{name}</strong>
            <small>copy of {token.label || 'that token'}</small>
          </div>
        </div>

        {/* Where it lands, in the same words the bench's list uses, because it
            is the same answer: the right-click already chose the square, and
            printing the numbers it chose would be a coordinate nothing else on
            the map shows. */}
        <p className="hint">
          It goes where you right-clicked. Everything else comes across unchanged: the picture,
          the size, the colours, the condition, the hit points and who it belongs to. It arrives
          as its own figure, with no character sheet attached.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? 'Pasting…' : 'Paste token'}
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
