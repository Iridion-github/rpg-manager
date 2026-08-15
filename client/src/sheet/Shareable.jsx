import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Sharing mode: the sheet stops being something you fill in and becomes
 * something you point at.
 *
 * Every part of the sheet worth quoting is wrapped in one of these. Out of the
 * mode it is nothing at all - `display: contents`, so the wrapper is not in the
 * layout and the sheet is laid out exactly as it was written. In the mode it
 * lights up, takes the click, and hands its caller what that part of the sheet
 * says.
 *
 * The click is taken from the whole region rather than from the controls inside
 * it, and the controls are made deaf to the pointer while the mode is on (see
 * the CSS). That is what makes "click anything with data on it" true: a
 * disabled input swallows mouse events and would otherwise be a hole in the
 * middle of a section you are trying to click.
 *
 * Regions may sit inside other regions - a row inside its section - and the
 * inner one wins, because the click stops where it lands. Sharing one attack
 * and sharing the whole list are both reasonable things to want, and this is
 * how you get to ask for either without a second control saying which.
 */
export default function Shareable({ sharing, share, onPick, children, label, className = '' }) {
  const props = shareProps({ sharing, share, onPick, label });
  if (!props) return children;
  // `className` is for the handful of regions whose wrapper has to take a
  // layout rule from the cell it replaces - see the identity grid, where the
  // name spans every column.
  return <div {...props} className={`${props.className} ${className}`.trim()}>{children}</div>;
}

/**
 * The same behaviour as props, for the places a wrapper cannot go.
 *
 * A table row is the case that forces this to exist: a div around a `<tr>` is
 * invalid markup and the browser quietly lifts the row out of the table, which
 * takes the row's own layout with it. Those elements wear the class and the
 * handler themselves instead. Anything with a className or onClick of its own
 * should use the wrapper rather than this, since spreading would overwrite them.
 */
export function shareProps({ sharing, share, onPick, label }) {
  if (!sharing || !share) return null;

  const pick = (e) => {
    e.preventDefault();
    // The click stops here, so a row inside a section shares the row rather
    // than the section around it.
    e.stopPropagation();
    onPick(share);
  };

  return {
    className: 'shareable',
    role: 'button',
    tabIndex: 0,
    'aria-label': label || `Share ${share.title}`,
    onClick: pick,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') pick(e);
    },
  };
}

/**
 * What is about to be said, before it is said.
 *
 * The preview is the message itself rather than a description of it - the same
 * heading and the same lines the chat will draw - because the question somebody
 * has at this moment is "is this the bit I meant", and only the thing itself
 * answers that.
 */
export function SharePreviewModal({ share, busy, error, onCancel, onSend }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal share-modal" role="dialog" aria-modal="true" aria-label="Send to chat">
        <div className="modal-head">
          <h2>Send to chat?</h2>
          <button type="button" className="linky" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="chat-excerpt share-preview">
          <strong>{share.title}</strong>
          <p>{share.text}</p>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onSend} disabled={busy} autoFocus>
            {busy ? 'Sending…' : 'Send to chat'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
