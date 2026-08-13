// D&D 5e rules maths.
//
// Everything here is *derived* from the stored sheet. None of it is saved: a
// stored modifier is a modifier that can disagree with the score it came from.

export const ABILITIES = [
  { key: 'str', label: 'Strength' },
  { key: 'dex', label: 'Dexterity' },
  { key: 'con', label: 'Constitution' },
  { key: 'int', label: 'Intelligence' },
  { key: 'wis', label: 'Wisdom' },
  { key: 'cha', label: 'Charisma' },
];

// The 18 skills, each tied to the ability it keys off.
export const SKILLS = [
  { key: 'acrobatics', label: 'Acrobatics', ability: 'dex' },
  { key: 'animalHandling', label: 'Animal Handling', ability: 'wis' },
  { key: 'arcana', label: 'Arcana', ability: 'int' },
  { key: 'athletics', label: 'Athletics', ability: 'str' },
  { key: 'deception', label: 'Deception', ability: 'cha' },
  { key: 'history', label: 'History', ability: 'int' },
  { key: 'insight', label: 'Insight', ability: 'wis' },
  { key: 'intimidation', label: 'Intimidation', ability: 'cha' },
  { key: 'investigation', label: 'Investigation', ability: 'int' },
  { key: 'medicine', label: 'Medicine', ability: 'wis' },
  { key: 'nature', label: 'Nature', ability: 'int' },
  { key: 'perception', label: 'Perception', ability: 'wis' },
  { key: 'performance', label: 'Performance', ability: 'cha' },
  { key: 'persuasion', label: 'Persuasion', ability: 'cha' },
  { key: 'religion', label: 'Religion', ability: 'int' },
  { key: 'sleightOfHand', label: 'Sleight of Hand', ability: 'dex' },
  { key: 'stealth', label: 'Stealth', ability: 'dex' },
  { key: 'survival', label: 'Survival', ability: 'wis' },
];

export const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
];

export const SPELL_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Ability modifier: (score − 10) halved, rounded down. Floor, so 9 → −1. */
export const abilityMod = (score) => Math.floor(((Number(score) || 10) - 10) / 2);

/** Proficiency bonus by character level: +2 at 1st, +1 more every 4 levels. */
export const proficiencyBonus = (level) =>
  2 + Math.floor((Math.min(20, Math.max(1, Number(level) || 1)) - 1) / 4);

/** Always show a sign - a bonus of 0 reads as "+0", never a bare "0". */
export const signed = (n) => (n < 0 ? `${n}` : `+${n}`);

export function saveBonus(sheet, ability) {
  const proficient = Boolean(sheet.saves?.[ability]);
  return abilityMod(sheet.abilities?.[ability]) + (proficient ? proficiencyBonus(sheet.level) : 0);
}

export function skillBonus(sheet, skill) {
  // 0 none, 1 proficient, 2 expertise (double proficiency).
  const rank = Number(sheet.skills?.[skill.key]) || 0;
  return abilityMod(sheet.abilities?.[skill.ability]) + rank * proficiencyBonus(sheet.level);
}

/** Passive Perception is 10 + the Perception bonus. */
export const passivePerception = (sheet) =>
  10 + skillBonus(sheet, SKILLS.find((s) => s.key === 'perception'));

export const initiative = (sheet) =>
  abilityMod(sheet.abilities?.dex) + (Number(sheet.initiativeBonus) || 0);

export const spellSaveDc = (sheet) =>
  sheet.spellcasting?.ability
    ? 8 + proficiencyBonus(sheet.level) + abilityMod(sheet.abilities?.[sheet.spellcasting.ability])
    : null;

export const spellAttackBonus = (sheet) =>
  sheet.spellcasting?.ability
    ? proficiencyBonus(sheet.level) + abilityMod(sheet.abilities?.[sheet.spellcasting.ability])
    : null;

/**
 * What the ability a dice spec names is worth, or zero when it names none.
 *
 * The spec stores the ability's *key* and this works the number out, for the
 * reason at the top of this file: a stored +4 outlives the 18 Dexterity it came
 * from, and then the sheet says two things at once. Levelling up or drinking a
 * belt of giant strength changes every attack that asked for it, with nothing
 * to go and edit.
 */
export const specAbilityBonus = (sheet, spec) =>
  spec?.ability ? abilityMod(sheet?.abilities?.[spec.ability]) : 0;

/**
 * The global modifiers in force right now.
 *
 * Two switches have to agree: the section's own, which turns the whole idea on,
 * and the effect's, which says whether this one is running. Both because a
 * fight is a sequence of things starting and stopping - Bless lands, Rage ends
 * - and turning the set off wholesale between fights should not cost you the
 * list you built.
 */
export const activeModifiers = (sheet) =>
  sheet.globalModifiers?.on ? (sheet.globalModifiers.effects || []).filter((e) => e.active) : [];

/** Those of them that land on one half of an attack, shaped as roll extras. */
export const modifierExtras = (effects, which) =>
  effects
    .filter((e) => e.applies === which || e.applies === 'both')
    .map((e) => ({
      id: e.id,
      label: e.name || 'Modifier',
      count: e.count || 0,
      sides: e.sides || 0,
      modifier: e.modifier || 0,
    }));

/**
 * What a set of extras comes to, said the way a dice field says it: "+1d4 +2".
 *
 * The dice stay separate rather than being counted up, because 1d4 and 1d6 are
 * not 2 of anything; the flat bonuses do add up, because they are all just
 * numbers. Empty when nothing applies, which is what hides the line.
 */
export function extrasNotation(extras = []) {
  const dice = extras.filter((e) => e.sides).map((e) => `+${e.count}d${e.sides}`);
  const flat = extras.reduce((sum, e) => sum + (e.modifier || 0), 0);
  return [...dice, ...(flat ? [signed(flat)] : [])].join(' ');
}

/** A blank sheet, matching the server's defaults. */
export function blankSheet() {
  return {
    name: '',
    class: '',
    subclass: '',
    level: 1,
    background: '',
    playerName: '',
    race: '',
    alignment: '',
    xp: 0,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    inspiration: false,
    saves: { str: false, dex: false, con: false, int: false, wis: false, cha: false },
    skills: {},
    otherProficiencies: '',
    armorClass: 10,
    speed: '30 ft.',
    initiativeBonus: 0,
    hp: { max: 0, current: 0, temp: 0 },
    hitDice: { die: 'd8', total: 1, used: 0 },
    deathSaves: { successes: 0, failures: 0 },
    attacks: [],
    // Situational things that ride along on every attack roll: Bless, Rage, a
    // magic weapon. Off and empty until somebody says otherwise.
    globalModifiers: { on: false, effects: [] },
    equipment: '',
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    personalityTraits: '',
    ideals: '',
    bonds: '',
    flaws: '',
    featuresAndTraits: '',
    appearance: { age: '', height: '', weight: '', eyes: '', skin: '', hair: '' },
    appearanceNotes: '',
    backstory: '',
    alliesAndOrganizations: '',
    additionalFeatures: '',
    treasure: '',
    spellcasting: { class: '', ability: '', slots: {}, spells: [] },
    notes: '',
  };
}
