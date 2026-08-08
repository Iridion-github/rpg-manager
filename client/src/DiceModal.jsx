import { useEffect, useRef, useState } from 'react';
import {
  DICE_OPTIONS,
  MAX_DICE,
  MAX_MODIFIER,
  clampDice as clamp,
  signedMod as signed,
  notation,
} from './dice.js';

/**
 * Pick a number of dice, a die, and a modifier.
 *
 * Used two ways: the chat roller confirms by *rolling*, and an attack row
 * confirms by *storing* the spec for later. Same controls either way — the
 * caller supplies the wording and what confirming means.
 */
export default function DiceModal({
  title = 'Roll dice',
  confirmLabel = 'Roll',
  allowed, // sides to offer; defaults to all of them
  initial,
  onClose,
  onConfirm,
}) {
  const options = allowed
    ? DICE_OPTIONS.filter((d) => allowed.includes(d.sides))
    : DICE_OPTIONS;

  const [count, setCount] = useState(initial?.count ?? 1);
  const [sides, setSides] = useState(initial?.sides ?? options[options.length - 1].sides);
  const [modifier, setModifier] = useState(initial?.modifier ?? 0);
  // What the modifier field shows while typing. Kept separate from the number
  // so half-finished input like "-" isn't parsed and rewritten under the cursor.
  const [modText, setModText] = useState(signed(initial?.modifier ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const firstRef = useRef(null);
  const isCoin = sides === 2;

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = { count, sides, modifier: isCoin ? 0 : modifier };

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

  return (
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop dismisses —
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

        {/* With only one die on offer there is nothing to choose — show it, but
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

        <p className="dice-preview">{notation(spec)}</p>

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
    </div>
  );
}
