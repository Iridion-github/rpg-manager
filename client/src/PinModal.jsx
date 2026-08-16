import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RichTextEditor } from './RichTextLazy.jsx';
import SharePanel from './SharePanel.jsx';

/**
 * "What does this pin say?" - the step between choosing Create pin on the map
 * and something appearing there, and the same form again for changing one.
 *
 * The spot isn't asked for and isn't shown as a field: it was decided by where
 * the right-click landed, down to the pixel, and offering coordinates to type
 * would be a worse way of saying the same thing. Everything here is what the
 * map cannot tell us - what it is called, what it looks like, what it says, and
 * who else may read it.
 *
 * Pass `pin` to change one; leave it out for a new one at `at`.
 */

// What a new pin is before anybody chooses otherwise. A red head, because that
// is the colour of a pin in every map anybody has ever been handed, and the
// card's own dark paper, which is the colour the rest of the app is written on.
const DEFAULT_COLOR = '#e5534b';
const DEFAULT_BACKGROUND = '#161b22';

const MAX_TITLE = 80; // the server's own limit; see sanitizePin

export default function PinModal({ pin, at, players = [], actor, onSubmit, onClose }) {
  const [title, setTitle] = useState(pin?.title || '');
  const [color, setColor] = useState(pin?.color || DEFAULT_COLOR);
  const [background, setBackground] = useState(pin?.background || DEFAULT_BACKGROUND);
  // The document as it stands. Held here rather than in the editor because the
  // editor is uncontrolled - it reports changes and never takes them back. Null
  // until either the pin had one or somebody types: an untouched box is a pin
  // with nothing written on it, which is what the server stores it as.
  const [content, setContent] = useState(pin?.content || null);
  const [visibility, setVisibility] = useState(pin?.visibility || 'private');
  const [sharedWith, setSharedWith] = useState(pin?.sharedWith || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        // A pin with no title still needs something under it on the map, and
        // "Pin" is what the server would fall back to anyway.
        title: title.trim() || 'Pin',
        color,
        background,
        content,
        visibility,
        sharedWith,
        // Only for a new one. An existing pin keeps the spot it was stuck in:
        // this form is about what it says, not about where it is.
        ...(pin ? {} : { x: at?.x ?? 0, y: at?.y ?? 0 }),
      });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Only a press on the backdrop itself. A drag that began inside the
        // form and ended out here is somebody selecting text, not somebody
        // throwing away everything they have written.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal pin-form" role="dialog" aria-modal="true" onSubmit={submit}>
        <div className="modal-head">
          <h2>{pin ? 'Edit pin' : 'New pin'}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="pin-field">
          <span>Title</span>
          <input
            autoFocus
            value={title}
            maxLength={MAX_TITLE}
            placeholder="The well in the square"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        {/* Side by side, because they are one decision made twice: what this
            pin looks like shut, and what it looks like open. */}
        <div className="pin-colors">
          <label className="pin-field pin-swatch">
            <span>Pin colour</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="pin-field pin-swatch">
            <span>Background</span>
            <input
              type="color"
              value={background}
              onChange={(e) => setBackground(e.target.value)}
            />
          </label>
        </div>

        <div className="pin-field pin-content">
          <span>Content</span>
          <RichTextEditor value={pin?.content} onChange={setContent} disabled={busy} />
        </div>

        <SharePanel
          name={`pin-share-${pin?.id || 'new'}`}
          visibility={visibility}
          sharedWith={sharedWith}
          players={players}
          actor={actor}
          onShare={(next) => {
            setVisibility(next.visibility);
            setSharedWith(next.sharedWith);
          }}
          footer="Whoever you share it with can read the pin and nothing more - a pin is only ever changed or taken down by the person who stuck it in. Change your mind later and it disappears from their map at once, even if they have it open."
        />

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : pin ? 'Save pin' : 'Create pin'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
