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

/* ---------------------------------------------------------------------------
   Armour, and the Armor Class it adds up to.
   ------------------------------------------------------------------------ */

/**
 * The kinds of armour, and what each one usually does.
 *
 * The defaults are 5e's: light armour lets all your Dexterity through, medium
 * caps it at +2, heavy lets none of it in and clanks. Every one of them is
 * still a field on the row rather than a rule the app enforces, because the
 * interesting armour in a campaign is the piece that breaks the rule.
 */
export const ARMOR_TYPES = ['Clothes', 'Light', 'Medium', 'Heavy', 'Shield'];

export const ARMOR_DEFAULTS = {
  Clothes: { ac: 10, dexCap: 'limitless', stealthDisadvantage: false },
  Light: { ac: 11, dexCap: 'limitless', stealthDisadvantage: false },
  Medium: { ac: 14, dexCap: '2', stealthDisadvantage: false },
  Heavy: { ac: 16, dexCap: '0', stealthDisadvantage: true },
  Shield: { ac: 2, dexCap: 'limitless', stealthDisadvantage: false },
};

export const DEX_CAPS = [
  { value: 'limitless', label: 'Limitless' },
  { value: '2', label: '+2' },
  { value: '0', label: '+0' },
];

/**
 * A shield is the one type whose number adds rather than replaces: it goes on
 * top of whatever is worn under it, so it starts at 0 where a baseline starts
 * at 10. That single difference is why this is asked so often below.
 */
export const isShield = (row) => row?.type === 'Shield';

export const armorAcFloor = (row) => (isShield(row) ? 0 : 10);

export const armorAc = (row) =>
  Math.min(99, Math.max(armorAcFloor(row), Math.round(Number(row?.ac) || 0)));

const capOf = (row) => (row?.dexCap === 'limitless' ? Infinity : Number(row?.dexCap) || 0);

/** Everything currently worn. At most one body armour and at most one shield. */
export const equippedArmor = (sheet) => (sheet.armor || []).filter((a) => a.equipped);

/**
 * What the character's Armor Class is made of.
 *
 * Base + Dexterity + shield + whatever else was typed in. The base is the body
 * armour's, or a bare 10 when nothing is worn, which is where the printed sheet
 * starts you. The Dexterity cap is the tightest one among everything equipped,
 * so an unusual restriction written onto a shield still bites.
 */
export function armorClassParts(sheet) {
  const worn = equippedArmor(sheet);
  const body = worn.find((a) => !isShield(a)) || null;
  const shield = worn.find(isShield) || null;
  const dex = abilityMod(sheet.abilities?.dex);
  // A cap is a ceiling, not an eraser: a Dexterity of 8 is still a penalty in
  // plate, because what the field promises is a *maximum* bonus. A table that
  // reads heavy armour the other way can say so in Other.
  const dexApplied = Math.min(dex, Math.min(...worn.map(capOf), Infinity));
  const base = body ? armorAc(body) : 10;
  const shieldBonus = shield ? armorAc(shield) : 0;
  const other = acOther(sheet);
  return {
    body,
    shield,
    base,
    dex,
    dexApplied,
    shieldBonus,
    other,
    total: base + dexApplied + shieldBonus + other,
  };
}

export const armorClass = (sheet) => armorClassParts(sheet).total;

/**
 * Everything else that changes the Armor Class: a ring, a cloak, a shield of
 * faith, half cover, a ruling.
 *
 * A named list rather than one number, and the same shape as the global
 * modifiers on the attacks, because it answers the same kind of question: a
 * character has several of these at once and they start and stop at different
 * times. Each keeps its own tick, and `on` is the master switch, so a spell
 * that has ended costs a click rather than a line somebody has to remember to
 * type back in later.
 */
const LEGACY_AC_ID = 'legacy-ac-bonus';

/**
 * What a sheet from before the list was holding, as one number.
 *
 * Two generations of it: an `acBonus` box, and before that the Armor Class
 * itself as a number somebody typed. The typed total is read back as a bonus,
 * less the 10 and the Dexterity every character already gets, so an old sheet
 * opens showing exactly the AC it was showing before.
 */
function legacyAcBonus(sheet) {
  if (sheet.acBonus !== undefined && sheet.acBonus !== null) return Number(sheet.acBonus) || 0;
  if (sheet.armorClass === undefined || sheet.armorClass === null) return 0;
  return (Number(sheet.armorClass) || 10) - 10 - abilityMod(sheet.abilities?.dex);
}

export function acModifiers(sheet) {
  const stored = sheet.acModifiers;
  if (stored && Array.isArray(stored.effects)) {
    return { on: Boolean(stored.on), effects: stored.effects };
  }
  // Whatever the old single box held becomes one line, switched on, so the
  // number on screen does not move the day the list arrives. The id is fixed
  // rather than minted: a fresh one on every render is a fresh React key and a
  // sheet that looks edited when nobody has touched it.
  const legacy = legacyAcBonus(sheet);
  return legacy
    ? { on: true, effects: [{ id: LEGACY_AC_ID, name: 'Other', modifier: legacy, active: true }] }
    : { on: false, effects: [] };
}

/** The ones in force: the master switch on, and their own tick with it. */
export function activeAcModifiers(sheet) {
  const { on, effects } = acModifiers(sheet);
  return on ? effects.filter((e) => e.active) : [];
}

export const acOther = (sheet) =>
  activeAcModifiers(sheet).reduce((sum, e) => sum + (Number(e.modifier) || 0), 0);

/** Where the AC came from, in one line, for the box that only shows a number. */
export function armorClassBreakdown(sheet) {
  const p = armorClassParts(sheet);
  const bits = [`${p.base} ${p.body ? p.body.name || p.body.type.toLowerCase() : 'unarmoured'}`];
  bits.push(`${signed(p.dexApplied)} DEX${p.dexApplied !== p.dex ? ' (capped)' : ''}`);
  if (p.shieldBonus) bits.push(`${signed(p.shieldBonus)} ${p.shield.name || 'shield'}`);
  // Named one by one rather than added into a single "other": the point of
  // writing them down was to be able to see which is which.
  for (const e of activeAcModifiers(sheet)) {
    if (e.modifier) bits.push(`${signed(Number(e.modifier))} ${e.name || 'other'}`);
  }
  return bits.join(', ');
}

/** Whether anything worn drags Stealth down. Any one piece is enough. */
export const stealthDisadvantage = (sheet) =>
  equippedArmor(sheet).some((a) => a.stealthDisadvantage);

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

/**
 * The three sections that are lists of rows rather than paragraphs:
 * proficiencies, inventory, features.
 *
 * Read here as well as on the server, and for the reason every other legacy
 * field on this sheet is read twice: a sheet that has not been saved since the
 * change still holds a paragraph, and the browser renders what it was given
 * rather than what the server would store if asked. The two must agree about
 * what that paragraph means, or the same character reads differently depending
 * on whether anybody has touched it since. Keep this in step with pickList in
 * server/sheetSchema.js.
 *
 * The split differs by section because the sections were written differently:
 * proficiencies and inventory are lists people already kept one-to-a-line,
 * while a feature is a heading and then what it does.
 */
/**
 * The ids on a row read out of a paragraph are made from where it sits, not
 * minted fresh.
 *
 * This runs on every render for as long as the section is still a paragraph,
 * and a row's id is its React key: a new uuid each time would throw away and
 * rebuild every input in the list whenever anything else on the sheet changed,
 * which is a cursor jumping out of a box somebody is typing in. Position is
 * stable for exactly as long as it needs to be - the first edit writes real
 * rows, with real ids, and none of this runs again.
 */
const rowsFromLines = (value, prefix) =>
  String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({ id: `${prefix}-${i}`, title: line }));

const rowsFromParagraphs = (value, prefix) =>
  String(value ?? '')
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, i) => {
      const [first, ...rest] = chunk.split('\n');
      return {
        id: `${prefix}-${i}`,
        title: first.trim(),
        description: rest.join('\n').trim(),
      };
    });

const asRows = (value, fromText, prefix) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return fromText(value, prefix);
  return [];
};

export const proficiencyRows = (sheet) =>
  asRows(sheet?.otherProficiencies, rowsFromLines, 'prof');
export const inventoryRows = (sheet) => asRows(sheet?.equipment, rowsFromLines, 'item');
export const featureRows = (sheet) =>
  asRows(sheet?.featuresAndTraits, rowsFromParagraphs, 'feat');

/**
 * What the inventory weighs, all together.
 *
 * A row's weight is what *one* of that thing weighs, so it is multiplied by how
 * many there are: fifty arrows at a twentieth of a pound is the answer people
 * expect, and it is what every other sheet that has both columns does. A row
 * with no quantity written down is one of the thing; a row that says nought of
 * something contributes nothing, which is the one case where those two have to
 * be told apart.
 *
 * Null when nobody has weighed anything, rather than 0. A blank weight column
 * is a table that does not track encumbrance, and printing "Total 0" over it
 * would be the sheet answering a question nobody at that table asked.
 *
 * Rounded to two places on the way out: 0.1 + 0.2 is famously not 0.3 in binary
 * floating point, and a carried weight of 3.0000000000000004 lb is a bug
 * report waiting to be filed.
 */
export function inventoryWeight(sheet) {
  const rows = inventoryRows(sheet);
  let weighed = false;
  let total = 0;
  for (const row of rows) {
    const weight = Number(row?.weight);
    if (!Number.isFinite(weight) || row?.weight === null || row?.weight === '') continue;
    weighed = true;
    const quantity = Number(row?.quantity);
    const count = Number.isFinite(quantity) && row?.quantity !== null && row?.quantity !== ''
      ? quantity
      : 1;
    total += weight * count;
  }
  return weighed ? Math.round(total * 100) / 100 : null;
}

/** A blank sheet, matching the server's defaults. */
export function blankSheet() {
  return {
    name: '',
    portraitUrl: '',
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
    otherProficiencies: [],
    // Armor Class is worked out from these two, not typed: the armour worn, and
    // the named list for everything the armour cannot account for.
    armor: [],
    acModifiers: { on: false, effects: [] },
    speed: '30 ft.',
    initiativeBonus: 0,
    hp: { max: 0, current: 0, temp: 0 },
    hitDice: { die: 'd8', total: 1, used: 0 },
    deathSaves: { successes: 0, failures: 0 },
    attacks: [],
    // Situational things that ride along on every attack roll: Bless, Rage, a
    // magic weapon. Off and empty until somebody says otherwise.
    globalModifiers: { on: false, effects: [] },
    // What the sheet calls Inventory. The key kept its old name so that every
    // character written before the section was renamed still has their kit.
    equipment: [],
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    personalityTraits: '',
    ideals: '',
    bonds: '',
    flaws: '',
    featuresAndTraits: [],
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
