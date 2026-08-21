import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PortalTargetProvider } from './portalTarget.js';

/**
 * A real browser window, with part of this app's React tree inside it.
 *
 * For the second monitor: a character sheet that stays open beside the map
 * rather than on top of it. What goes in is not a copy and not a reload - it is
 * the same components, still mounted, still holding their own state, still on
 * the same socket. Only their DOM is somewhere else. Close the window and they
 * come back to the page mid-sentence, with whatever was half-typed in them
 * still half-typed.
 *
 * ## What has to be carried across, and what does not
 *
 * **Styles do.** A window opened with about:blank has none, so every stylesheet
 * and every inline <style> in the page's head is cloned into it. Cloned rather
 * than shared, because a document can only have its own; that also means a
 * stylesheet swapped out at runtime would not reach a window already open,
 * which in a built app never happens.
 *
 * **Events do not, mostly.** React attaches its listeners to the container a
 * portal renders into, so clicks and typing inside this window reach the
 * components in the ordinary way with nothing special done about it. What does
 * not arrive is anything listening on `document` - and this app's dialogs all
 * close on Escape that way. Rather than teach twenty components which document
 * they are in, that one key is forwarded; see `onKey` below for why it is that
 * one and not the rest.
 *
 * **Popup blockers** stop `window.open` unless a click asked for it. Every
 * caller of this opens it from a button, which is enough - but it can still be
 * refused outright by a setting, and `onClose('blocked')` says so rather than
 * leaving a window that silently never appears.
 */
export default function PopoutWindow({ title, width, height, onClose, children }) {
  // The element inside the popup that everything is drawn into. Null until the
  // window exists, which is what stops the portal being built against nothing.
  const [host, setHost] = useState(null);
  // Read by the effect below, which must not be re-run when a caller passes a
  // new function on every render - reopening the window on every keystroke in
  // it would be a spectacular way to lose what was typed.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const popup = window.open('', '', `width=${Math.round(width)},height=${Math.round(height)}`);
    if (!popup) {
      closeRef.current?.('blocked');
      return undefined;
    }

    popup.document.title = title;
    // Without this the popup decodes as the browser's default, and a character
    // called Sørensen arrives spelled wrong.
    const charset = popup.document.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    popup.document.head.appendChild(charset);
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      popup.document.head.appendChild(node.cloneNode(true));
    }

    const root = popup.document.createElement('div');
    root.className = 'popout-root';
    popup.document.body.appendChild(root);
    setHost(root);

    /**
     * Send Escape - and only Escape - to the page's document as well.
     *
     * Every dialog in the app closes on Escape by listening on `document`, and
     * a dialog opened from in here is mounted in this tree but listening over
     * there. Re-dispatching is one place that knows about the split, against
     * twenty components that would otherwise each have to.
     *
     * One key and not the lot, which is what this did first. A dispatched event
     * bubbles from `document` up to `window`, and the map's own shortcuts live
     * there: Ctrl+Z to undo and Delete to rub out the selected shape. Both of
     * them decline politely when the key came from a text box - but the
     * forwarded event's target is the document, not the box that was typed in,
     * so the guard could not see it. Typing a Delete into a field on the second
     * monitor would have erased a shape on the first. Escape carries no such
     * risk: nothing types it, and nothing on the map listens for it.
     */
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };
    popup.addEventListener('keydown', onKey);

    // Closed from its own title bar, which is the ordinary way out.
    const bye = () => closeRef.current?.();
    popup.addEventListener('beforeunload', bye);
    // And if the page goes - a reload, a navigation - the window goes with it,
    // rather than being left open with a dead React tree inside it.
    const takeItWithUs = () => popup.close();
    window.addEventListener('beforeunload', takeItWithUs);

    return () => {
      popup.removeEventListener('keydown', onKey);
      popup.removeEventListener('beforeunload', bye);
      window.removeEventListener('beforeunload', takeItWithUs);
      setHost(null);
      popup.close();
    };
    // Opened once. The title follows it below; the size is only ever the size
    // it opened at, because after that it is the window manager's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The name on the taskbar, kept up with the window's own.
  useEffect(() => {
    if (host) host.ownerDocument.title = title;
  }, [host, title]);

  if (!host) return null;
  // Everything inside is told where it is, so a dialog it opens lands in this
  // window rather than back on the page.
  return createPortal(<PortalTargetProvider value={host.ownerDocument.body}>{children}</PortalTargetProvider>, host);
}
