import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A panel that floats over the app instead of replacing what's underneath.
 * Drag it by the header, resize it from any edge or corner, and fold it down to
 * just its title bar with the button beside the close one.
 *
 * Deliberately *not* a modal: no backdrop, and nothing behind it is made
 * inert. The whole point is that the rest of the page — the list you opened
 * this from, the chat down the side — stays where it was and stays usable.
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
// Only the default, though — a window whose content is a short list rather than
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

function savedRect(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return saved && Number.isFinite(saved.x) ? saved : null;
  } catch {
    // A corrupt entry is not worth a broken window — treat it as none.
    return null;
  }
}

const hasSavedRect = (storageKey) => Boolean(storageKey && savedRect(storageKey));

// Where it opens: where you last left it, or centred the first time — offset by
// its place in the stack, since windows that have never been moved would
// otherwise all land on the same spot and look like one window.
function firstRect(storageKey, size, cascade, min) {
  const saved = storageKey && savedRect(storageKey);
  if (saved) return fit(saved, min.w, min.h);
  const w = Math.min(size.w, window.innerWidth);
  const h = Math.min(size.h, window.innerHeight);
  const step = cascade * CASCADE_STEP;
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
// the screen — the edge you're pulling can't pass the viewport it started in.
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

export default function FloatingWindow({
  title,
  controls,
  children,
  onClose,
  storageKey,
  defaultSize = { w: 1040, h: 760 },
  // How small this one may be pulled. The default suits a character sheet; a
  // window holding a short list can ask for far less and still be usable.
  minSize = DEFAULT_MIN,
  // 0–1, applied to the whole window. Pass `onOpacityChange` as well and the
  // header grows the slider that drives it — kept here rather than handed to
  // each caller as markup so every window that offers it looks and behaves the
  // same, and answers to one floor.
  opacity = 1,
  onOpacityChange,
  // Where this one sits in a stack of them: `zIndex` paints it, `cascade`
  // places it the first time, and `isTop` decides who answers the Escape key —
  // one keypress should close the window in front, not every one at once.
  zIndex = 40,
  cascade = 0,
  isTop = true,
  onFocus,
}) {
  const [rect, setRect] = useState(() => firstRect(storageKey, defaultSize, cascade, minSize));
  // Whether this window has ever been dragged or resized. Only then is its box
  // a preference worth remembering: saving the opening position too would make
  // every window "already placed", and a cascade of untouched windows would
  // restore itself into a single pile on the next open.
  const [placed, setPlaced] = useState(() => hasSavedRect(storageKey));
  // '' when idle, otherwise 'move' or the edge being pulled. Held in state
  // because the cursor and the body's inertness depend on it.
  const [mode, setMode] = useState('');
  // The gesture in flight. A ref, not state: it's read by listeners that must
  // see the current values, and changing it must not re-render on its own.
  const gesture = useRef(null);

  // Rolled up to its title bar. Holds the *size* to unroll back into — only the
  // size, so a bar you dragged somewhere unrolls where you left it rather than
  // springing back to where it was folded. Non-null is what "rolled up" means.
  const [rolledUpSize, setRolledUpSize] = useState(null);
  const minimized = rolledUpSize !== null;
  const winRef = useRef(null);
  const headRef = useRef(null);

  // The box the window has when open — right now, or once unrolled.
  const openRect = minimized ? { ...rect, ...rolledUpSize } : rect;

  // While rolled up the window is allowed to be far smaller than a sheet needs,
  // and every clamp — dragging, a browser resize — has to agree, or the next one
  // to run would quietly unroll it.
  // The folded bar is MINI_W wide — unless the window's own minimum is narrower
  // than that, in which case folding it must not *widen* it.
  const foldW = Math.min(MINI_W, Math.max(rect.w, minSize.w));
  const minW = minimized ? foldW : minSize.w;
  const minH = minimized ? rect.h : minSize.h;

  /**
   * Roll the window up to its title bar, and back down again.
   *
   * Driven by the button in the header rather than a double-click on the bar:
   * starting a drag calls preventDefault on the pointerdown, and that suppresses
   * the compatibility mouse events the browser would otherwise synthesise — so
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
      gesture.current = { px: e.clientX, py: e.clientY, from: rect };
      setMode(next);
      setPlaced(true);
      e.preventDefault(); // a drag must not also start selecting text
    };
  }

  // Pressing a button in the header is not a request to move the window.
  const beginMove = (e) => {
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
      setRect(
        mode === 'move'
          ? fit({ ...g.from, x: g.from.x + dx, y: g.from.y + dy }, minW, minH)
          : stretch(g.from, mode, dx, dy, minSize)
      );
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
  }, [mode, minW, minH]);

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
      localStorage.setItem(storageKey, JSON.stringify(openRect));
    } catch {
      // Private mode, or a full quota. Losing the position is not worth a throw.
    }
    // Depends on the numbers, not on openRect: that object is rebuilt every
    // render, and as a dependency it would rewrite the entry on each one.
  }, [storageKey, mode, placed, openRect.x, openRect.y, openRect.w, openRect.h]);

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

  // Into <body>, not into whatever rendered us. A window pinned to the viewport
  // has no business in the middle of a column's child list: it doesn't lay out
  // there, it outlives the view it was opened from, and its owner's output would
  // grow and shrink by a node every time it opened and closed.
  return createPortal(
    <div
      ref={winRef}
      className={`win${mode ? ' win-busy' : ''}${mode === 'move' ? ' win-moving' : ''}${
        minimized ? ' win-min' : ''
      }${isTop ? ' win-top' : ''}`}
      role="dialog"
      aria-label={title}
      // Anywhere in the window, not just the header: reaching for a field in the
      // one behind should bring it forward, the same as reaching for its bar.
      onPointerDown={onFocus}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex, opacity }}
    >
      <div ref={headRef} className="win-head" onPointerDown={beginMove}>
        <strong className="win-title">{title}</strong>
        {/* Beside the title, and only while the window is open — rolled up,
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
            act on a sheet you can't see, so they go with it — but the window's
            own buttons stay, or a folded sheet would have no way back. */}
        {!minimized && controls}
        {minimized && <div className="spacer" />}
        {/* Drawn rather than typed. As characters these two marks come from
            whatever font the system hands over, at optical sizes and baselines
            that have nothing to do with each other or with the ✕ beside them —
            a square glyph in particular lands small and sitting low. Two lines
            of SVG buy an exact size and a true centre. */}
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
