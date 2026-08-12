import { useEffect, useState } from 'react';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import { TOOLS, sizeFields, toolNamed, usesField } from './shapes.js';

// How see-through this window is, remembered per browser - the same bargain the
// turn tracker makes, and for the same reason: it says nothing about the table,
// only how much of the map its owner wants to keep looking at while they draw.
const OPACITY_KEY = 'rpg:shape-window-opacity';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The drawing box: which tool, and what it draws with.
 *
 * A floating window rather than a modal, deliberately - everything it says is
 * about the map behind it, and a panel you have to dismiss to use what it
 * controls is not a tool. Drag it out of the way; it remembers where you left
 * it, like every other window here.
 *
 * It has two states and says which it's in. With a shape selected the sliders
 * drive *that shape*, live, and there's a way to rub it out. With no selection
 * they set what the next shape will be drawn as. That's the arrangement every
 * drawing tool worth using has: one panel, and what it points at is whatever
 * you last touched.
 */

function Slider({ label, value, min, max, step, onChange, suffix = '' }) {
  return (
    <label className="shape-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <small>
        {Math.round(value * 10) / 10}
        {suffix}
      </small>
    </label>
  );
}

function Swatch({ label, value, onChange }) {
  return (
    <label className="shape-field shape-swatch">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function ShapeTools({
  tool,
  onTool,
  style,
  onStyle,
  selected,
  canEditSelected,
  onEditSelected,
  onDeleteSelected,
  clearable,
  onClearAll,
  onClose,
  offline,
}) {
  // What the fields are pointing at. A selected shape you're allowed to change
  // takes the panel over; otherwise it describes the next shape you'll draw.
  const editing = selected && canEditSelected ? selected : null;
  // Which kind of thing the fields are about - the selection's, or the tool's.
  const kind = editing?.kind || tool;
  const values = editing || style;
  const set = editing ? onEditSelected : onStyle;

  const field = (name) => usesField(kind, name);

  const [opacity, setOpacity] = useState(() => {
    const saved = Number(localStorage.getItem(OPACITY_KEY));
    // Clamped rather than rejected, so a value saved under an older floor is
    // still read as the answer it was.
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
      title="Drawing mode"
      storageKey="rpg:shape-window"
      defaultSize={{ w: 320, h: 480 }}
      minSize={{ w: 250, h: 220 }}
      onClose={onClose}
      opacity={opacity / 100}
      onOpacityChange={setOpacity}
      // The window draws the slider itself, beside the title. This is the
      // spacer that sends the fold and close buttons to the far end of the bar,
      // where every other window in the app keeps them.
      controls={<div className="spacer" />}
    >
      <div className="shape-tools">
        {/* Said out loud, because the four of them look like a mode switch and
            are not: the mode is already on, and these are what it can make. */}
        <h3 className="shape-heading">Create new</h3>
        <div className="shape-picker">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={tool === t.kind ? 'active' : ''}
              aria-pressed={tool === t.kind}
              // Choosing the tool you're already holding puts it down - which
              // leaves you in drawing mode with nothing loaded, still able to
              // pick up and rearrange what's already on the map.
              onClick={() => onTool(tool === t.kind ? null : t.kind)}
              disabled={offline}
            >
              {t.name}
            </button>
          ))}
        </div>

        {offline && <p className="hint">Offline - the board can't be drawn on right now.</p>}

        {!kind && !offline && (
          <p className="hint">
            The map answers to shapes while this is open: press one to pick it up, drag its
            border to resize it, or its centre mark to turn it. Choose a tool above to draw a
            new one. Right-drag still moves your view and the zoom still works - only the grid
            gauge is held still.
          </p>
        )}

        {kind && (
          <>
            <p className="hint shape-state">
              {editing ? (
                <>Editing the shape you picked. Drag it on the map to move it.</>
              ) : (
                toolNamed(kind)?.hint
              )}
            </p>

            {/* Size is a drag when you draw and a slider afterwards - the drag
                is faster and the slider is exact, and a table wants both. */}
            {editing &&
              sizeFields(kind).map(([name, label, min, max, step]) => (
                <Slider
                  key={name}
                  label={label}
                  min={min}
                  max={max}
                  step={step}
                  value={values[name] ?? min}
                  suffix={name === 'dir' || name === 'angle' ? '°' : ''}
                  onChange={(v) => set({ [name]: v })}
                />
              ))}

            {/* A cone's spread and a line's width belong to the tool as much as
                to the shape: they're decided before the drag, not after it. */}
            {!editing && field('angle') && (
              <Slider
                label="Spread"
                min={5}
                max={360}
                step={1}
                suffix="°"
                value={values.angle}
                onChange={(v) => set({ angle: v })}
              />
            )}
            {!editing && field('thickness') && (
              <Slider
                label="Width"
                min={0.1}
                max={10}
                step={0.1}
                value={values.thickness}
                onChange={(v) => set({ thickness: v })}
              />
            )}

            <Swatch label="Fill" value={values.fill} onChange={(v) => set({ fill: v })} />
            <Swatch label="Line" value={values.stroke} onChange={(v) => set({ stroke: v })} />
            <Slider
              label="Opacity"
              min={5}
              max={100}
              step={5}
              suffix="%"
              value={values.opacity}
              onChange={(v) => set({ opacity: v })}
            />
            <Slider
              label="Outline"
              min={0}
              max={12}
              step={1}
              suffix="px"
              value={values.strokeWidth}
              onChange={(v) => set({ strokeWidth: v })}
            />

            <label className="shape-field">
              <span>Label</span>
              <input
                type="text"
                maxLength={40}
                placeholder="Fireball…"
                value={values.label || ''}
                onChange={(e) => set({ label: e.target.value })}
              />
            </label>

            {/* Snapping is how you draw, not what you drew, so it stays with
                the tool even while a shape is selected - it's what the *next*
                drag, including a drag of that shape, will answer to. */}
            <label className="shape-field shape-check">
              <input
                type="checkbox"
                checked={style.snap}
                onChange={(e) => onStyle({ snap: e.target.checked })}
              />
              <span>Snap to the grid</span>
            </label>

            {editing && (
              <button type="button" className="danger shape-erase" onClick={onDeleteSelected}>
                Delete shape
              </button>
            )}
          </>
        )}

        {selected && !canEditSelected && (
          <p className="hint">Somebody else drew that one, so it isn't yours to change.</p>
        )}

        {/* Only with nothing picked. With a shape in hand the button beside it
            says "Delete shape", and two delete buttons a few pixels apart -
            one for this shape, one for every shape - is a mistake waiting to be
            made. Not drawn at all when there's nothing it could clear. */}
        {!selected && clearable > 0 && !offline && (
          <button type="button" className="danger shape-erase" onClick={onClearAll}>
            Delete all shapes
          </button>
        )}
      </div>
    </FloatingWindow>
  );
}
