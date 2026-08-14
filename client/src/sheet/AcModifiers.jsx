import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { signed } from './rules.js';

/**
 * Everything that changes the Armor Class and isn't the armour: a ring of
 * protection, a cloak, a shield of faith, half cover, a ruling.
 *
 * The same dialog as the global modifiers on the attacks, down to the classes
 * it is painted with, because it is the same question asked about a different
 * number: several of these are running at once and they end at different times,
 * so each is a name and a bonus with its own tick rather than one box holding a
 * total nobody can account for later.
 *
 * Cancel drops everything typed since it opened, Save keeps it, and Escape does
 * what Cancel does.
 */

const uid = () => crypto.randomUUID();

const blank = () => ({ id: uid(), name: '', active: true, modifier: 1 });

export default function AcModifiers({ effects, onSave, onClose }) {
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

  const total = draft
    .filter((e) => e.active)
    .reduce((sum, e) => sum + (Number(e.modifier) || 0), 0);

  return createPortal(
    // No dismissal on the backdrop: this holds typed work, and the pair of
    // buttons at the foot is where the asking happens.
    <div className="modal-backdrop">
      <div
        className="modal gm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Armor Class modifiers"
      >
        <div className="modal-head">
          <h2>AC modifiers</h2>
        </div>

        <p className="hint">
          Anything ticked here is added to your Armor Class, on top of the armour you have equipped.
        </p>

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
                    placeholder="Ring of protection"
                    onChange={(ev) => edit(e.id, 'name', ev.target.value)}
                    aria-label="What this modifier is called"
                  />
                </label>

                <label className="gm-field gm-bonus">
                  <span>Bonus</span>
                  <input
                    type="number"
                    min={-99}
                    max={99}
                    value={e.modifier}
                    onChange={(ev) => edit(e.id, 'modifier', Number(ev.target.value) || 0)}
                    aria-label="What it adds to Armor Class"
                  />
                </label>

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

        <button
          type="button"
          className="linky"
          onClick={() => setDraft((list) => [...list, blank()])}
        >
          + Add modifier
        </button>

        <div className="gm-summary">
          <span>
            Armor Class <b>{total ? signed(total) : 'nothing'}</b>
          </span>
        </div>

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            // One that adds nothing is dropped on the way out rather than kept
            // as a name beside a contribution of zero. The server does the same.
            onClick={() => onSave(draft.filter((e) => Number(e.modifier)))}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
