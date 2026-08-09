import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { notation } from './dice.js';

/**
 * "Roll this?" — the step between clicking something on a character sheet and
 * a result landing in the chat.
 *
 * Takes one or more prepared rolls (an attack has two: to hit and damage) and
 * confirms them together, under one set of options — a secret attack whose
 * damage everyone could see would give the game away. Cancelling does nothing
 * at all: no request, no message. Advantage is offered only where it means
 * something.
 */
export default function RollConfirmModal({ title, rolls, allowAdvantage, onConfirm, onClose }) {
  const [advantage, setAdvantage] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm({ advantage, secret });
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  // Into <body>, not where it was called from: the sheet this was clicked on
  // lives inside the floating window, and that window is a query container —
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
          {rolls.map((r) => (
            <li key={r.key}>
              <span>{r.label}</span>
              <b>
                {notation(r.spec)}
                {advantage && r.advantage ? ' with advantage' : ''}
              </b>
            </li>
          ))}
        </ul>

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
