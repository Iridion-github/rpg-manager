import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PopoutWindow from './PopoutWindow.jsx';

/**
 * A panel that floats over the app instead of replacing what's underneath.
 * Drag it by the header, resize it from any edge or corner, and fold it down to
 * just its title bar with the button beside the close one.
 *
 * Deliberately *not* a modal: no backdrop, and nothing behind it is made
 * inert. The whole point is that the rest of the page - the list you opened
 * this from, the chat down the side - stays where it was and stays usable.
 * `role="dialog"` without `aria-modal` says exactly that to a screen reader.
 *
 * `controls` are laid out between the title and the close button; pass a
 * `.spacer` among them to push the trailing ones right, the same way the app
 * header does.
 */

// Every edge and corner. Order matters only in that the corners come last, so
// they sit above the edges they overlap and win the four ambiguous hit areas.
const GRIPS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

// Below this a character sheet stops being readable and turns into a puzzle.
// Only the default, though - a window whose content is a short list rather than
// a sheet says so with `minSize` and is allowed to be much smaller.
const MIN_W = 380;
const MIN_H = 260;
const DEFAULT_MIN = { w: MIN_W, h: MIN_H };

// Rolled up, the window is a title bar and nothing else, so it answers to a
// different floor: wide enough for a name, and only as tall as its own header.
const MINI_W = 240;

/**
 * How faint a window may be made.
 *
 * Never fully invisible: a window you cannot see is one you cannot find again,
 * and past this point even the slider that would bring it back is hard to
 * catch. Exported so the windows that offer the control all answer to the same
 * floor rather than each picking one.
 */
export const OPACITY_MIN = 20;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// Keep the whole window on screen. Size is clamped before position, because
// where it may sit depends on how big it ended up. The minimums are arguments
// rather than constants because a rolled-up window has its own, much smaller.
function fit(r, minW = MIN_W, minH = MIN_H) {
  const w = clamp(r.w, minW, window.innerWidth);
  const h = clamp(r.h, minH, window.innerHeight);
  return {
    w,
    h,
    x: Math.round(clamp(r.x, 0, window.innerWidth - w)),
    y: Math.round(clamp(r.y, 0, window.innerHeight - h)),
  };
}

// How far each window in a stack of never-before-placed ones steps down and
// right of the last, so a second one doesn't open exactly behind the first.
const CASCADE_STEP = 30;

// The gap between an anchored window and the thing it is anchored to, so the
// two read as one object with a hinge rather than as a card lying on a marker.
const ANCHOR_GAP = 12;

/**
 * Where an anchored window sits: over the thing it belongs to.
 *
 * Centred on it and above it, dropping below when there isn't the room - the
 * same choice a token's nameplate makes, and for the same reason: a card that
 * hangs off the top of the screen is a card with its first line missing.
 *
 * The anchor carries the marker's top and bottom rather than one y, because
 * "above" means clear of its head and "below" means clear of its point, and the
 * two are several pixels apart.
 */
function placeAt(anchor, size) {
  const w = Math.min(size.w, window.innerWidth - 16);
  const h = Math.min(size.h, window.innerHeight - 16);
  const x = clamp(anchor.x - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
  const above = anchor.top - ANCHOR_GAP - h;
  const y =
    above >= 8 ? above : clamp(anchor.bottom + ANCHOR_GAP, 8, Math.max(8, window.innerHeight - h - 8));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function savedRect(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return saved && Number.isFinite(saved.x) ? saved : null;
  } catch {
    // A corrupt entry is not worth a broken window - treat it as none.
    return null;
  }
}

const hasSavedRect = (storageKey) => Boolean(storageKey && savedRect(storageKey));

/**
 * Where it opens, in the order the answers are worth having.
 *
 * 1. Where *this* window was last left. A character you always keep in the
 *    corner opens back in that corner, whatever else is on screen.
 * 2. Where the last window *of this kind* was left, stepped by its place in
 *    the stack. This is what a sheet you have never opened before does, and it
 *    is the difference between "the sheets live over here" and every new one
 *    landing in the middle of the map. `fallbackKey` is what says two windows
 *    are the same kind.
 * 3. Centred, for the first window of a kind this browser has ever opened.
 *
 * The step exists in the last two because windows that have never been placed
 * would otherwise land on the same spot and look like one window.
 */
function firstRect(storageKey, fallbackKey, size, cascade, min) {
  const saved = storageKey && savedRect(storageKey);
  if (saved) return fit(saved, min.w, min.h);
  const step = cascade * CASCADE_STEP;
  const last = fallbackKey && savedRect(fallbackKey);
  if (last) {
    return fit({ ...last, x: last.x + step, y: last.y + step }, min.w, min.h);
  }
  const w = Math.min(size.w, window.innerWidth);
  const h = Math.min(size.h, window.innerHeight);
  return fit(
    {
      w,
      h,
      x: (window.innerWidth - w) / 2 + step,
      y: (window.innerHeight - h) / 2 + step,
    },
    min.w,
    min.h
  );
}

// Dragging the north or west side moves the corner you *aren't* holding, so the
// opposite side stays put. The upper clamps are what stop a stretch running off
// the screen - the edge you're pulling can't pass the viewport it started in.
function stretch(from, mode, dx, dy, min) {
  let { x, y, w, h } = from;
  if (mode.includes('e')) w = clamp(from.w + dx, min.w, window.innerWidth - from.x);
  if (mode.includes('s')) h = clamp(from.h + dy, min.h, window.innerHeight - from.y);
  if (mode.includes('w')) {
    w = clamp(from.w - dx, min.w, from.x + from.w);
    x = from.x + from.w - w;
  }
  if (mode.includes('n')) {
    h = clamp(from.h - dy, min.h, from.y + from.h);
    y = from.y + from.h - h;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * A box with an arrow leaving it, or coming back into it.
 *
 * Drawn rather than typed, for the reason the fold and close marks are: as
 * characters these come from whatever font the system hands over, at optical
 * sizes and baselines that have nothing to do with each other. Two paths buy an
 * exact size and a true centre.
 */
function PopIcon({ back = false }) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {/* The window, open at the corner the arrow passes through. */}
      <path d="M5.6 1.4 H1.4 V8.6 H8.6 V4.4" />
      {/* And the arrow: out to the top right, or back in from it. */}
      {back ? (
        <>
          <path d="M9 1 L5.6 4.4" />
          <path d="M5.6 1.9 V4.4 H8.1" />
        </>
      ) : (
        <>
          <path d="M9 1 L5.6 4.4" />
          <path d="M6.5 1 H9 V3.5" />
        </>
      )}
    </svg>
  );
}

export default function FloatingWindow({
  title,
  controls,
  children,
  onClose,
  storageKey,
  /**
   * What kind of window this is, for the windows that are one per record.
   *
   * A sheet remembers its own box under its own key, which is what makes three
   * characters laid out side by side come back side by side. A sheet you have
   * never opened has no such key and used to land in the middle of the screen -
   * so "where I keep my sheets" was a thing this remembered for every character
   * except the next one. This is that memory: the last place a window of this
   * kind was left, used when the window itself has nothing of its own to say.
   */
  fallbackKey,
  defaultSize = { w: 1040, h: 760 },
  // How small this one may be pulled. The default suits a character sheet; a
  // window holding a short list can ask for far less and still be usable.
  minSize = DEFAULT_MIN,
  // 0–1, applied to the whole window. Pass `onOpacityChange` as well and the
  // header grows the slider that drives it - kept here rather than handed to
  // each caller as markup so every window that offers it looks and behaves the
  // same, and answers to one floor.
  opacity = 1,
  onOpacityChange,
  // Where this one sits in a stack of them: `zIndex` paints it, `cascade`
  // places it the first time, and `isTop` decides who answers the Escape key -
  // one keypress should close the window in front, not every one at once.
  zIndex = 40,
  cascade = 0,
  isTop = true,
  onFocus,
  /**
   * Pin this window to a spot on screen instead of letting it be dragged.
   *
   * `{ x, top, bottom }` in viewport coordinates - the thing it belongs to. An
   * anchored window may still be resized, and it keeps that size; what it may
   * not do is wander off the thing it is describing. A pin's card is the one
   * that wants this: a card about *that* doorway which has been dragged across
   * the map is a card about nothing.
   *
   * Recomputed by the caller as the map moves under it, so it rides along.
   */
  anchor = null,
  /**
   * Whether this one can be rolled up to its title bar at all.
   *
   * A window that belongs to a thing on screen has nothing to gain by folding:
   * a pin's card rolled up is a title bar hovering over the map saying the word
   * that is already written under the pin below it, and the only thing left to
   * do with it is close it - which is what the ✕ beside it does. Two buttons
   * that do the same thing is one button too many, so it isn't drawn.
   */
  foldable = true,
  /**
   * Whether this one may be sent out to a browser window of its own.
   *
   * Off unless asked for, and asked for by exactly two: a character sheet and a
   * note. Those are the windows somebody reads *while* doing something else -
   * a sheet beside the map, a note beside the fight - which is the whole reason
   * to want one on a second monitor.
   *
   * The rest are not refused out of caution; they would simply be worse for it.
   * The tools panels, the grid settings and the turn tracker are about the map
   * in front of them and are no use on another screen with no map on it, and a
   * pin's card is about a spot on that map, which makes it the same argument
   * twice over. A window that offers to do a thing it would be a mistake to do
   * is a worse window than one that does not offer.
   */
  poppable = false,
}) {
  const [rect, setRect] = useState(() =>
    firstRect(storageKey, fallbackKey, defaultSize, cascade, minSize)
  );
  // Whether this window has ever been dragged or resized. Only then is its box
  // a preference worth remembering: saving the opening position too would make
  // every window "already placed", and a cascade of untouched windows would
  // restore itself into a single pile on the next open.
  const [placed, setPlaced] = useState(() => hasSavedRect(storageKey));
  /**
   * Whether this window is out on the desktop rather than on the page.
   *
   * A window and not a copy of one: see PopoutWindow. While it is out, none of
   * the chrome below is drawn - no drag handle, no grips, no fold - because the
   * window manager already offers all of it and does it better. What is drawn
   * inside the popped-out window is the title bar's *contents*: a sheet's
   * Export and Delete are reached from that bar and would otherwise be stranded
   * on the page the sheet is no longer on.
   */
  const [poppedOut, setPoppedOut] = useState(false);
  // Whether the browser refused the last attempt to open one. Cleared by the
  // next attempt, so the note is about what just happened rather than a sign
  // that stays up.
  const [blocked, setBlocked] = useState(false);
  // '' when idle, otherwise 'move' or the edge being pulled. Held in state
  // because the cursor and the body's inertness depend on it.
  const [mode, setMode] = useState('');
  // The gesture in flight. A ref, not state: it's read by listeners that must
  // see the current values, and changing it must not re-render on its own.
  const gesture = useRef(null);

  // Rolled up to its title bar. Holds the *size* to unroll back into - only the
  // size, so a bar you dragged somewhere unrolls where you left it rather than
  // springing back to where it was folded. Non-null is what "rolled up" means.
  const [rolledUpSize, setRolledUpSize] = useState(null);
  const minimized = rolledUpSize !== null;
  const winRef = useRef(null);
  const headRef = useRef(null);

  // The box the window has when open - right now, or once unrolled.
  const openRect = minimized ? { ...rect, ...rolledUpSize } : rect;

  /**
   * Where it actually sits this frame.
   *
   * An anchored window's position is not state at all: it is worked out from
   * the thing it belongs to, on every render, which is what lets the card ride
   * along as the map is scrolled and zoomed under it. Only its size is
   * remembered, and only its size can be dragged.
   */
  const anchored = Boolean(anchor);
  const box = anchored ? placeAt(anchor, rect) : rect;

  // While rolled up the window is allowed to be far smaller than a sheet needs,
  // and every clamp - dragging, a browser resize - has to agree, or the next one
  // to run would quietly unroll it.
  // The folded bar is MINI_W wide - unless the window's own minimum is narrower
  // than that, in which case folding it must not *widen* it.
  const foldW = Math.min(MINI_W, Math.max(rect.w, minSize.w));
  const minW = minimized ? foldW : minSize.w;
  const minH = minimized ? rect.h : minSize.h;

  /**
   * Roll the window up to its title bar, and back down again.
   *
   * Driven by the button in the header rather than a double-click on the bar:
   * starting a drag calls preventDefault on the pointerdown, and that suppresses
   * the compatibility mouse events the browser would otherwise synthesise - so
   * a dblclick handler on a draggable surface never hears anything.
   *
   * The collapsed height is measured rather than guessed: it's whatever the
   * header actually is, plus the window's own border, so the bar closes exactly
   * around the title however the styling changes.
   */
  function toggleRollUp() {
    if (minimized) {
      setRect(fit(openRect, minSize.w, minSize.h));
      setRolledUpSize(null);
      return;
    }
    const border = winRef.current.offsetHeight - winRef.current.clientHeight;
    const h = Math.round(headRef.current.getBoundingClientRect().height + border);
    setRolledUpSize({ w: rect.w, h: rect.h });
    setRect(fit({ ...rect, w: foldW, h }, foldW, h));
  }

  // Settle the rolled-up height against the header as it ends up, not as it was
  // when folded: dropping the controls makes the bar shorter than the one that
  // was measured, and the difference would show as a strip of empty window under
  // the name. Before paint, so the correction is never a frame anyone sees.
  useLayoutEffect(() => {
    if (!minimized) return;
    const border = winRef.current.offsetHeight - winRef.current.clientHeight;
    const h = Math.round(headRef.current.getBoundingClientRect().height + border);
    setRect((r) =>
      r.h === h ? r : fit({ ...r, h }, Math.min(MINI_W, Math.max(r.w, minSize.w)), h)
    );
  }, [minimized]);

  function begin(next) {
    return (e) => {
      if (e.button !== 0) return;
      gesture.current = { px: e.clientX, py: e.clientY, from: box };
      setMode(next);
      setPlaced(true);
      e.preventDefault(); // a drag must not also start selecting text
    };
  }

  // Pressing a button in the header is not a request to move the window - and
  // nor is anything at all when the window is anchored to something.
  const beginMove = (e) => {
    if (anchored) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    begin('move')(e);
  };

  useEffect(() => {
    if (!mode) return;
    const move = (e) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.px;
      const dy = e.clientY - g.py;
      if (mode === 'move') {
        setRect(fit({ ...g.from, x: g.from.x + dx, y: g.from.y + dy }, minW, minH));
        return;
      }
      const stretched = stretch(g.from, mode, dx, dy, minSize);
      // An anchored window keeps its place while being resized: pulling its
      // west edge was a request for a wider card, not for a card somewhere
      // else. Where it goes is worked out from the anchor either way.
      setRect((r) => (anchored ? { ...r, w: stretched.w, h: stretched.h } : stretched));
    };
    const stop = () => {
      gesture.current = null;
      setMode('');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [mode, minW, minH, anchored]);

  // Shrinking the browser must not leave the window stranded off screen.
  useEffect(() => {
    const onResize = () => setRect((r) => fit(r, minW, minH));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH]);

  // One write when the gesture settles, rather than one per pointer event.
  // Rolled up, what gets remembered is the box it will unroll into: reopening
  // the sheet into a bare title bar's worth of space would be a puzzle, not a
  // restored preference.
  useEffect(() => {
    if (!storageKey || mode || !placed) return;
    try {
      const box = JSON.stringify(openRect);
      localStorage.setItem(storageKey, box);
      // And as the last place a window of this kind was left, which is where
      // the next one that has never been opened will appear.
      if (fallbackKey) localStorage.setItem(fallbackKey, box);
    } catch {
      // Private mode, or a full quota. Losing the position is not worth a throw.
    }
    // Depends on the numbers, not on openRect: that object is rebuilt every
    // render, and as a dependency it would rewrite the entry on each one.
  }, [storageKey, fallbackKey, mode, placed, openRect.x, openRect.y, openRect.w, openRect.h]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Escape closes the topmost thing and only that. A dice or roll modal
      // opened from in here listens too and sits above us; so does any window
      // in front of this one.
      if (!isTop) return;
      if (document.querySelector('.modal-backdrop')) return;
      onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, isTop]);

  /**
   * Put it back on the page.
   *
   * Also what the popped-out window's own close button ends up calling, through
   * `onClose` on PopoutWindow: shutting the window is not closing the sheet, it
   * is bringing it home. Closing the sheet is the ✕, which is on the title bar
   * either way.
   */
  const putBack = (why) => {
    setPoppedOut(false);
    // Refused by the browser rather than by the user. Said in the title bar,
    // because the alternative is a button that visibly does nothing - and not
    // said in an alert(), which stops the whole page dead until it is dismissed
    // and is a poor way to report that a button did not work.
    setBlocked(why === 'blocked');
  };

  // Out on the desktop: the page keeps nothing of this window - no bar, no
  // ghost - because a title bar for a window that is somewhere else is a thing
  // to accidentally close.
  if (poppedOut) {
    return (
      <PopoutWindow title={title} width={box.w} height={box.h} onClose={putBack}>
        <div className="win win-popped">
          <div className="win-head">
            <strong className="win-title">{title}</strong>
            {controls}
            <button
              type="button"
              className="linky win-pop"
              onClick={() => putBack()}
              aria-label="Put back on the page"
              title="Put back on the page"
            >
              <PopIcon back />
            </button>
            {onClose && (
              <button type="button" className="linky win-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            )}
          </div>
          <div className="win-body">{children}</div>
        </div>
      </PopoutWindow>
    );
  }

  // Into <body>, not into whatever rendered us. A window pinned to the viewport
  // has no business in the middle of a column's child list: it doesn't lay out
  // there, it outlives the view it was opened from, and its owner's output would
  // grow and shrink by a node every time it opened and closed.
  return createPortal(
    <div
      ref={winRef}
      className={`win${mode ? ' win-busy' : ''}${mode === 'move' ? ' win-moving' : ''}${
        minimized ? ' win-min' : ''
      }${isTop ? ' win-top' : ''}${anchored ? ' win-anchored' : ''}`}
      role="dialog"
      aria-label={title}
      // Anywhere in the window, not just the header: reaching for a field in the
      // one behind should bring it forward, the same as reaching for its bar.
      onPointerDown={onFocus}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex, opacity }}
    >
      <div ref={headRef} className="win-head" onPointerDown={beginMove}>
        <strong className="win-title">{title}</strong>
        {/* Beside the title, and only while the window is open - rolled up,
            the bar is a name and its own two buttons. */}
        {onOpacityChange && !minimized && (
          <label className="win-opacity" title={`Opacity ${Math.round(opacity * 100)}%`}>
            <input
              type="range"
              min={OPACITY_MIN}
              max={100}
              step={5}
              value={Math.round(opacity * 100)}
              aria-label={`Opacity of ${title}`}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
            />
          </label>
        )}
        {/* Rolled up, the bar carries the name and nothing else. The controls
            act on a sheet you can't see, so they go with it - but the window's
            own buttons stay, or a folded sheet would have no way back. */}
        {!minimized && controls}
        {minimized && <div className="spacer" />}
        {/* Drawn rather than typed. As characters these two marks come from
            whatever font the system hands over, at optical sizes and baselines
            that have nothing to do with each other or with the ✕ beside them -
            a square glyph in particular lands small and sitting low. Two lines
            of SVG buy an exact size and a true centre.

            Absent on a window that says it cannot fold, the same way the ✕ is
            absent on one nobody may close. */}
        {/* Left of the minimise button, and drawn the same way and for the same
            reason - see the note on that one. Only where the caller says it is
            worth having; see `poppable`. The refusal note goes with it, since
            it is a note about this button and nothing else. */}
        {poppable && blocked && (
          <small className="win-note" role="status">
            Pop-ups blocked
          </small>
        )}
        {poppable && (
          <button
            type="button"
            className="linky win-pop"
            onClick={() => {
              setBlocked(false);
              setPoppedOut(true);
            }}
            aria-label="Open in a new window"
            title="Open in a new window"
          >
            <PopIcon />
          </button>
        )}
        {foldable && (
          <button
            type="button"
            className="linky win-fold"
            onClick={toggleRollUp}
            aria-label={minimized ? 'Restore' : 'Minimise'}
            title={minimized ? 'Restore' : 'Minimise'}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              {minimized ? (
                <rect x="0.7" y="0.7" width="8.6" height="8.6" rx="1" />
              ) : (
                <line x1="0.5" y1="5" x2="9.5" y2="5" />
              )}
            </svg>
          </button>
        )}
        {/* A window nobody may close renders no way to close it, rather than a
            button that quietly does nothing. The turn tracker is one: it stands
            until the DM ends the fight. */}
        {onClose && (
          <button type="button" className="linky win-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>

      {/* Kept out of the tree entirely rather than merely clipped: a rolled-up
          sheet shouldn't hold focusable fields nobody can see. */}
      {!minimized && <div className="win-body">{children}</div>}

      {/* Nothing to resize when there's nothing but a title bar. */}
      {!minimized &&
        GRIPS.map((g) => (
          <div key={g} className={`win-grip ${g}`} onPointerDown={begin(g)} />
        ))}
    </div>,
    document.body
  );
}
