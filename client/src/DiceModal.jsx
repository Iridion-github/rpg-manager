import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';
import {
  DICE_OPTIONS,
  MAX_DICE,
  MAX_MODIFIER,
  clampDice as clamp,
  signedMod as signed,
  notation,
} from './dice.js';
import { ABILITIES, abilityMod } from './sheet/rules.js';

/**
 * Pick a number of dice, a die, and a modifier.
 *
 * Used two ways: the chat roller confirms by *rolling*, and an attack row
 * confirms by *storing* the spec for later. Same controls either way - the
 * caller supplies the wording and what confirming means.
 *
 * `abilities` are a character's six scores, and passing them is what adds the
 * Attribute row. Only an attack on a sheet has an ability to key off; a roll
 * typed into the chat belongs to nobody in particular, so it is not offered
 * one and the dialog is exactly what it was.
 */
export default function DiceModal({
  title = 'Roll dice',
  confirmLabel = 'Roll',
  allowed, // sides to offer; defaults to all of them
  initial,
  abilities,
  onClose,
  onConfirm,
}) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  const options = allowed
    ? DICE_OPTIONS.filter((d) => allowed.includes(d.sides))
    : DICE_OPTIONS;

  const [count, setCount] = useState(initial?.count ?? 1);
  const [sides, setSides] = useState(initial?.sides ?? options[options.length - 1].sides);
  const [modifier, setModifier] = useState(initial?.modifier ?? 0);
  // What the modifier field shows while typing. Kept separate from the number
  // so half-finished input like "-" isn't parsed and rewritten under the cursor.
  const [modText, setModText] = useState(signed(initial?.modifier ?? 0));
  // Which ability's modifier rides on this roll, by key. Empty is None, which
  // is what every spec made before this existed says.
  const [ability, setAbility] = useState(initial?.ability ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const firstRef = useRef(null);
  const isCoin = sides === 2;
  // A coin has no total to add to, so it has no ability either - the same rule
  // the modifier follows two fields down.
  const bonus = ability && !isCoin ? abilityMod(abilities?.[ability]) : 0;

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = { count, sides, modifier: isCoin ? 0 : modifier, ability: isCoin ? '' : ability };

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(spec);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  // Rendered into <body> rather than where it was called from. This dialog can
  // be opened from inside the floating character-sheet window, and that window
  // is a query container - which means layout containment, which means it would
  // otherwise become the containing block for `position: fixed` and trap the
  // backdrop inside itself instead of over the page.
  return createPortal(
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop dismisses -
      // otherwise a text selection that drifts outside closes the dialog.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="dice-field">
          <span>How many</span>
          <input
            ref={firstRef}
            type="number"
            min="1"
            max={MAX_DICE}
            value={count}
            onChange={(e) => setCount(clamp(Math.round(Number(e.target.value) || 1), 1, MAX_DICE))}
          />
        </label>

        {/* With only one die on offer there is nothing to choose - show it, but
            don't pretend it's a decision. */}
        <div className="dice-field">
          <span>Which die</span>
          <div className="dice-choices">
            {options.map((d) => (
              <button
                key={d.sides}
                type="button"
                className={sides === d.sides ? 'active' : ''}
                disabled={options.length === 1}
                onClick={() => setSides(d.sides)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* Between the die and the modifier, which is the order the preview
            reads in. Only when the caller has a character to take the scores
            from - see the note on `abilities` above. */}
        {abilities && (
          <label className="dice-field">
            <span>Attribute</span>
            <select
              className="dice-ability"
              value={ability}
              disabled={isCoin}
              title={isCoin ? 'A coin has no value to modify' : "Adds that ability's modifier"}
              onChange={(e) => setAbility(e.target.value)}
            >
              <option value="">None</option>
              {ABILITIES.map((a) => (
                <option key={a.key} value={a.key}>
                  {/* The bonus in the label, so the choice can be made without
                      going back to the sheet to work out what it is worth. */}
                  {a.label} ({signed(abilityMod(abilities[a.key]))})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="dice-field">
          <span>Modifier</span>
          <input
            type="text"
            inputMode="numeric"
            className="dice-mod"
            value={isCoin ? '+0' : modText}
            disabled={isCoin}
            title={isCoin ? 'A coin has no value to modify' : 'Added once to the total'}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9+-]/g, '');
              setModText(raw);
              const n = Number(raw.replace(/^\+/, ''));
              if (raw && raw !== '+' && raw !== '-' && Number.isFinite(n)) {
                setModifier(clamp(Math.round(n), -MAX_MODIFIER, MAX_MODIFIER));
              }
            }}
            // Settle on the canonical signed form once they're done typing.
            onBlur={() => setModText(signed(modifier))}
          />
        </label>

        <p className="dice-preview">{notation(spec, bonus)}</p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="linky" onClick={onClose}>
            Cancel
          </button>
          <button onClick={confirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
