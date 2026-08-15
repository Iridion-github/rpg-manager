import { useState } from 'react';
import { Num, Select } from './fields.jsx';
import ConfirmDeleteModal from '../ConfirmDeleteModal.jsx';
import Shareable from './Shareable.jsx';
import {
  ARMOR_DEFAULTS,
  ARMOR_TYPES,
  DEX_CAPS,
  armorAcFloor,
  isShield,
} from './rules.js';

const uid = () => crypto.randomUUID();

/**
 * What the character is wearing, and the Armor Class it comes to.
 *
 * A list rather than a pair of slots: the armour you are not in this week is
 * still armour you own, and a sheet that made you retype your studded leather
 * every time you took the plate off would be a sheet people keep on paper. The
 * tick is what is worn, and only two things can be ticked at once - one suit
 * and one shield, since that is how many of each a person has room for.
 *
 * Nothing here is enforced by type. Picking one fills in what that kind of
 * armour usually does and then gets out of the way, because the armour worth
 * writing down in a campaign is the piece that breaks the rule.
 */
export default function EquippedArmor({
  armor,
  onChange,
  readOnly,
  total,
  breakdown,
  // Sharing mode, passed through: a piece of armour is a thing you show the
  // table, and the list around it is not. See Shareable.jsx.
  sharing = false,
  onPick = null,
  shareRow = null,
}) {
  // Same reasoning as the attack rows: one click, and a sheet has no undo.
  const [confirmId, setConfirmId] = useState('');
  const confirming = armor.find((a) => a.id === confirmId) || null;

  /**
   * Take off whatever else of the same kind is on.
   *
   * Shields are their own kind, which is the whole exception: a shield does not
   * compete with what is worn under it. Nothing happens when the row being
   * changed isn't itself worn - unticking one is not a reason to disturb
   * anything else.
   */
  function wearOnly(rows, id) {
    const row = rows.find((r) => r.id === id);
    if (!row?.equipped) return rows;
    return rows.map((r) =>
      r.id !== id && r.equipped && isShield(r) === isShield(row) ? { ...r, equipped: false } : r
    );
  }

  function setField(id, field, value) {
    let next = armor.map((a) => {
      if (a.id !== id) return a;
      if (field !== 'type') return { ...a, [field]: value };
      const was = ARMOR_DEFAULTS[a.type] || ARMOR_DEFAULTS.Clothes;
      const now = ARMOR_DEFAULTS[value] || ARMOR_DEFAULTS.Clothes;
      return {
        ...a,
        type: value,
        // The habits of the new type come with it, but the AC only where
        // nobody has touched it: a number somebody typed is theirs to keep,
        // and it is the one field on the row you cannot guess for them.
        ac: Number(a.ac) === was.ac ? now.ac : a.ac,
        dexCap: now.dexCap,
        stealthDisadvantage: now.stealthDisadvantage,
      };
    });
    // A shield turned into a breastplate is now competing with the breastplate
    // already on, so the same rule has to run again.
    if (field === 'type') next = wearOnly(next, id);
    onChange(next);
  }

  function toggleEquipped(id, on) {
    const next = armor.map((a) => (a.id === id ? { ...a, equipped: on } : a));
    onChange(on ? wearOnly(next, id) : next);
  }

  const add = () =>
    onChange([
      ...armor,
      { id: uid(), name: '', type: 'Clothes', ...ARMOR_DEFAULTS.Clothes, equipped: false },
    ]);

  return (
    <div className="box">
      <h4>Equipped Armor</h4>

      <ul className="armor-list">
        {armor.map((a) => (
          <Shareable
            key={a.id}
            sharing={sharing}
            share={shareRow ? shareRow(a) : null}
            onPick={onPick}
          >
          <li className={`armor-row${a.equipped ? ' worn' : ''}`}>
            <div className="armor-head">
              <label className="check" title="What the character is wearing right now">
                <input
                  type="checkbox"
                  checked={Boolean(a.equipped)}
                  disabled={readOnly}
                  onChange={(e) => toggleEquipped(a.id, e.target.checked)}
                />
                Equipped
              </label>
              <input
                className="armor-name"
                value={a.name ?? ''}
                placeholder="Armor name"
                disabled={readOnly}
                onChange={(e) => setField(a.id, 'name', e.target.value)}
              />
              {!readOnly && (
                <button
                  className="del"
                  onClick={() => setConfirmId(a.id)}
                  title={a.name ? `Remove ${a.name}` : 'Remove this armor'}
                >
                  ✕
                </button>
              )}
            </div>

            <div className="armor-fields">
              <Select
                label="Type"
                blank={false}
                value={a.type}
                options={ARMOR_TYPES}
                readOnly={readOnly}
                onChange={(v) => setField(a.id, 'type', v)}
              />
              {/* A shield adds to what is under it; everything else replaces
                  the bare 10 you start from. Named so the row says which. */}
              <Num
                label={isShield(a) ? 'AC bonus' : 'AC'}
                value={a.ac}
                min={armorAcFloor(a)}
                max={99}
                readOnly={readOnly}
                onChange={(v) => setField(a.id, 'ac', v)}
              />
              <Select
                label="Dex cap"
                blank={false}
                value={a.dexCap}
                options={DEX_CAPS}
                readOnly={readOnly}
                onChange={(v) => setField(a.id, 'dexCap', v)}
              />
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(a.stealthDisadvantage)}
                disabled={readOnly}
                onChange={(e) => setField(a.id, 'stealthDisadvantage', e.target.checked)}
              />
              Stealth disadvantage
            </label>
          </li>
          </Shareable>
        ))}
        {armor.length === 0 && <li className="empty">No armor yet.</li>}
      </ul>

      {!readOnly && <button onClick={add}>+ Armor</button>}

      {/* What the list adds up to, said here as well as in the box at the top
          of the column: this is the section somebody is looking at while they
          decide what to put on, and the answer to that is the number. */}
      <p className="ac-sum">
        Armor Class <b>{total}</b>
        <small>{breakdown}</small>
      </p>

      {confirming && (
        <ConfirmDeleteModal
          name={confirming.name || 'this armor'}
          description="This removes it from the sheet."
          confirmLabel="Remove armor"
          onConfirm={() => onChange(armor.filter((a) => a.id !== confirming.id))}
          onClose={() => setConfirmId('')}
        />
      )}
    </div>
  );
}
