import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { notation } from './dice.js';
import { extrasNotation } from './sheet/rules.js';

/**
 * The three ways a d20 can be thrown.
 *
 * One choice rather than two tickboxes, because they are not two things you
 * could have at once: 5e says advantage and disadvantage cancel, so a form that
 * let you ask for both would be a form with an answer of its own.
 *
 * Named and not explained. Everyone at the table knows what advantage is, and a
 * dialog that spelled out the rule every time you swung a sword would be one
 * more thing to read past on the way to the button.
 */
const SWINGS = [
  { key: 'normal', label: 'Normal' },
  { key: 'advantage', label: 'Advantage' },
  { key: 'disadvantage', label: 'Disadvantage' },
];

/**
 * "Roll this?" - the step between clicking something on a character sheet and
 * a result landing in the chat.
 *
 * Takes one or more prepared rolls (an attack has two: to hit and damage) and
 * confirms them together, under one set of options - a secret attack whose
 * damage everyone could see would give the game away. Cancelling does nothing
 * at all: no request, no message. Advantage and disadvantage are offered only
 * where they mean something.
 *
 * A roll can also carry `extras`: the sheet's global modifiers, already worked
 * out for that half of the attack. They are listed once each with a tick, so a
 * one-off exception - swinging without the bard's Bless this round - costs a
 * click here rather than a trip back to the sheet to turn something off and on
 * again.
 *
 * `disadvantageNote` is a reason the character starts this one at a
 * disadvantage - armour that clanks, so far. It picks Disadvantage and says
 * where that came from, and then leaves it alone: whether *this* attempt is
 * hampered is a ruling somebody makes at the table, not something a sheet gets
 * to decide, so all three answers stay one click away.
 */
export default function RollConfirmModal({
  title,
  rolls,
  allowAdvantage,
  disadvantageNote = '',
  onConfirm,
  onClose,
}) {
  // Which of the three is chosen. Normal is where every roll starts unless
  // something on the sheet says otherwise: it says what you can do, and the
  // circumstances of one attack are yours to say.
  const [swing, setSwing] = useState(disadvantageNote ? 'disadvantage' : 'normal');
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
      await onConfirm({ swing, secret, skipped });
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
                  {/* Only on the rolls it reaches: a d20 to hit swings, the
                      damage die that follows it does not. */}
                  {swing !== 'normal' && r.advantage ? ` with ${swing}` : ''}
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

        {/* Offered only where it means something - a damage die has no highest
            of two to keep - which is what `allowAdvantage` decides. It gates
            the whole choice, disadvantage included; the name is the one the
            game gives the pair. */}
        {allowAdvantage && (
          <div className="roll-swing">
            {SWINGS.map((s) => (
              <label className="check" key={s.key}>
                <input
                  type="radio"
                  name="roll-swing"
                  checked={swing === s.key}
                  onChange={() => setSwing(s.key)}
                />
                {s.label}
                {/* Beside the option it chose, so the answer and the reason for
                    it are read together. */}
                {s.key === 'disadvantage' && disadvantageNote && (
                  <span className="swing-note">{disadvantageNote}</span>
                )}
              </label>
            ))}
          </div>
        )}

        <label className="check">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
          DM only
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
