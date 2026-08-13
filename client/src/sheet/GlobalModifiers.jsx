import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAMAGE_DICE } from '../dice.js';
import { extrasNotation, modifierExtras } from './rules.js';

/**
 * The situational things that ride along on every attack this character rolls.
 *
 * A list rather than one setting, because a fight has several running at once
 * and they end at different times: Bless on the to-hit, Rage on the damage, a
 * magic weapon on both. Each is a name, where it lands, and what it adds, and
 * each keeps its own tick so a round can be played without editing anything.
 *
 * Fixed and centred, and not one of the app's floating windows: those can be
 * dragged, stretched and rolled up, and this is a form you finish rather than a
 * panel you work beside. It leaves by its own two buttons - Cancel drops
 * everything typed since it opened, Save keeps it - and by Escape, which does
 * what Cancel does. Escape is left in on purpose: every other dialog here
 * answers to it, and a form with no way out but the mouse is a trap the first
 * time something goes wrong in it.
 */

const uid = () => crypto.randomUUID();

// What one effect looks like before anybody has said anything about it. To hit
// rather than damage because the commonest of these - Bless, a bardic die, a
// +1 weapon - is asked about the attack roll first.
const blank = () => ({
  id: uid(),
  name: '',
  applies: 'toHit',
  active: true,
  count: 1,
  sides: 0,
  modifier: 0,
});

const WHERE = [
  { value: 'toHit', label: 'To hit' },
  { value: 'damage', label: 'Damage' },
  { value: 'both', label: 'Both' },
];

export default function GlobalModifiers({ effects, onSave, onClose }) {
  // Edited in a copy, so Cancel is a real cancel rather than an undo somebody
  // has to perform themselves.
  const [draft, setDraft] = useState(() => effects.map((e) => ({ ...e })));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edit = (id, field, value) =>
    setDraft((list) => list.map((e) => (e.id === id ? { ...e, [field]: value } : e)));

  // What the ticked ones come to, which is the question the list is really
  // being asked. Shown for both halves so the answer is complete: a reader who
  // sees only "to hit +1d4" cannot tell whether the damage line is empty or
  // simply not mentioned.
  const ticked = draft.filter((e) => e.active);
  const toHit = extrasNotation(modifierExtras(ticked, 'toHit'));
  const damage = extrasNotation(modifierExtras(ticked, 'damage'));

  return createPortal(
    // No dismissal on the backdrop: this holds typed work, and every other
    // dialog that does the same asks before dropping it. Here the asking is the
    // pair of buttons at the foot.
    <div className="modal-backdrop">
      <div className="modal gm-modal" role="dialog" aria-modal="true" aria-label="Global modifiers">
        <div className="modal-head">
          <h2>Global modifiers</h2>
        </div>

        <p className="hint">
          Anything ticked here is added to every attack you roll from this sheet, until you untick
          it.
        </p>

        {/* Each effect is a block of labelled fields rather than a row in a
            table with headings of its own. Headings above columns only work
            while the columns stay put, and these have to be free to wrap onto a
            second line when the dialog is narrow; a caption that stayed at the
            top while its field moved down would be worse than no caption. Every
            field carries its own, so a wrapped row reads the same as a whole
            one. */}
        {draft.length > 0 && (
          <div className="gm-list">
            {draft.map((e) => (
              <div className="gm-row" key={e.id}>
                <label className="gm-field gm-on">
                  <span>On</span>
                  <input
                    type="checkbox"
                    checked={e.active}
                    onChange={(ev) => edit(e.id, 'active', ev.target.checked)}
                    aria-label={`${e.name || 'This modifier'} is in force`}
                  />
                </label>

                <label className="gm-field gm-name">
                  <span>Name</span>
                  <input
                    value={e.name}
                    maxLength={40}
                    placeholder="Bless"
                    onChange={(ev) => edit(e.id, 'name', ev.target.value)}
                    aria-label="What this modifier is called"
                  />
                </label>

                <label className="gm-field gm-where">
                  <span>Applies to</span>
                  <select
                    value={e.applies}
                    onChange={(ev) => edit(e.id, 'applies', ev.target.value)}
                    aria-label="Which roll this modifier lands on"
                  >
                    {WHERE.map((w) => (
                      <option key={w.value} value={w.value}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="gm-field gm-bonus">
                  <span>Bonus</span>
                  <input
                    type="number"
                    min={-99}
                    max={99}
                    value={e.modifier}
                    onChange={(ev) => edit(e.id, 'modifier', Number(ev.target.value) || 0)}
                    aria-label="Flat bonus"
                  />
                </label>

                {/* Not a label: two controls, and one label can only speak for
                    the first of them - the same rule the token form follows. */}
                <div className="gm-field gm-dice">
                  <span>Extra dice</span>
                  <div className="gm-dice-pair">
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={e.count}
                      // Meaningless without a die beside it, so it waits for one
                      // rather than offering a count of nothing.
                      disabled={!e.sides}
                      onChange={(ev) => edit(e.id, 'count', Number(ev.target.value) || 1)}
                      aria-label="How many extra dice"
                    />
                    <select
                      value={e.sides}
                      onChange={(ev) => edit(e.id, 'sides', Number(ev.target.value))}
                      aria-label="Which extra die"
                    >
                      <option value={0}>none</option>
                      {DAMAGE_DICE.map((sides) => (
                        <option key={sides} value={sides}>
                          d{sides}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  className="del gm-del"
                  onClick={() => setDraft((list) => list.filter((x) => x.id !== e.id))}
                  aria-label={`Remove ${e.name || 'this modifier'}`}
                  title={`Remove ${e.name || 'this modifier'}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <button type="button" className="linky" onClick={() => setDraft((list) => [...list, blank()])}>
          + Add modifier
        </button>

        {/* The arithmetic done for you, because the point of the list is the
            two numbers at the bottom of it and nobody should have to add up
            their own modifiers mid-fight. */}
        <div className="gm-summary">
          <span>
            To hit <b>{toHit || 'nothing'}</b>
          </span>
          <span>
            Damage <b>{damage || 'nothing'}</b>
          </span>
        </div>

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              // An effect that adds nothing at all is dropped on the way out
              // rather than saved as a line that would print its name beside a
              // contribution of zero. The server does the same.
              onSave(draft.filter((e) => e.sides || e.modifier))
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
