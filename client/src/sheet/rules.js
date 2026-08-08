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

/** Always show a sign — a bonus of 0 reads as "+0", never a bare "0". */
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
