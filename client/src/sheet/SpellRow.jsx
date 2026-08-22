import { useState } from 'react';
import { Area, Select, Text } from './fields.jsx';
import CompendiumButton from './CompendiumButton.jsx';
import DiceModal from '../DiceModal.jsx';
import Shareable from './Shareable.jsx';
import { spellTemplate } from './compendium.js';
import { SPELL_CATEGORIES } from '../srd.js';
import { TO_HIT_DICE, DAMAGE_DICE, notation } from '../dice.js';
import {
  SPELL_LEVELS,
  SPELL_SCHOOLS,
  signed,
  specAbilityBonus,
  spellAttackBonus,
  spellLevelLabel,
  spellSummary,
  spellToHitBonus,
} from './rules.js';

/**
 * One spell on the sheet: a line you can read down a list, and the entry
 * underneath it.
 *
 * A spell used to be a name and a tick, which is what a printed sheet has room
 * for and is not what anybody needs when it is their turn. Everything a spell
 * says is here now, but it is folded shut: twelve boxes each on twenty spells
 * is a page nobody can scan, and the question being asked of the list is
 * usually "which one" rather than "what does it do". So the shut row is the
 * name, whether it is prepared, and the dice; open it and the entry is there.
 *
 * Open is per row and lives here rather than on the sheet: it is a thing
 * somebody is doing right now, not a fact about the character, and it has no
 * business being saved or sent to anybody else.
 */
export default function SpellRow({
  sheet,
  spell,
  readOnly,
  sharing,
  share,
  onPick,
  onPatch,
  onRemove,
  onRoll,
}) {
  const [open, setOpen] = useState(false);
  // Which dice field is being picked, if either: 'toHit' or 'damage'.
  const [picking, setPicking] = useState('');

  const components = spell.components || {};
  const summary = spellSummary(spell);
  const attackBonus = spellAttackBonus(sheet);
  const canRoll = Boolean(spell.toHit || spell.damage);

  const setComponent = (key, on) => onPatch({ components: { ...components, [key]: on } });

  return (
    <Shareable sharing={sharing} share={share} onPick={onPick}>
      <div className={`spell-row${open ? ' open' : ''}`}>
        {/* The buttons that act on the whole spell rather than on one of its
            boxes, on a line of their own at the right edge - the same strip the
            inventory and the attacks carry. It stays put whether the entry is
            folded open or shut: fetching a spell from the book is a thing you
            do to a row you have just added, which is a row nobody has opened
            yet. */}
        {!readOnly && (
          <div className="item-tools">
            <CompendiumButton
              title="Compendium: spells"
              categories={SPELL_CATEGORIES}
              emptyHint="Pick a level or a school to see the spells in it."
              onUse={(node) => onPatch(spellTemplate(node))}
            />
            <button
              className="del"
              onClick={() => onRemove(spell.id)}
              title={spell.name ? `Remove ${spell.name}` : 'Remove this spell'}
            >
              ✕
            </button>
          </div>
        )}

        <div className="spell-head">
          {/* Cantrips are never prepared - they are simply known - so the tick
              that says so is not offered on them. */}
          {spell.level > 0 && (
            <input
              type="checkbox"
              checked={Boolean(spell.prepared)}
              disabled={readOnly}
              title="Prepared"
              aria-label="Prepared"
              onChange={(e) => onPatch({ prepared: e.target.checked })}
            />
          )}
          <input
            className="spell-name"
            value={spell.name ?? ''}
            placeholder="Spell name"
            disabled={readOnly}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
          {/* Exactly the attacks' button, because it is exactly the attacks'
              question: this is a thing with dice on it and you want them
              thrown. Disabled until there are dice to throw. */}
          <button
            type="button"
            className="roll-btn"
            title={canRoll ? `Roll ${spell.name || 'this spell'}` : 'Set the dice first'}
            disabled={!canRoll}
            onClick={() => onRoll(spell)}
          >
            🎲
          </button>
          {/* Open works on a sheet somebody may only read: the entry is the
              part of a spell worth reading, and reading is what they can do. */}
          <button
            type="button"
            className="spell-open"
            aria-expanded={open}
            title={open ? 'Fold this spell away' : 'Show what this spell does'}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? '▴' : '▾'}
          </button>
        </div>

        {/* Only while it is shut: open, the boxes themselves say all of this,
            and saying it twice a line apart is noise. */}
        {!open && summary && <p className="spell-meta">{summary}</p>}

        {open && (
          <div className="spell-detail">
            <div className="spell-fields">
              {/* The level is the card this spell is sitting in, so changing it
                  here moves the spell to another card. It is on the row rather
                  than only in the list because a spell prepared at a higher
                  level is a thing that happens, and retyping the whole entry to
                  move it would not be. */}
              <Select
                label="Level"
                blank={false}
                value={String(spell.level ?? 0)}
                readOnly={readOnly}
                options={SPELL_LEVELS.map((l) => ({ value: String(l), label: spellLevelLabel(l) }))}
                onChange={(v) => onPatch({ level: Number(v) })}
              />
              <Select
                label="School"
                value={spell.school}
                readOnly={readOnly}
                options={SPELL_SCHOOLS}
                onChange={(v) => onPatch({ school: v })}
              />
              <Text
                label="Casting time"
                placeholder="1 Action"
                value={spell.castingTime}
                readOnly={readOnly}
                onChange={(v) => onPatch({ castingTime: v })}
              />
              <Text
                label="Range"
                placeholder="150 feet"
                value={spell.range}
                readOnly={readOnly}
                onChange={(v) => onPatch({ range: v })}
              />
              <Text
                label="Area"
                placeholder="30 feet"
                value={spell.area}
                readOnly={readOnly}
                onChange={(v) => onPatch({ area: v })}
              />
              <Text
                label="Duration"
                placeholder="Instantaneous"
                value={spell.duration}
                readOnly={readOnly}
                onChange={(v) => onPatch({ duration: v })}
              />
              <Text
                label="Attack/Save"
                placeholder="CON Save"
                value={spell.attackSave}
                readOnly={readOnly}
                onChange={(v) => onPatch({ attackSave: v })}
              />
              <Text
                label="Damage/Effect"
                placeholder="Necrotic"
                value={spell.damageEffect}
                readOnly={readOnly}
                onChange={(v) => onPatch({ damageEffect: v })}
              />
            </div>

            {/* Three ticks rather than a box to type "V, S, M" into: they are
                the same three every time, and the M is what decides whether
                there is anything to write on the line below. */}
            <div className="fld spell-components">
              <div className="spell-comp-boxes">
                {[
                  ['v', 'V', 'Verbal'],
                  ['s', 'S', 'Somatic'],
                  ['m', 'M', 'Material'],
                ].map(([key, letter, name]) => (
                  <label className="check" key={key} title={name}>
                    <input
                      type="checkbox"
                      checked={Boolean(components[key])}
                      disabled={readOnly}
                      onChange={(e) => setComponent(key, e.target.checked)}
                    />
                    {letter}
                  </label>
                ))}
              </div>
              <span>Components</span>
            </div>

            {/* Kept on screen after the M is unticked for as long as there is
                something written on it: hiding a box is one thing, hiding
                somebody's words is another. */}
            {(components.m || (spell.materials ?? '').trim()) && (
              <Text
                label="Material components"
                placeholder="a bit of sponge"
                value={spell.materials}
                readOnly={readOnly}
                onChange={(v) => onPatch({ materials: v })}
              />
            )}

            <div className="spell-dice">
              <label className="fld">
                <button
                  type="button"
                  className={`dice-cell${spell.toHit ? ' set' : ''}`}
                  disabled={readOnly}
                  onClick={() => setPicking('toHit')}
                >
                  {/* Everything riding on the roll printed as one term ahead of
                      the typed modifier, the way the attacks read. */}
                  {notation(spell.toHit, spellToHitBonus(sheet, spell)) || 'Set…'}
                </button>
                <span>To hit</span>
              </label>
              <label className="fld">
                <button
                  type="button"
                  className={`dice-cell${spell.damage ? ' set' : ''}`}
                  disabled={readOnly}
                  onClick={() => setPicking('damage')}
                >
                  {notation(spell.damage, specAbilityBonus(sheet, spell.damage)) || 'Set…'}
                </button>
                <span>Damage</span>
              </label>
              {/* One tick for the bonus nearly every attack spell wants:
                  proficiency plus the casting ability, worked out from the
                  sheet rather than typed, so levelling up reaches every spell
                  that asked for it. Nothing to offer until there is a
                  spellcasting ability to work it out from. */}
              <label
                className="check spell-attack-bonus"
                title={
                  attackBonus === null
                    ? 'Choose a spellcasting ability at the top of this page first'
                    : 'Adds proficiency and your casting ability to the attack roll'
                }
              >
                <input
                  type="checkbox"
                  checked={Boolean(spell.useAttackBonus)}
                  disabled={readOnly || attackBonus === null}
                  onChange={(e) => onPatch({ useAttackBonus: e.target.checked })}
                />
                Spell attack {attackBonus === null ? '' : `(${signed(attackBonus)})`}
              </label>
            </div>

            <Area
              label="Description"
              rows={5}
              value={spell.description}
              readOnly={readOnly}
              onChange={(v) => onPatch({ description: v })}
            />
          </div>
        )}

        {picking && (
          <DiceModal
            title={picking === 'toHit' ? 'Spell attack roll' : 'Spell damage'}
            // Saved onto the spell for later rather than rolled now, same as
            // the attacks: the 🎲 on the row is what throws them.
            confirmLabel="Save"
            allowed={picking === 'toHit' ? TO_HIT_DICE : DAMAGE_DICE}
            initial={spell[picking]}
            abilities={sheet.abilities}
            onClose={() => setPicking('')}
            onConfirm={(spec) => onPatch({ [picking]: spec })}
          />
        )}
      </div>
    </Shareable>
  );
}
