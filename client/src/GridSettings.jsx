import { useEffect, useState } from 'react';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';

// How see-through the window itself is, remembered per browser, like the
// drawing and measuring boxes. Nothing to do with the grid's own opacity, which
// is a property of the scene and one of the things this window sets.
const OPACITY_KEY = 'rpg:grid-window-opacity';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Grid settings: everything about how the grid is drawn, previewed live on the
 * DM's own map and sent to the table only when they say so.
 *
 * That is the whole shape of this window. A grid being retuned goes through
 * every wrong answer on the way to the right one, and the rest of the table
 * does not want to watch that happen over the map they are playing on. So the
 * draft is local until **Save changes**, and **Cancel** puts back what was
 * there before it opened.
 *
 * A floating window rather than a modal, for the reason the drawing box is one:
 * everything in it is about the map behind it, and a panel you must dismiss to
 * see what it does is not a settings panel. Drag it aside; it remembers where.
 */

function Row({ label, hint, children }) {
  return (
    <label className="shape-field grid-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function GridSettings({
  draft,
  cols,
  rows,
  sizeMin,
  sizeMax,
  dirty,
  onChange,
  onCancel,
  onSave,
}) {
  const [opacity, setOpacity] = useState(() => {
    const saved = Number(localStorage.getItem(OPACITY_KEY));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved, OPACITY_MIN, 100) : 100;
  });

  useEffect(() => {
    try {
      localStorage.setItem(OPACITY_KEY, String(opacity));
    } catch {
      // Private mode, or a full quota. It still fades; it just won't remember.
    }
  }, [opacity]);

  return (
    <FloatingWindow
      title="Grid settings"
      storageKey="rpg:grid-window"
      defaultSize={{ w: 340, h: 460 }}
      minSize={{ w: 280, h: 240 }}
      // Closing is cancelling. There is no third answer: a window that vanished
      // leaving a half-tuned grid on the DM's screen and nobody else's would be
      // a state with no way back to either side of it.
      onClose={onCancel}
      opacity={opacity / 100}
      onOpacityChange={setOpacity}
      controls={<div className="spacer" />}
    >
      <div className="shape-tools grid-settings">
        <p className="hint">
          Only you can see these while the window is open. Save to send them to the table.
        </p>

        <Row label="Cell size" hint={`${cols}x${rows}`}>
          <input
            type="range"
            min={sizeMin}
            max={sizeMax}
            step="1"
            value={draft.gridSize}
            aria-label="Cell size"
            onChange={(e) => onChange({ gridSize: Number(e.target.value) })}
          />
        </Row>

        {/* Said here because the gesture used to belong to a gauge in the scene
            bar that has gone; without a line saying so, aligning a grid to a map
            that already has one drawn on it becomes undiscoverable. */}
        <p className="hint">
          Right-drag the map to slide the grid over it, and scroll to resize the cells.
        </p>

        <Row label="Opacity" hint={draft.gridContrast ? 'full' : `${draft.gridOpacity}%`}>
          <input
            type="range"
            min={2}
            max={100}
            step="1"
            value={draft.gridOpacity}
            aria-label="Grid opacity"
            // Adaptive contrast needs the lines at full strength to be an
            // inversion at all: fading them composites the opposite colour back
            // over the colour it was the opposite of. The value is kept rather
            // than reset, so switching adaptive off restores the chosen fade.
            disabled={draft.gridContrast}
            onChange={(e) => onChange({ gridOpacity: Number(e.target.value) })}
          />
        </Row>

        <Row label="Thickness" hint={`${draft.gridThickness}px`}>
          <input
            type="range"
            min={1}
            max={6}
            step="1"
            value={draft.gridThickness}
            aria-label="Grid line thickness"
            onChange={(e) => onChange({ gridThickness: Number(e.target.value) })}
          />
        </Row>

        <label className="shape-field shape-swatch">
          <span>Colour</span>
          <input
            type="color"
            value={draft.gridColor}
            // Greyed out under adaptive contrast because it would not do what it
            // looks like it does: the lines are drawn by inverting the map, and
            // white is the only ink that gives a true inversion. Anything else
            // tints the result.
            disabled={draft.gridContrast}
            aria-label="Grid colour"
            onChange={(e) => onChange({ gridColor: e.target.value })}
          />
        </label>

        <label className="shape-field shape-check">
          <input
            type="checkbox"
            checked={draft.gridContrast}
            onChange={(e) => onChange({ gridContrast: e.target.checked })}
          />
          <span>Adaptive contrast</span>
        </label>
        <p className="hint">
          Each line takes the exact opposite of what is under it, pixel by pixel: black over white,
          white over black, cyan over red. The colour and opacity are set aside while it is on,
          since an inversion is only an inversion at full strength.
        </p>

        <div className="grid-actions">
          <button type="button" className="linky" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={!dirty}>
            Save changes
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}
