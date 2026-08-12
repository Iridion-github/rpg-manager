import { useEffect, useState } from 'react';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import { UNITS, formatDistance, unitNamed } from './measure.js';

// Remembered per browser, like the drawing box's. How see-through a panel is
// says nothing about the table - only how much of the map its owner wants to
// keep looking at while they work.
const OPACITY_KEY = 'rpg:measure-window-opacity';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The measuring box: what the ruler counts in, and who else can see it.
 *
 * A floating window rather than a modal, for the same reason the drawing box is
 * one: everything in it is about the map behind it. Four controls and a total,
 * because a ruler that needs more than that has stopped being a ruler.
 *
 * The panel never holds the measurements themselves - those belong to the map,
 * and the map is what draws them. All this does is say how to read them.
 */
export default function MeasureTools({
  unit,
  perCell,
  onUnit,
  onPerCell,
  shared,
  onShared,
  total,
  chains,
  onClearAll,
  onClose,
  offline,
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
      title="Measuring mode"
      storageKey="rpg:measure-window"
      defaultSize={{ w: 320, h: 340 }}
      minSize={{ w: 250, h: 200 }}
      onClose={onClose}
      opacity={opacity / 100}
      onOpacityChange={setOpacity}
      // The window draws the slider itself, beside the title; this is the
      // spacer that sends the fold and close buttons to the far end of the bar.
      controls={<div className="spacer" />}
    >
      <div className="shape-tools measure-tools">
        <p className="hint">
          Click the map to drop a point. Each one measures back to the last. <kbd>Esc</kbd> ends
          the line, and the next click starts a new one.
        </p>

        <label className="shape-field">
          <span>Unit</span>
          <select
            value={unit}
            // Changing the unit resets what a cell is worth to that unit's own
            // default. Carrying 5 over from feet into metres would silently
            // claim a five-metre square, and the number that would say so is
            // the one being replaced.
            onChange={(e) => onUnit(e.target.value)}
          >
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>

        {/* The scale. Why entering the mode switches the grid on: this is a
            sentence about a cell, and it is hard to agree with one you can't
            see. */}
        <label className="shape-field">
          <span>1 cell is</span>
          <input
            type="number"
            min={0.1}
            max={1000}
            step={0.1}
            value={perCell}
            onChange={(e) => onPerCell(Number(e.target.value))}
          />
          <small>{unitNamed(unit).suffix}</small>
        </label>

        <label className="shape-field shape-check">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => onShared(e.target.checked)}
            disabled={offline}
          />
          <span>Shared</span>
        </label>
        <p className="hint measure-shared-note">
          {offline
            ? "Offline - there's nobody to show it to right now."
            : shared
              ? 'Everyone at the table can see this ruler, and the grid while it is up.'
              : 'Only you can see this. Nothing is sent to anybody.'}
        </p>

        {/* Always drawn, even at nothing. A total that appears only once there
            is something to total is a number you have to discover; one that
            sits at zero is a number you already know where to look for. */}
        <div className="measure-total">
          <span>Total distance</span>
          <strong>{formatDistance(total, unit, perCell)}</strong>
        </div>

        {chains > 0 && (
          <button type="button" className="danger shape-erase" onClick={onClearAll}>
            {/* Named for what it clears rather than "Clear": the map's own
                right-click menu offers the same act in the same words. */}
            Delete all measurements
          </button>
        )}

        <p className="hint">
          Nothing here is saved. Close this and every measurement goes with it.
        </p>
      </div>
    </FloatingWindow>
  );
}
