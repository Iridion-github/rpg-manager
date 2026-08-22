import { useState } from 'react';
import FloatingWindow, { OPACITY_MIN } from './FloatingWindow.jsx';
import { TOOLS, toolNamed } from './shapes.js';

/**
 * Obscuration: blacking parts of the map out by hand.
 *
 * The same tools the drawing panel offers, pointed at a different job. What is
 * drawn here is not a template anybody reads - it is a wall, and the only thing
 * about it worth choosing is which side of it you are drawing.
 *
 * ## The switch, and why the colours are not choices
 *
 * Two pens. **Obscure vision** blacks out what it covers; **Clear vision** cuts
 * back through the black. They are drawn black and white respectively, and
 * neither is a colour the DM picks, because the colour *is* the meaning: a
 * white obscuring shape or a black clearing one would be a lie about what the
 * players will see. The panel has no fill or line swatch for that reason.
 *
 * ## The opacity, and who it is for
 *
 * One number for the whole layer rather than one per shape, and it is the DM's
 * own window onto the map: the players always get it solid, because a wall you
 * can see through is not a wall. It is here so that a shape can be laid over a
 * corridor its author can still make out. That is also why it stays on screen
 * with no tool in hand - it is not a property of the next shape, it is how this
 * DM is looking at the board.
 *
 * ## Applying
 *
 * Nothing here reaches the table until Apply. Up to then it is a plan: drawn,
 * kept, and invisible to everybody else - the server does not so much as send
 * the shapes to a player until the switch is on. Taking it away asks first, for
 * the reason turning the fog off asks: it hands back a great deal of map at
 * once, and it is not a thing to do by brushing a button.
 */
export default function ObscurationSettings({
  obscuration,
  panelOpacity,
  onPanelOpacity,
  tool,
  clear,
  editing,
  onEditing,
  onTool,
  onClear,
  onOpacity,
  onApply,
  onClose,
  offline,
}) {
  const [asking, setAsking] = useState(false);
  const chosen = toolNamed(tool);
  const on = obscuration.on === true;
  const shapes = obscuration.shapes || [];
  const drawn = shapes.length;
  // Split the way the two pens are: it is the one thing about the list worth
  // counting, since a layer that is all black and a layer that is half cut
  // through are very different things to be about to show a table.
  const clearing = shapes.filter((x) => x.clear).length;
  const obscuring = drawn - clearing;

  return (
    <FloatingWindow
      title="Obscuration mode"
      storageKey="rpg:obscure-window"
      defaultSize={{ w: 320, h: 560 }}
      minSize={{ w: 280, h: 320 }}
      onClose={onClose}
      // How see-through the panel itself is - the slider every floating window
      // carries. Not the one inside the panel, which is about the black on the
      // map; this is about the window you are reading it through.
      opacity={panelOpacity / 100}
      onOpacityChange={onPanelOpacity}
      // A spacer and nothing else. The header lays its controls out between the
      // title and the window's own buttons, so a panel that passes none leaves
      // those buttons sitting against the title instead of out at the right
      // edge where every other window keeps them.
      controls={<div className="spacer" />}
    >
      <div className="shape-panel">
        {/* Which pen. Two buttons rather than a checkbox: they are two things
            you are doing, not one thing you are turning on, and the one in hand
            has to be readable at a glance from across the table. */}
        <div className="obscure-pens" role="group" aria-label="What this draws">
          <button
            type="button"
            className={`obscure-pen dark${!clear ? ' on' : ''}`}
            aria-pressed={!clear}
            onClick={() => onClear(false)}
          >
            Obscure vision
          </button>
          <button
            type="button"
            className={`obscure-pen light${clear ? ' on' : ''}`}
            aria-pressed={clear}
            onClick={() => onClear(true)}
          >
            Clear vision
          </button>
        </div>
        <p className="hint">
          {clear
            ? 'Cuts back through the black. Wherever this covers, the players see the map - even under something obscured.'
            : 'Covers the map. The players see nothing at all through it.'}
        </p>

        {/* The other thing the hand can be doing. Above Create new because it
            is the state the mode opens in, and because the pair reads as one
            choice: work on what is there, or add to it.

            They are exclusive on purpose. A shape covering the whole map is a
            shape you cannot click past, so with a tool in hand the ones already
            down have to stop answering the pointer - otherwise there is nowhere
            left to begin a new one. */}
        <button
          type="button"
          className={`obscure-edit${editing ? ' active' : ''}`}
          aria-pressed={editing}
          onClick={onEditing}
        >
          Edit existing shapes
        </button>
        {editing && (
          <p className="hint">
            Click one to pick it up: move it, stretch it, turn it, or press Delete.
          </p>
        )}

        <h4>Create new</h4>
        {/* Its own class rather than the drawing panel's `shape-tools`, which is
            that panel's *root* - borrowing it here meant these buttons were
            laid out by a rule about somebody else's window and picked up none
            of its styling for the one in hand. */}
        <div className="obscure-picker">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={tool === t.kind ? 'active' : ''}
              onClick={() => onTool(tool === t.kind ? '' : t.kind)}
            >
              {t.name}
            </button>
          ))}
        </div>
        {chosen && <p className="hint">{chosen.hint}</p>}

        {/* Always here, tool or no tool: it is about the layer rather than about
            the next shape. Which is also why it is set apart from the tools
            above it - it is not one of them, and running straight on from the
            last of them read as though it were. */}
        <label className="shape-field obscure-opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={OPACITY_MIN}
            max={100}
            step={5}
            value={obscuration.opacity ?? 60}
            onChange={(e) => onOpacity(Number(e.target.value))}
          />
          <output>{obscuration.opacity ?? 60}%</output>
        </label>
        <p className="hint">
          This opacity slider is only for your view; the players always see solid black wherever obscuration is applied.
        </p>

        <div className="spacer" />

        {/* The last row: what the layer is, and the one button that decides
            whether the table sees it. Laid out like the fog panel's, which asks
            the same kind of question in the same kind of place - the state on
            the left, the button hard right, and the amber reserved for the one
            state worth being warned about. */}
        <div className="modal-actions obscure-actions">
          {on ? (
            <span className="fog-state">The table is looking at it.</span>
          ) : (
            <span className="obscure-state">
              {drawn
                ? `${drawn} ${drawn === 1 ? 'shape' : 'shapes'} drawn. ${obscuring} obscured. ${clearing} clear.`
                : 'Nothing drawn yet.'}
            </span>
          )}
          <div className="spacer" />
          {on ? (
            <button type="button" className="del" disabled={offline} onClick={() => setAsking(true)}>
              Remove Obscuration
            </button>
          ) : (
            <button type="button" disabled={offline || !drawn} onClick={() => onApply(true)}>
              Apply Obscuration
            </button>
          )}
        </div>

        {/* Handing back a blacked-out map is the same kind of act as turning the
            lights on, and gets the same question. The shapes are kept either
            way: this is about what the table can see, not about rubbing out an
            evening's work. */}
        {asking && (
          <div className="fog-confirm">
            <p>
              <strong>Show it all again?</strong> Every player sees whatever you had blacked out,
              the moment you confirm. What you have drawn is kept, so you can apply it again.
            </p>
            <div className="modal-actions">
              <button type="button" className="linky" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="del"
                onClick={() => {
                  setAsking(false);
                  onApply(false);
                }}
              >
                Remove Obscuration
              </button>
            </div>
          </div>
        )}
      </div>
    </FloatingWindow>
  );
}
