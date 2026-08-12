import { useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * What a creature rolled, asked on its own.
 *
 * The token form already has these three fields, but that form is the DM's -
 * it also sets what a token looks like, how big it is and who it belongs to.
 * This is the part a player may answer about their own character, so it is its
 * own small dialog rather than a version of the big one with most of it greyed
 * out.
 *
 * Two halves and a total, exactly as the token form has them: fill the die and
 * the modifier and the total follows, because a tie is settled by the modifier
 * and 18+7 beats 22+3. Fill neither and a bare total still works, which is what
 * somebody who rolled on the table in front of them will type.
 */

const blankToNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

export default function InitiativeModal({ token, onSubmit, onClose }) {
  const [total, setTotal] = useState(token?.initiative ?? '');
  const [die, setDie] = useState(token?.initiativeDie ?? '');
  const [mod, setMod] = useState(token?.initiativeMod ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Both halves known means the total is theirs to decide, not yours to type.
  const rolled = die !== '' && mod !== '' ? Number(die) + Number(mod) : null;

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        initiative: rolled === null ? blankToNull(total) : rolled,
        initiativeDie: blankToNull(die),
        initiativeMod: blankToNull(mod),
      });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal token-form" role="dialog" aria-modal="true" onSubmit={submit}>
        <div className="modal-head">
          <h2>Initiative - {token.label}</h2>
          <button type="button" className="linky" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="token-field">
          <span>Initiative</span>
          <span className="token-stat">
            {rolled === null ? (
              <input
                autoFocus
                type="number"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                placeholder="-"
                aria-label="Initiative total"
              />
            ) : (
              <output className="token-total">{rolled}</output>
            )}
            <small>=</small>
            <input
              type="number"
              value={die}
              onChange={(e) => setDie(e.target.value)}
              placeholder="die"
              aria-label="Initiative die roll"
            />
            <small>+</small>
            <input
              type="number"
              value={mod}
              onChange={(e) => setMod(e.target.value)}
              placeholder="mod"
              aria-label="Initiative modifier"
            />
          </span>
        </div>

        <p className="hint">
          Leave it empty and this token isn't in the fight at all - the turn order only holds
          what has a score.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save initiative'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
