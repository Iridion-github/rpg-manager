import { notation } from '../dice.js';

/**
 * An attack with nothing on it yet: no name, no dice.
 *
 * The editors keep these - a sheet saves as you type, so the row has to exist
 * between being added and being filled in. Everything that only *reads* attacks
 * should skip them, because "Attack: no dice set" in a hover bubble is a row
 * somebody is halfway through writing, shown to somebody who cannot finish it.
 */
export const isBlankAttack = (a) => !String(a?.name || '').trim() && !a?.toHit && !a?.damage;

/**
 * One attack: a name, dice to hit, dice for damage, and what kind of damage.
 *
 * Lifted out of the character sheet when tokens grew attacks of their own. A
 * goblin on the map bites without anybody having written it a character sheet,
 * and the row that says so should be the row the sheet already uses - the same
 * fields in the same order, so somebody who has filled one in has filled both
 * in. Two hand-written copies of it would have been two rows that looked alike
 * until the first time one of them changed.
 *
 * Everything it cannot decide for itself is passed in, which is what lets the
 * same row serve a page about a character and a dialog about a piece on a
 * board:
 *
 *   `abilityBonus`  what the ability named on a dice spec is worth. On a sheet
 *                   that is the character's own modifier, printed as its own
 *                   term so the cell reads the way the roll will. A token has
 *                   no ability scores, so it says nought and the cell prints
 *                   the dice alone.
 *   `onRoll`        left off where there is nothing to roll into. The sheet
 *                   throws attacks at the chat; a form being filled in has no
 *                   business throwing anything, so it passes nothing and the
 *                   button is not drawn rather than drawn dead.
 *   `children`      whatever hangs under the row. The sheet puts the picture of
 *                   the attack landing there; a token passes nothing, because a
 *                   piece on a board is not a page about a character and the
 *                   place that picture earns its keep is the sheet.
 *   `tools`         extra buttons for the strip along the top, beside the
 *                   delete. The sheet puts the compendium there; a token has
 *                   no compendium button and passes nothing, and the strip is
 *                   drawn either way so the two rows stay the same shape.
 */
export default function AttackRow({
  attack,
  readOnly = false,
  abilityBonus = () => 0,
  onChange,
  onPickDice,
  onRemove,
  onRoll,
  tools = null,
  children,
}) {
  const a = attack;
  return (
    <li className="item-row attack-row">
      {/* The buttons, on a line of their own at the right edge. They act on the
          whole attack rather than on one of its boxes, and out here the four
          boxes get the width of the row instead of ending in a red cross that
          moves about as the row wraps. */}
      {!readOnly && (tools || onRemove) && (
        <div className="item-tools">
          {tools}
          {onRemove && (
            <button
              className="del"
              onClick={onRemove}
              title={a.name ? `Remove ${a.name}` : 'Remove this attack'}
            >
              ✕
            </button>
          )}
        </div>
      )}

      <div className="item-head">
        {onRoll && (
          <button
            type="button"
            className="roll-btn"
            title={a.toHit || a.damage ? `Roll ${a.name || 'this attack'}` : 'Set the dice first'}
            disabled={!a.toHit && !a.damage}
            onClick={() => onRoll(a)}
          >
            {/* A sword rather than a die: what this throws is an attack, and
                the die is what the chat's own roller uses for dice that are
                nobody's attack in particular. With the emoji selector on it, so
                it is drawn as the crossed swords the app's own header uses
                rather than as a thin monochrome glyph. */}
            ⚔️
          </button>
        )}

        <label className="fld item-field grow">
          <input
            value={a.name || ''}
            placeholder="Longsword"
            disabled={readOnly}
            onChange={(e) => onChange('name', e.target.value)}
          />
          <span>Name</span>
        </label>

        {/* Both dice cells read as their notation once chosen - the ability's
            own contribution shown as its own term, so the cell reads the way
            the dialog that set it did and the way the roll will. */}
        <label className="fld item-field attack-dice">
          <button
            type="button"
            className={`dice-cell${a.toHit ? ' set' : ''}`}
            disabled={readOnly}
            onClick={() => onPickDice('toHit')}
          >
            {notation(a.toHit, abilityBonus(a.toHit)) || 'Set…'}
          </button>
          <span>To hit</span>
        </label>

        <label className="fld item-field attack-dice">
          <button
            type="button"
            className={`dice-cell${a.damage ? ' set' : ''}`}
            disabled={readOnly}
            onClick={() => onPickDice('damage')}
          >
            {notation(a.damage, abilityBonus(a.damage)) || 'Set…'}
          </button>
          <span>Damage</span>
        </label>

        <label className="fld item-field attack-type">
          <input
            value={a.damageType || ''}
            placeholder="fire"
            disabled={readOnly}
            onChange={(e) => onChange('damageType', e.target.value)}
          />
          <span>Type</span>
        </label>

      </div>

      {/* What the boxes cannot hold: the reach, the properties, the die it
          rolls in two hands, the ruling your DM made. Filled in for you when
          the row came from the compendium.
          Left out entirely where there is nothing in it and nothing can be
          typed - a sheet somebody may only read, or the linked character's
          attacks listed above a token's own - since an empty disabled box says
          nothing and there is one of these per attack. */}
      {(!readOnly || a.description) && (
      <label className="fld item-area">
        <textarea
          rows={2}
          value={a.description || ''}
          placeholder="Reach, properties, anything the boxes cannot say"
          disabled={readOnly}
          onChange={(e) => onChange('description', e.target.value)}
        />
        <span>Description</span>
      </label>
      )}

      {children}
    </li>
  );
}
