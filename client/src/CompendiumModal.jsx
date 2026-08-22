import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';
import Compendium from './Compendium.jsx';

/**
 * The compendium, opened over whatever sent you to it.
 *
 * Fixed rather than floating, and with no minimise: this is an errand, not a
 * panel. You came here to fetch one thing and go back to the row you were
 * filling in, and a window you can shrink and leave lying about is for work
 * that lasts longer than that. Closing it, by the cross or by Escape or by the
 * space around it, is always available and always means "never mind".
 *
 * Eighty percent of the screen because the thing inside it is a shelf: the
 * categories alone are five rows of buttons at a comfortable width, and a
 * hundred and seventy-seven wondrous items want somewhere to be listed.
 */
export default function CompendiumModal({
  title = 'Compendium',
  only = null,
  useLabel = 'Use as template',
  onUse,
  onClose,
}) {
  // Where a dialog goes: the page, or the window a sheet was popped out into.
  const portalTarget = usePortalTarget();

  useEffect(() => {
    const onKey = (e) => {
      // Only this one. The sheet underneath keeps its own Escape, and the top
      // dialog is the one being dismissed.
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop compendium-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal compendium-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="compendium-body">
          {/* Taking one closes the window. Fetching the one thing is the whole
              errand, so leaving it open afterwards would only ask to be
              dismissed a second time. */}
          <Compendium
            only={only}
            useLabel={useLabel}
            onUse={(node) => {
              onUse(node);
              onClose();
            }}
          />
        </div>
      </div>
    </div>,
    portalTarget
  );
}
