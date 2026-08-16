// What each part of a character sheet says, in words, for the chat.
//
// Kept apart from the sheet that draws it for the same reason the roll labels
// are: this is writing, not rendering. A skill list on screen is a column of
// buttons whose meaning comes from where they sit; in a chat log it has to
// carry its own meaning, and that is a different job with different answers -
// which is why "+2" on screen becomes "Acrobatics +2" here.
//
// Every builder answers the same shape: `{ title, text }`. The title is the
// character and the section, so a DM reading their own log can tell four
// characters apart; the text is already laid out with the line breaks it wants,
// because the chat preserves them.

import { characterRollLabel } from './rollLabels.js';
import { notation } from '../dice.js';
import {
  ABILITIES,
  abilityMod,
  activeAcModifiers,
  activeModifiers,
  armorClass,
  armorClassBreakdown,
  initiative,
  passivePerception,
  proficiencyBonus,
  saveBonus,
  signed,
  skillBonus,
  specAbilityBonus,
  spellAttackBonus,
  spellComponents,
  spellLevelName,
  spellSaveDc,
  spellToHitBonus,
} from './rules.js';

// A separator that is neither of the dashes this project has sworn off, and
// which the app already uses to string short facts together on one line.
const DOT = ' · ';

const clean = (v) => String(v ?? '').trim();

/** Drop the blanks and join what's left, so an unfilled field leaves no gap. */
const line = (parts) => parts.filter((p) => clean(p)).join(DOT);
const lines = (parts) => parts.filter((p) => clean(p)).join('\n');

/**
 * One thing off the sheet, ready to be said in the chat.
 *
 * `media` is the picture on the row, where the row has one - an attack, a piece
 * of kit, a suit of armour. Carried here rather than looked up when the message
 * is drawn, for the reason a roll carries its own: by the time anybody reads the
 * line, the row it came from may have been edited or deleted, and what was
 * shown is a fact about the moment it was shared.
 */
const block = (sheet, section, text, media = '') => ({
  title: characterRollLabel(sheet?.name, section),
  text: clean(text),
  ...(media ? { media } : {}),
});

/**
 * One box off the top of the sheet: the class, the race, the alignment.
 *
 * Nine of them, and each is its own thing to send. They were one block for a
 * while, on the reasoning that "who this character is" reads as a sentence -
 * but a sentence is not what gets asked for at a table. "What's your passive
 * Perception" and "what's your alignment" are the same shape of question, and
 * they should be the same shape of answer.
 */
export const shareField = (sheet, label, value) =>
  block(sheet, label, clean(value) || 'Not set.');

export const shareAbility = (sheet, ability) =>
  block(
    sheet,
    ability.label,
    `${sheet?.abilities?.[ability.key] ?? 10} (${signed(abilityMod(sheet?.abilities?.[ability.key]))})`
  );

export const shareSave = (sheet, ability) =>
  block(
    sheet,
    `${ability.label} saving throw`,
    `${signed(saveBonus(sheet, ability.key))}${sheet?.saves?.[ability.key] ? ' (proficient)' : ''}`
  );

export const shareInspiration = (sheet) =>
  block(sheet, 'Inspiration', sheet?.inspiration ? 'Yes' : 'No');

const skillRank = (sheet, skill) => Number(sheet?.skills?.[skill.key]) || 0;

export function shareSkill(sheet, skill) {
  const rank = skillRank(sheet, skill);
  const note = rank === 2 ? ' (expertise)' : rank === 1 ? ' (proficient)' : '';
  return block(sheet, skill.label, `${signed(skillBonus(sheet, skill))}${note}`);
}

export const sharePassivePerception = (sheet) =>
  block(sheet, 'Passive Perception', String(passivePerception(sheet)));

export const shareProficiencyBonus = (sheet) =>
  block(sheet, 'Proficiency bonus', signed(proficiencyBonus(sheet?.level)));

/**
 * The name is the heading, so the body is everything *except* the name.
 *
 * The same rule holds for the inventory and the features below. It only became
 * true when these started being shared one at a time: a row inside a list of
 * ten had to say what it was, and a row that is the whole message has already
 * said it, one line up.
 */
export const shareProficiency = (sheet, row) =>
  block(
    sheet,
    clean(row.title) || 'Proficiency',
    lines([clean(row.subtitle), clean(row.description)]) || 'Nothing else written down.'
  );

export const shareArmorClass = (sheet) =>
  block(sheet, 'Armor Class', `${armorClass(sheet)} (${armorClassBreakdown(sheet)})`);

export const shareInitiative = (sheet) => block(sheet, 'Initiative', signed(initiative(sheet)));

export const shareSpeed = (sheet) => block(sheet, 'Speed', clean(sheet?.speed) || 'Not set');

export function shareHitPoints(sheet) {
  const hp = sheet?.hp || {};
  return block(
    sheet,
    'Hit points',
    `${hp.current ?? 0} / ${hp.max ?? 0}${hp.temp ? ` (+${hp.temp} temporary)` : ''}`
  );
}

export function shareHitDice(sheet) {
  const dice = sheet?.hitDice || {};
  return block(
    sheet,
    'Hit dice',
    dice.total
      ? `${dice.total}${clean(dice.die)}, ${dice.used || 0} used`
      : 'None written down.'
  );
}

export function shareDeathSaves(sheet) {
  const saves = sheet?.deathSaves || {};
  return block(
    sheet,
    'Death saves',
    `${saves.successes || 0} successes, ${saves.failures || 0} failures`
  );
}

/** One attack, with its ability bonus folded in the way the sheet shows it. */
function attackText(sheet, attack) {
  const toHit = attack.toHit
    ? `To hit ${notation(attack.toHit, specAbilityBonus(sheet, attack.toHit))}`
    : '';
  const damage = attack.damage
    ? `Damage ${notation(attack.damage, specAbilityBonus(sheet, attack.damage))}${
      clean(attack.damageType) ? ` ${clean(attack.damageType)}` : ''
    }`
    : '';
  return line([toHit, damage]) || 'Nothing set';
}

export const shareAttack = (sheet, attack) =>
  block(sheet, clean(attack.name) || 'Attack', attackText(sheet, attack), attack.media);

/** What is riding along on every roll: Bless, Rage, a magic weapon. */
const effectText = (e) => {
  const dice = e.sides ? `+${e.count || 1}d${e.sides}` : '';
  const flat = e.modifier ? signed(Number(e.modifier)) : '';
  const where = e.applies === 'both' ? 'to hit and damage' : e.applies === 'damage' ? 'damage' : 'to hit';
  return `${clean(e.name) || 'Modifier'}: ${line([[dice, flat].filter(Boolean).join(' '), where])}`;
};

export const shareGlobalModifiers = (sheet) =>
  block(
    sheet,
    'Modifiers in force',
    activeModifiers(sheet).map(effectText).join('\n') || 'Nothing running.'
  );

export const shareAcModifiers = (sheet) =>
  block(
    sheet,
    'AC modifiers',
    activeAcModifiers(sheet)
      .map((e) => `${clean(e.name) || 'Other'} ${signed(Number(e.modifier) || 0)}`)
      .join('\n') || 'Nothing running.'
  );

/** One piece of armour: what it is, what it gives, and whether it is on. */
export const shareArmorPiece = (sheet, row) =>
  block(
    sheet,
    clean(row.name) || row.type || 'Armor',
    line([
      row.type === 'Shield' ? `AC ${signed(Number(row.ac) || 0)}` : `AC ${row.ac}`,
      row.type,
      row.equipped ? 'worn' : 'not worn',
      row.stealthDisadvantage ? 'stealth disadvantage' : '',
    ]),
    row.media
  );

export function shareCurrency(sheet) {
  const c = sheet?.currency || {};
  const held = ['pp', 'gp', 'ep', 'sp', 'cp']
    .filter((k) => Number(c[k]) > 0)
    .map((k) => `${c[k]} ${k}`);
  return block(sheet, 'Currency', held.join(DOT) || 'No coin.');
}

const written = (v) => v !== null && v !== undefined && v !== '';

export const shareInventoryItem = (sheet, row) =>
  block(
    sheet,
    clean(row.title) || 'Item',
    line([
      written(row.quantity) ? `${row.quantity} carried` : '',
      // Said as "each", because that is what the column means and what the
      // total at the top of the section is worked out from.
      written(row.weight) ? `${row.weight} each` : '',
    ]) || 'Nothing else written down.',
    row.media
  );

export const shareFeature = (sheet, row) =>
  block(
    sheet,
    clean(row.title) || 'Feature',
    lines([
      clean(row.source) ? `From: ${clean(row.source)}` : '',
      clean(row.description),
    ]) || 'Nothing else written down.'
  );

/** Any of the sheet's plain prose boxes: ideals, bonds, backstory, notes. */
export const shareProse = (sheet, label, value) =>
  block(sheet, label, clean(value) || 'Nothing written down.');

export function shareAppearance(sheet) {
  const a = sheet?.appearance || {};
  return block(
    sheet,
    'Appearance',
    line([
      a.age ? `Age ${clean(a.age)}` : '',
      a.height ? `Height ${clean(a.height)}` : '',
      a.weight ? `Weight ${clean(a.weight)}` : '',
      a.eyes ? `Eyes ${clean(a.eyes)}` : '',
      a.skin ? `Skin ${clean(a.skin)}` : '',
      a.hair ? `Hair ${clean(a.hair)}` : '',
    ]) || 'Nothing written down.'
  );
}

export function shareSpellcasting(sheet) {
  const casting = sheet?.spellcasting || {};
  const dc = spellSaveDc(sheet);
  const attack = spellAttackBonus(sheet);
  const ability = ABILITIES.find((a) => a.key === casting.ability);
  return block(
    sheet,
    'Spellcasting',
    line([
      clean(casting.class),
      ability ? `Ability: ${ability.label}` : '',
      dc === null ? '' : `Save DC ${dc}`,
      attack === null ? '' : `Attack ${signed(attack)}`,
    ]) || 'Not a spellcaster.'
  );
}

const ordinal = (level) => (level === 0 ? 'Cantrip' : `Level ${level}`);

/**
 * One spell, as the whole of its entry.
 *
 * This is the block sharing mode exists for. "Blight, 8th level" is not what
 * anybody asks for at a table: the question is what it does to the thing
 * standing in the cube, and the answer is four short lines and a paragraph. So
 * every box on the spell that has something in it gets said, grouped the way a
 * spell is written down - what it is, what it costs, what it needs, what it
 * does - and the ones nobody filled in leave no gap.
 */
export function shareSpell(sheet, spell) {
  const components = spellComponents(spell);
  const material = clean(spell.materials);
  const label = (name, value) => (clean(value) ? `${name} ${clean(value)}` : '');
  return block(
    sheet,
    clean(spell.name) || 'Spell',
    lines([
      line([
        spellLevelName(spell.level),
        clean(spell.school),
        spell.prepared ? 'prepared' : '',
      ]),
      line([
        label('Casting time', spell.castingTime),
        label('Range', spell.range),
        label('Area', spell.area),
        label('Duration', spell.duration),
      ]),
      // The materials in brackets after the letters they explain, which is
      // where the book puts them and the only place M means anything.
      components || material
        ? `Components ${[components, material && `(${material})`].filter(Boolean).join(' ')}`
        : '',
      // What it does rides on the dice where there are dice, the way an
      // attack's damage type does: "Damage 12d8 necrotic" is one fact said
      // once, and a lone "Necrotic" on a line of its own is a riddle.
      line([clean(spell.attackSave), spell.damage ? '' : clean(spell.damageEffect)]),
      line([
        spell.toHit ? `To hit ${notation(spell.toHit, spellToHitBonus(sheet, spell))}` : '',
        spell.damage
          ? `Damage ${notation(spell.damage, specAbilityBonus(sheet, spell.damage))}${
            clean(spell.damageEffect) ? ` ${clean(spell.damageEffect)}` : ''
          }`
          : '',
      ]),
      clean(spell.description),
    ]) || 'Nothing written down yet.'
  );
}

/** The slots at one level, which is a fact about the level and not a spell. */
export function shareSpellSlots(sheet, level) {
  const slot = sheet?.spellcasting?.slots?.[level] || {};
  const total = Number(slot.total) || 0;
  return block(
    sheet,
    `${ordinal(level)} slots`,
    total ? `${total - (slot.expended || 0)} of ${total} left` : 'None.'
  );
}
