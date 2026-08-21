import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAMAGE_DICE } from '../dice.js';
import { MODIFIER_TARGETS, extrasNotation, modifierExtras, modifierTargets } from './rules.js';

/**
 * The situational things that ride along on every roll this character makes.
 *
 * A list rather than one setting, because a fight has several running at once
 * and they end at different times: Bless on the to-hit and the saves, Rage on
 * the damage, a magic weapon on both halves of an attack, Guidance on the
 * checks. Each is a name, whichever rolls it lands on, and what it adds, and
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
  applies: ['toHit'],
  active: true,
  count: 1,
  sides: 0,
  modifier: 0,
});

export default function GlobalModifiers({ effects, onSave, onClose }) {
  // Edited in a copy, so Cancel is a real cancel rather than an undo somebody
  // has to perform themselves. Every row's destinations are put in list form on
  // the way in, so nothing below has to know that a sheet written before this
  // change holds a single word there - and saving one writes the new shape.
  const [draft, setDraft] = useState(() =>
    effects.map((e) => ({ ...e, applies: modifierTargets(e) }))
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edit = (id, field, value) =>
    setDraft((list) => list.map((e) => (e.id === id ? { ...e, [field]: value } : e)));

  /**
   * Tick or untick one destination.
   *
   * The last one standing cannot be unticked - its box is disabled - because a
   * modifier that lands nowhere is a row you wrote down, can see in the list,
   * and would then watch do nothing on every roll you made. Refused at the box
   * rather than at Save, so the rule is visible while you are working instead
   * of arriving as a complaint afterwards. The guard here is the belt to that
   * brace.
   */
  const toggleTarget = (id, target) =>
    setDraft((list) =>
      list.map((e) => {
        if (e.id !== id) return e;
        const now = e.applies;
        if (now.includes(target)) {
          return now.length > 1 ? { ...e, applies: now.filter((t) => t !== target) } : e;
        }
        // Rebuilt in the canonical order rather than appended to, so what is
        // stored does not depend on which box somebody happened to tick first.
        const wanted = new Set([...now, target]);
        return { ...e, applies: MODIFIER_TARGETS.map((t) => t.value).filter((t) => wanted.has(t)) };
      })
    );

  // What the ticked ones come to, which is the question the list is really
  // being asked. All four destinations are shown, empty ones included, so the
  // answer is complete: a reader who sees only "to hit +1d4" cannot tell
  // whether the other lines are empty or simply not mentioned.
  const ticked = draft.filter((e) => e.active);
  const totals = MODIFIER_TARGETS.map((t) => ({
    label: t.label,
    text: extrasNotation(modifierExtras(ticked, t.value)),
  }));

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
          Each of these is added to every roll it applies to, until you untick it. Tick as many as
          it lands on: to hit, damage, checks (abilities, skills and initiative) and saving throws.
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

                {/* Not a label, for the reason the dice pair below is not one:
                    four controls, and a label can only speak for the first of
                    them. The group carries the name instead. */}
                <div
                  className="gm-field gm-where"
                  role="group"
                  aria-label={`Which rolls ${e.name || 'this modifier'} lands on`}
                >
                  <span>Applies to</span>
                  <div className="gm-where-set">
                    {MODIFIER_TARGETS.map((t) => {
                      const on = e.applies.includes(t.value);
                      const last = on && e.applies.length === 1;
                      return (
                        <label className="gm-where-opt" key={t.value}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={last}
                            title={last ? 'A modifier has to land on something' : undefined}
                            onChange={() => toggleTarget(e.id, t.value)}
                          />
                          {t.label}
                        </label>
                      );
                    })}
                  </div>
                </div>

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
          {totals.map((t) => (
            <span key={t.label}>
              {t.label} <b>{t.text || 'nothing'}</b>
            </span>
          ))}
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
