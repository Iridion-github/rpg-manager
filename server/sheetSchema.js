'use strict';

/**
 * The shape of a D&D 5e character sheet.
 *
 * Only *raw* values are stored. Everything the printed sheet asks you to work
 * out - ability modifiers, save and skill bonuses, proficiency bonus, passive
 * Perception, spell save DC - is derived when rendering. Storing a derived
 * number means it can disagree with the value it came from, and then you have
 * two answers and no way to tell which is right.
 */

const crypto = require('node:crypto');
const { pictureUrl } = require('./pictures');

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const MAX_ATTACKS = 24;
const MAX_SPELLS = 400;
const MAX_TEXT = 5000;

// Proficiencies, inventory and features are lists now (see pickList). One
// character's worth, not a warehouse; the description on a row is a paragraph
// about one thing rather than a page.
const MAX_ITEMS = 100;
const MAX_ITEM_TEXT = 2000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const int = (v, fallback, lo, hi) => clamp(Math.round(num(v, fallback)), lo, hi);
const text = (v, fallback = '', max = 200) => String(v ?? fallback).slice(0, max);
const block = (v) => text(v, '', MAX_TEXT);
const itemText = (v, max = 120) => text(v, '', max);

/**
 * A number somebody may simply not have filled in.
 *
 * Blank is a real answer on these rows - "a rope" is a line worth writing down
 * before you have decided how many feet of it - and it is not the same answer
 * as zero, which would print a 0 in every box on the sheet and mean "none of
 * this thing". So the empty string comes back as null and is stored as null.
 */
function optional(v, { lo, hi, whole = false }) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clamp(whole ? Math.round(n) : n, lo, hi);
}

function pickAbilities(source = {}) {
  const out = {};
  for (const key of ABILITIES) out[key] = int(source[key], 10, 1, 30);
  return out;
}

function pickSaves(source = {}) {
  const out = {};
  for (const key of ABILITIES) out[key] = Boolean(source[key]);
  return out;
}

/**
 * Skill proficiency: 0 none, 1 proficient, 2 expertise.
 *
 * Keys aren't checked against a list of the 18 skills on purpose - that list
 * lives in the client, which does the rendering, and duplicating it here just
 * creates two places to forget. Shape and volume are what matter for storage.
 */
function pickSkills(source = {}) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [key, value] of Object.entries(source).slice(0, 40)) {
    if (!/^[a-zA-Z]{2,24}$/.test(key)) continue;
    out[key] = int(value, 0, 0, 2);
  }
  return out;
}

// An attack rolls a d20 to hit; damage can be any die but a coin.
const TO_HIT_DICE = new Set([20]);
const DAMAGE_DICE = new Set([4, 6, 8, 10, 12, 20, 100]);

// A chosen roll: how many dice, which die, a modifier added once, and the
// ability whose modifier is added with it.
function pickDice(source, allowed) {
  if (!source || typeof source !== 'object') return null;
  const sides = Number(source.sides);
  if (!allowed.has(sides)) return null;
  return {
    count: int(source.count, 1, 1, 50),
    sides,
    modifier: int(source.modifier, 0, -99, 99),
    // The ability's key, never its bonus. Same rule as everything else derived
    // on this sheet: a stored +4 outlives the 18 Dexterity it was taken from,
    // and then the sheet says two different things. Empty means none, which is
    // what every attack written before this field existed says.
    ability: ABILITIES.includes(source.ability) ? source.ability : '',
  };
}

/**
 * Global modifiers: the situational things that ride along on every attack
 * this character rolls.
 *
 * Bless, Rage, a magic weapon, a bard's inspiration. Each is a name plus what
 * it adds and where it lands, and each carries its own on/off so a fight can be
 * followed without editing the list every round. `on` is the master switch: off
 * means the whole set is ignored, and the effects are kept rather than deleted
 * because a spell that ended will be cast again.
 *
 * Dice are optional. An effect can be a flat bonus, some dice, or both, but one
 * that is neither adds nothing and is not worth storing or printing.
 */
const APPLIES_TO = new Set(['toHit', 'damage', 'both']);
const MAX_MODIFIERS = 12;

function pickGlobalModifiers(source) {
  const raw = Array.isArray(source?.effects) ? source.effects : [];
  const effects = [];
  for (const item of raw.slice(0, MAX_MODIFIERS)) {
    if (!item || typeof item !== 'object') continue;
    // Zero sides is a real answer here - "no dice, just the bonus" - so this
    // cannot lean on pickDice above, which reads an unknown die as no roll.
    const sides = DAMAGE_DICE.has(Number(item.sides)) ? Number(item.sides) : 0;
    const count = sides ? int(item.count, 1, 1, 50) : 0;
    const modifier = int(item.modifier, 0, -99, 99);
    if (!sides && !modifier) continue;
    effects.push({
      id: text(item.id, '', 40) || crypto.randomUUID(),
      name: text(item.name, '', 40),
      applies: APPLIES_TO.has(item.applies) ? item.applies : 'toHit',
      // Absent means on: an effect somebody has just written down is one they
      // are about to use.
      active: item.active !== false,
      count,
      sides,
      modifier,
    });
  }
  return { on: Boolean(source?.on), effects };
}

/**
 * The armour a character owns, and which of it is on.
 *
 * A list rather than a slot, so the plate you are not wearing this week is
 * still written down. Two things can be worn at once and no more: one suit and
 * one shield, since that is how many of each a person has room for - and that
 * is checked here as well as in the browser, because a third would quietly make
 * an Armor Class nobody could account for.
 *
 * Type carries no rules of its own. It fills in what that kind of armour
 * usually does when it is picked, in the client, and every field stays
 * editable: the armour worth writing down is the piece that breaks the rule.
 */
const ARMOR_TYPES = new Set(['Clothes', 'Light', 'Medium', 'Heavy', 'Shield']);
const DEX_CAPS = new Set(['limitless', '2', '0']);
const MAX_ARMOR = 24;

function pickArmor(source) {
  if (!Array.isArray(source)) return [];
  const rows = source.slice(0, MAX_ARMOR).map((a = {}) => {
    const type = ARMOR_TYPES.has(a.type) ? a.type : 'Clothes';
    const shield = type === 'Shield';
    return {
      id: text(a.id, '', 64) || crypto.randomUUID(),
      name: text(a.name, '', 80),
      type,
      // A shield's number adds to whatever is worn under it, so it starts at
      // zero. Everything else replaces the bare 10 a body starts from, and a
      // baseline below that would be armour that makes you easier to hit.
      ac: shield ? int(a.ac, 2, 0, 99) : int(a.ac, 10, 10, 99),
      dexCap: DEX_CAPS.has(String(a.dexCap)) ? String(a.dexCap) : 'limitless',
      stealthDisadvantage: Boolean(a.stealthDisadvantage),
      equipped: Boolean(a.equipped),
      // What the piece looks like, on the same terms as the kit below it.
      media: pictureUrl(a.media),
    };
  });

  // Whichever came first keeps the slot. Anything after it is written down but
  // taken off, rather than dropped: it is armour somebody owns either way.
  let worn = false;
  let shielded = false;
  for (const row of rows) {
    if (!row.equipped) continue;
    const shield = row.type === 'Shield';
    if (shield ? shielded : worn) row.equipped = false;
    else if (shield) shielded = true;
    else worn = true;
  }
  return rows;
}

/**
 * What changes the Armor Class and isn't the armour: a ring, a cloak, a shield
 * of faith, half cover, a ruling.
 *
 * The same shape as the global modifiers on the attacks, and for the same
 * reason: several run at once and they end at different times, so each is a
 * name and a bonus carrying its own tick. `on` is the master switch, and the
 * lines are kept rather than deleted when it goes off, because a spell that
 * ended will be cast again.
 */
const MAX_AC_MODIFIERS = 12;

function pickAcModifiers(body, abilities) {
  const stored = body.acModifiers;
  if (stored && Array.isArray(stored.effects)) {
    const effects = [];
    for (const item of stored.effects.slice(0, MAX_AC_MODIFIERS)) {
      if (!item || typeof item !== 'object') continue;
      const modifier = int(item.modifier, 0, -99, 99);
      // One that adds nothing is a name beside a contribution of zero, which is
      // a line that costs a reader something and tells them nothing.
      if (!modifier) continue;
      effects.push({
        id: text(item.id, '', 40) || crypto.randomUUID(),
        name: text(item.name, '', 40),
        active: item.active !== false,
        modifier,
      });
    }
    return { on: Boolean(stored.on), effects };
  }

  // Nothing stored: this is a sheet from before the list. Whatever it was
  // holding as a single number becomes one line, switched on, so an old
  // character keeps exactly the AC they had rather than dropping to whatever
  // they happen to be wearing on the day the list arrived. Two generations of
  // it to read: an `acBonus` box, and before that the Armor Class itself as a
  // number somebody typed. The client reads it the same way for the same
  // reason, so neither of us shows a figure the other would disagree with.
  const legacy = legacyAcBonus(body, abilities);
  if (!legacy) return { on: false, effects: [] };
  return {
    on: true,
    effects: [{ id: crypto.randomUUID(), name: 'Other', active: true, modifier: legacy }],
  };
}

function legacyAcBonus(body, abilities) {
  if (body.acBonus !== undefined && body.acBonus !== null) {
    return int(body.acBonus, 0, -99, 99);
  }
  if (body.armorClass === undefined && body.ac === undefined) return 0;
  const dexMod = Math.floor((abilities.dex - 10) / 2);
  return int(int(body.armorClass ?? body.ac, 10, 0, 99) - 10 - dexMod, 0, -99, 99);
}

/**
 * The three sections that stopped being one long text box: what you are good
 * at, what you are carrying, and what you can do.
 *
 * Each is a list of rows with named fields, because that is what all three of
 * them always were - a person writing "Thieves' tools, Elvish, Dwarvish" into a
 * paragraph is keeping a list in the only place the sheet gave them. Naming the
 * fields is what lets the sheet lay them out, and lets a row be edited or
 * thrown away without retyping the ones around it.
 *
 * Every row keeps an id so the browser can key its inputs to it: without one,
 * deleting the second of four rows re-uses the third row's box for the fourth,
 * and whatever was half-typed in it jumps a line.
 *
 * ## What happens to what people already wrote
 *
 * The old value was a string, and it is still read as one - see the `fromText`
 * half of each picker below. Nothing is thrown away and nothing has to be
 * migrated in a batch: a sheet nobody opens keeps its paragraph and reads back
 * as rows, and the first save writes the rows down. The split differs by
 * section because the sections were written differently:
 *
 *   proficiencies, inventory   one row per line. These are lists people already
 *                              wrote as lists, one thing to a line.
 *   features                   one row per paragraph, its first line the title
 *                              and the rest the description - which is how a
 *                              feature is written on paper ("Darkvision" and
 *                              then what darkvision does).
 */
function rowsFromLines(value, key = 'title') {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((line) => ({ id: crypto.randomUUID(), [key]: itemText(line) }));
}

function rowsFromParagraphs(value) {
  return String(value ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((chunk) => {
      const [first, ...rest] = chunk.split('\n');
      return {
        id: crypto.randomUUID(),
        title: itemText(first.trim()),
        description: text(rest.join('\n').trim(), '', MAX_ITEM_TEXT),
      };
    });
}

/**
 * A list of rows, however it arrives: as rows, or as the paragraph it used to
 * be. Anything else at all - a number, a null, an object - is an empty list,
 * which is what a section nobody has filled in looks like.
 */
function pickList(source, mapRow, fromText) {
  if (Array.isArray(source)) {
    return source.slice(0, MAX_ITEMS).map((row) => mapRow(row && typeof row === 'object' ? row : {}));
  }
  if (typeof source === 'string' && source.trim()) return fromText(source).map(mapRow);
  return [];
}

const rowId = (row) => text(row.id, '', 64) || crypto.randomUUID();

/** "Thieves' tools", "Elvish" - a name, and as much explanation as it needs. */
const pickProficiencies = (source) =>
  pickList(
    source,
    (row) => ({
      id: rowId(row),
      title: itemText(row.title, 120),
      subtitle: itemText(row.subtitle, 120),
      description: text(row.description, '', MAX_ITEM_TEXT),
    }),
    (value) => rowsFromLines(value)
  );

/**
 * What the character is carrying. How many, what it is, and what it weighs.
 *
 * The two numbers are optional and stay optional - see `optional`. Weight
 * allows a fraction because half a pound is a real weight for the things
 * adventurers carry most of.
 */
const pickInventory = (source) =>
  pickList(
    source,
    (row) => ({
      id: rowId(row),
      quantity: optional(row.quantity, { lo: 0, hi: 99999, whole: true }),
      title: itemText(row.title, 120),
      weight: optional(row.weight, { lo: 0, hi: 99999 }),
      // What it looks like. Empty on every row written before this existed,
      // which is a thing nobody has illustrated rather than one missing its
      // picture. Held to an address on this server, like every other picture
      // the app stores; see pictures.js.
      media: pictureUrl(row.media),
    }),
    (value) => rowsFromLines(value)
  );

/** A feature, and where it came from: a class, a race, a background, a boon. */
const pickFeatures = (source) =>
  pickList(
    source,
    (row) => ({
      id: rowId(row),
      title: itemText(row.title, 120),
      source: itemText(row.source, 80),
      description: text(row.description, '', MAX_ITEM_TEXT),
    }),
    rowsFromParagraphs
  );

/**
 * Attacks used to hold free text ("+5", "1d8 + 3 slashing"). Rather than drop
 * what people already typed, read a dice spec out of it where the shape is
 * obvious - anything unparseable simply comes back empty, which is what an
 * unset attack looks like anyway.
 */
function legacyToHit(value) {
  const m = /^\s*([+-]?\d+)/.exec(String(value ?? ''));
  return m ? { count: 1, sides: 20, modifier: int(m[1], 0, -99, 99) } : null;
}

function legacyDamage(value) {
  const m = /(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?/i.exec(String(value ?? ''));
  if (!m || !DAMAGE_DICE.has(Number(m[2]))) return null;
  return {
    count: int(m[1], 1, 1, 50),
    sides: Number(m[2]),
    modifier: m[3] ? int(m[3].replace(/\s+/g, ''), 0, -99, 99) : 0,
  };
}

// Whatever is left after the dice expression is the damage type ("fire").
function legacyDamageType(value) {
  return String(value ?? '')
    .replace(/(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?/i, '')
    .replace(/^[\s+-]+/, '')
    .trim();
}

function pickAttacks(source) {
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_ATTACKS).map((a = {}) => ({
    id: text(a.id, '', 64) || crypto.randomUUID(),
    name: text(a.name, '', 80),
    toHit: pickDice(a.toHit, TO_HIT_DICE) || legacyToHit(a.bonus),
    damage: pickDice(a.damage, DAMAGE_DICE) || legacyDamage(a.damage),
    damageType: text(a.damageType ?? legacyDamageType(a.damage) ?? a.notes, '', 60),
    // A picture of the attack landing - a still or an animation - shown small
    // beside it on the sheet and in the chat line when it is thrown. Empty on
    // every attack written before this existed, which is an attack with no
    // picture rather than one missing its picture. Held to an address on this
    // server, like every other picture the app stores; see pictures.js.
    media: pictureUrl(a.media),
  }));
}

/**
 * A spell: everything the spell's entry in a book says, plus the dice for it.
 *
 * It used to be a name and a tick, which is all a printed sheet has room for.
 * A sheet on a screen has room for the entry itself, and the entry is what
 * somebody actually needs mid-turn: what it costs to cast, how far it reaches,
 * what it does to whoever is standing there.
 *
 * The school is checked against the eight because it is a closed list; nothing
 * else is. "1 Action" is the usual casting time and "1 Action, plus a Bonus
 * Action on later turns" is a real one, and a sheet that only accepted the
 * first would be a sheet people keep their odd spells off.
 *
 * A spell written before any of this existed arrives with none of these fields
 * and comes back with them empty, which is a spell nobody has written the rest
 * of down yet.
 */
const SPELL_SCHOOLS = new Set([
  'Abjuration',
  'Conjuration',
  'Divination',
  'Enchantment',
  'Evocation',
  'Illusion',
  'Necromancy',
  'Transmutation',
]);

// V, S, M. Three booleans rather than a typed string, so "V,S" and "V, S" are
// the same answer and the sheet can ask whether a spell needs materials.
const pickComponents = (source = {}) => ({
  v: Boolean(source?.v),
  s: Boolean(source?.s),
  m: Boolean(source?.m),
});

function pickSpells(source) {
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_SPELLS).map((raw) => {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      id: text(s.id, '', 64) || crypto.randomUUID(),
      level: int(s.level, 0, 0, 9), // 0 = cantrip
      name: text(s.name, '', 80),
      prepared: Boolean(s.prepared),
      school: SPELL_SCHOOLS.has(s.school) ? s.school : '',
      castingTime: text(s.castingTime, '', 60),
      range: text(s.range, '', 60),
      area: text(s.area, '', 60),
      components: pickComponents(s.components),
      materials: text(s.materials, '', 200),
      duration: text(s.duration, '', 60),
      attackSave: text(s.attackSave, '', 60),
      damageEffect: text(s.damageEffect, '', 60),
      description: text(s.description, '', MAX_ITEM_TEXT),
      // The same dice an attack carries, and stored the same way: the ability
      // by key, never its bonus.
      toHit: pickDice(s.toHit, TO_HIT_DICE),
      damage: pickDice(s.damage, DAMAGE_DICE),
      // Whether the character's spell attack bonus rides on the to-hit. A flag
      // and not a number, because the number is proficiency plus an ability
      // score and both of those move.
      useAttackBonus: Boolean(s.useAttackBonus),
    };
  });
}

function pickSlots(source = {}) {
  const out = {};
  for (let level = 1; level <= 9; level++) {
    const raw = source && source[level];
    const slot = raw && typeof raw === 'object' ? raw : {};
    const total = int(slot.total, 0, 0, 9);
    out[level] = {
      total,
      // Never more spent than there were: a level with two slots and three of
      // them used is a sheet that has lost count, and "1 of 2 left" would then
      // be a negative number on somebody's screen.
      expended: int(slot.expended, 0, 0, total),
    };
  }
  return out;
}

/**
 * Normalise whatever the client sent into a complete sheet.
 *
 * Sheets written before the 5e schema had flat `hp`/`maxHp`/`ac`/`notes`
 * fields; those are folded in rather than dropped, so an old character keeps
 * its numbers instead of silently resetting to a blank level-1 nobody.
 */
function sanitizeSheet(body = {}) {
  const legacyHp = typeof body.hp === 'number' ? body.hp : null;
  const hp = body.hp && typeof body.hp === 'object' ? body.hp : {};
  const hitDice = body.hitDice || {};
  const deathSaves = body.deathSaves || {};
  const currency = body.currency || {};
  const appearance = body.appearance || {};
  const spellcasting = body.spellcasting || {};
  const abilities = pickAbilities(body.abilities);

  return {
    // --- identity ---
    name: text(body.name, 'New Character', 120),
    // What the character looks like: an uploaded picture, kept as the address it
    // was stored at. Empty for every sheet written before this existed, which is
    // a sheet with no portrait rather than a sheet missing one.
    portraitUrl: pictureUrl(body.portraitUrl),
    class: text(body.class, '', 80),
    subclass: text(body.subclass, '', 80),
    level: int(body.level, 1, 1, 20),
    background: text(body.background, '', 80),
    playerName: text(body.playerName, '', 80),
    race: text(body.race, '', 80),
    alignment: text(body.alignment, '', 40),
    xp: int(body.xp, 0, 0, 9999999),

    // --- abilities and proficiency ---
    abilities,
    inspiration: Boolean(body.inspiration),
    saves: pickSaves(body.saves),
    skills: pickSkills(body.skills),
    // A list now, not a paragraph - and the same key, so a sheet that has one
    // written as a paragraph still finds it there. See pickList.
    otherProficiencies: pickProficiencies(body.otherProficiencies),

    // --- combat ---
    // No armorClass: it is the armour plus Dexterity plus the list below, and
    // a stored total is a total that can disagree with all three.
    armor: pickArmor(body.armor),
    acModifiers: pickAcModifiers(body, abilities),
    speed: text(body.speed, '30 ft.', 40),
    initiativeBonus: int(body.initiativeBonus, 0, -20, 20),
    hp: {
      max: int(hp.max ?? body.maxHp, 0, 0, 999),
      current: int(hp.current ?? legacyHp, 0, -99, 999),
      temp: int(hp.temp, 0, 0, 999),
    },
    hitDice: {
      die: text(hitDice.die, 'd8', 8),
      total: int(hitDice.total, 0, 0, 20),
      used: int(hitDice.used, 0, 0, 20),
    },
    deathSaves: {
      successes: int(deathSaves.successes, 0, 0, 3),
      failures: int(deathSaves.failures, 0, 0, 3),
    },
    attacks: pickAttacks(body.attacks),
    globalModifiers: pickGlobalModifiers(body.globalModifiers),

    // --- kit ---
    // The sheet calls this Inventory; the key keeps its old name so that
    // nobody's kit goes missing over a word.
    equipment: pickInventory(body.equipment),
    currency: {
      cp: int(currency.cp, 0, 0, 999999),
      sp: int(currency.sp, 0, 0, 999999),
      ep: int(currency.ep, 0, 0, 999999),
      gp: int(currency.gp, 0, 0, 999999),
      pp: int(currency.pp, 0, 0, 999999),
    },

    // --- roleplay ---
    personalityTraits: block(body.personalityTraits),
    ideals: block(body.ideals),
    bonds: block(body.bonds),
    flaws: block(body.flaws),
    featuresAndTraits: pickFeatures(body.featuresAndTraits),

    // --- page two: character detail ---
    appearance: {
      age: text(appearance.age, '', 20),
      height: text(appearance.height, '', 20),
      weight: text(appearance.weight, '', 20),
      eyes: text(appearance.eyes, '', 20),
      skin: text(appearance.skin, '', 20),
      hair: text(appearance.hair, '', 20),
    },
    appearanceNotes: block(body.appearanceNotes),
    backstory: block(body.backstory),
    alliesAndOrganizations: block(body.alliesAndOrganizations),
    additionalFeatures: block(body.additionalFeatures),
    treasure: block(body.treasure),

    // --- page three: spellcasting ---
    spellcasting: {
      class: text(spellcasting.class, '', 80),
      ability: ABILITIES.includes(spellcasting.ability) ? spellcasting.ability : '',
      slots: pickSlots(spellcasting.slots),
      spells: pickSpells(spellcasting.spells),
    },

    // Kept from the original sheet: a scratch pad is genuinely useful.
    notes: block(body.notes),
  };
}

module.exports = { sanitizeSheet, ABILITIES };
