import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import ImageCloud from './ImageCloud.jsx';

/**
 * "Which picture?" - your own folders, wherever a picture is being chosen.
 *
 * The cloud arrived attached to the one thing that needed it, the scene's
 * background, and a store of images that only one screen can reach is half a
 * store: the map you uploaded for the crypt is the picture you want on the
 * token standing in it. So the browser is the same component in a smaller
 * window, opened from the token form, from a character's portrait, and from
 * anywhere else a picture is set.
 *
 * The whole browser rather than a read-only grid, deliberately. Somebody
 * choosing a token's face who finds they have not uploaded it yet should be
 * able to upload it *here*, into the folder they are looking at, rather than
 * closing two dialogs to go and put it somewhere first.
 *
 * The DM's alone, like everything else about the cloud, and the caller decides
 * that: this is only ever rendered where the answer is already known.
 */
export default function CloudPicker({ title = 'Choose a picture', purpose, currentUrl, onPick, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      // Only this one. Anything under it - the form that opened this - keeps
      // its own Escape, and the top dialog is the one being dismissed.
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
      className="modal-backdrop cloud-picker-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal cloud-picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Choosing closes it. Picking a picture is the whole errand, so
            leaving the window open afterwards would only ask to be dismissed a
            second time. */}
        <ImageCloud
          onUse={(url) => {
            onPick(url);
            onClose();
          }}
          useLabel="Choose"
          purpose={purpose}
          currentUrl={currentUrl}
        />
      </div>
    </div>,
    document.body
  );
}
