import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { usePortalTarget } from './portalTarget.js';
import { characterRollLabel } from './sheet/rollLabels.js';

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
 *
 * Or don't type any of it: Roll it throws the d20 here, puts the result in the
 * chat where the table can see it, and writes the two halves onto the token in
 * one go. That is the ordinary case for a monster nobody is keeping a sheet
 * for - the DM has a dozen of them to get into the order, and typing a number
 * they have just watched a die produce is a step with nothing in it.
 */

const blankToNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

export default function InitiativeModal({ token, onSubmit, onClose }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  const [total, setTotal] = useState(token?.initiative ?? '');
  const [die, setDie] = useState(token?.initiativeDie ?? '');
  const [mod, setMod] = useState(token?.initiativeMod ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Both halves known means the total is theirs to decide, not yours to type.
  const rolled = die !== '' && mod !== '' ? Number(die) + Number(mod) : null;

  /**
   * Throw it now: into the chat, and onto the token.
   *
   * The modifier has to be the one the *server* will store, which is not always
   * the one in the box. A token holding a character takes its modifier from
   * that character - dexterity plus a bonus, worked out rather than typed - and
   * the route that saves this says so outright: "a linked token's modifier is
   * its sheet's, whatever the request says". Roll with the number in the box
   * and a DM who had cleared it would watch 1d20 land on 17 in the chat and the
   * token settle on 20. So a linked token rolls with what the sheet gave it,
   * and the box is corrected to match rather than quietly ignored.
   *
   * Empty means none, not "don't roll": a goblin with no modifier still rolls
   * a d20.
   *
   * The order matters. The die is thrown first, because that is the part that
   * cannot be done again: a second attempt would be a different number, and a
   * DM who rerolls because a save failed is a DM rerolling their own initiative
   * until they like it. So the result is written into the fields *before* it is
   * saved - if the save then fails, the dialog stays open with the number the
   * table has already seen sitting in it, and Save will try again with exactly
   * that.
   */
  async function rollIt() {
    if (busy) return;
    setBusy(true);
    setError('');
    const modifier = token.sheetId ? Number(token.initiativeMod) || 0 : Number(mod) || 0;
    let thrown;
    try {
      const { roll } = await api.rollDice({
        count: 1,
        sides: 20,
        modifier,
        label: characterRollLabel(token.label, 'Initiative'),
      });
      thrown = { die: roll.rolls[0], total: roll.total };
      setDie(String(thrown.die));
      setMod(String(modifier));
      setTotal(String(thrown.total));
    } catch (err) {
      // Nothing was rolled, so there is nothing to write down.
      setError(err.message);
      setBusy(false);
      return;
    }
    try {
      await onSubmit({
        initiative: thrown.total,
        initiativeDie: thrown.die,
        initiativeMod: modifier,
      });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

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
          {/* At the far end from Save, with the spacer between: it is not a
              second way of finishing the form, it is the thing that fills it
              in. */}
          <button type="button" className="roll-btn init-roll" onClick={rollIt} disabled={busy}>
            🎲 Roll it
          </button>
          <div className="spacer" />
          <button type="button" className="linky" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save initiative'}
          </button>
        </div>
      </form>
    </div>,
    portalTarget
  );
}
