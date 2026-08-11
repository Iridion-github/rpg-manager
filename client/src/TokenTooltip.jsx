import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { initiativeText } from './initiative.js';

/**
 * What a token is, shown while the pointer rests on it.
 *
 * It replaces the browser's own `title` bubble, which can hold a line of text
 * and nothing else — no bar, no telling one reader from another. Everyone gets
 * the name and the initiative; only the DM gets the hit points, because knowing
 * exactly how close the ogre is to dropping is the table's job to find out.
 *
 * Rendered into <body> rather than into the map: the map scrolls behind
 * `overflow: auto`, and a tooltip over a token near the edge would be cut in
 * half by it.
 */

// Between the token's edge and the bubble, in px.
const GAP = 10;
// Closest the bubble may come to the window's edge before it is pushed back in.
const MARGIN = 4;

export default function TokenTooltip({ anchor, token, showHp, status }) {
  const ref = useRef(null);

  /**
   * Follow the token.
   *
   * It moves for reasons React never hears about — the map scrolling under a
   * drag, a zoom, another player pushing it across the board — so rather than
   * remembering where the pointer arrived, this re-reads the token's box every
   * frame and writes a transform straight to the node. Off the render path
   * entirely: no state changes, so hovering costs nothing in re-renders.
   */
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const el = ref.current;
      if (!el || !anchor?.isConnected) return;
      const box = anchor.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = el;
      // Above the token, unless that would put it off the top of the window —
      // then below, which is the only other place it certainly fits.
      const above = box.top - h - GAP;
      const top = above < MARGIN ? box.bottom + GAP : above;
      const left = Math.min(
        Math.max(MARGIN, box.left + box.width / 2 - w / 2),
        window.innerWidth - w - MARGIN
      );
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  const hasInitiative = token.initiative !== null && token.initiative !== undefined;
  // A total of zero is a token whose hit points nobody set up, not one at death's
  // door — there is no bar to draw for it.
  const total = token.maxHp ?? 0;
  const tracked = showHp && total > 0;
  // Clamped for the bar's sake: a stored value can outlive the total it was
  // measured against if the DM lowers the maximum afterwards.
  const current = Math.max(0, Math.min(token.hp ?? 0, total));

  return createPortal(
    <div className="token-tip" ref={ref} role="tooltip">
      <strong>{token.label}</strong>

      {hasInitiative && (
        <span className="token-tip-row">
          Initiative{' '}
          <b>
            {initiativeText(token).total}
            {initiativeText(token).breakdown && (
              <small> ({initiativeText(token).breakdown})</small>
            )}
          </b>
        </span>
      )}

      {tracked && (
        <span className="token-tip-hp">
          <span className="token-tip-row">
            Hit points{' '}
            <b>
              {current} / {total}
            </b>
          </span>
          {/* The track is the wound and the fill is what's left of them, so the
              red showing through is exactly the damage taken. */}
          <span className="hp-bar">
            <span className="hp-fill" style={{ width: `${(current / total) * 100}%` }} />
          </span>
        </span>
      )}

      {status && <small>{status}</small>}
    </div>,
    document.body
  );
}
