import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { notation } from './dice.js';
import { extrasNotation } from './sheet/rules.js';

/**
 * "Roll this?" - the step between clicking something on a character sheet and
 * a result landing in the chat.
 *
 * Takes one or more prepared rolls (an attack has two: to hit and damage) and
 * confirms them together, under one set of options - a secret attack whose
 * damage everyone could see would give the game away. Cancelling does nothing
 * at all: no request, no message. Advantage is offered only where it means
 * something.
 *
 * A roll can also carry `extras`: the sheet's global modifiers, already worked
 * out for that half of the attack. They are listed once each with a tick, so a
 * one-off exception - swinging without the bard's Bless this round - costs a
 * click here rather than a trip back to the sheet to turn something off and on
 * again.
 */
export default function RollConfirmModal({ title, rolls, allowAdvantage, onConfirm, onClose }) {
  const [advantage, setAdvantage] = useState(false);
  const [secret, setSecret] = useState(false);
  const [skipped, setSkipped] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * Every modifier in play, once each.
   *
   * One that lands on both halves of an attack appears in both rolls, and two
   * ticks for one spell would be two ticks somebody has to keep in step. So the
   * list is by effect, and unticking reaches wherever that effect applies.
   */
  const effects = useMemo(() => {
    const seen = new Map();
    for (const roll of rolls) {
      for (const extra of roll.extras || []) {
        if (!seen.has(extra.id)) seen.set(extra.id, { ...extra, where: [] });
        seen.get(extra.id).where.push(roll.label);
      }
    }
    return [...seen.values()];
  }, [rolls]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id) =>
    setSkipped((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm({ advantage, secret, skipped });
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  // Into <body>, not where it was called from: the sheet this was clicked on
  // lives inside the floating window, and that window is a query container -
  // layout containment would make it the containing block for our fixed
  // backdrop and pin the dialog inside the sheet instead of over the page.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Roll ${title}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <ul className="roll-plan">
          {rolls.map((r) => {
            // What this roll is actually about to be, ticks included, so the
            // line answers the question the dialog is asking.
            const riding = extrasNotation((r.extras || []).filter((x) => !skipped.has(x.id)));
            return (
              <li key={r.key}>
                <span>{r.label}</span>
                <b>
                  {/* The ability term printed apart from the typed modifier,
                      the way the sheet prints it, so what you are confirming
                      reads like what you clicked. */}
                  {notation(r.spec, r.abilityBonus)}
                  {riding && <span className="roll-extra"> {riding}</span>}
                  {advantage && r.advantage ? ' with advantage' : ''}
                </b>
              </li>
            );
          })}
        </ul>

        {effects.length > 0 && (
          <div className="roll-mods">
            <h3>Global modifiers</h3>
            {effects.map((e) => (
              <label className="check" key={e.id}>
                <input
                  type="checkbox"
                  checked={!skipped.has(e.id)}
                  onChange={() => toggle(e.id)}
                />
                {e.label} <b>{extrasNotation([e])}</b>{' '}
                <small>{e.where.join(' and ').toLowerCase()}</small>
              </label>
            ))}
          </div>
        )}

        {allowAdvantage && (
          <label className="check">
            <input
              type="checkbox"
              checked={advantage}
              onChange={(e) => setAdvantage(e.target.checked)}
            />
            Advantage (roll 2d20, keep the highest)
          </label>
        )}

        <label className="check">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
          DM only (the rest of the table won't see this roll)
        </label>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="linky" onClick={onClose}>
            Cancel
          </button>
          <button onClick={confirm} disabled={busy}>
            {busy ? 'Rolling…' : 'Roll'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
