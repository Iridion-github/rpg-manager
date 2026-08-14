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

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const MAX_ATTACKS = 24;
const MAX_SPELLS = 400;
const MAX_TEXT = 5000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const int = (v, fallback, lo, hi) => clamp(Math.round(num(v, fallback)), lo, hi);
const text = (v, fallback = '', max = 200) => String(v ?? fallback).slice(0, max);
const block = (v) => text(v, '', MAX_TEXT);

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
  }));
}

function pickSpells(source) {
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_SPELLS).map((s = {}) => ({
    id: text(s.id, '', 64) || crypto.randomUUID(),
    level: int(s.level, 0, 0, 9), // 0 = cantrip
    name: text(s.name, '', 80),
    prepared: Boolean(s.prepared),
  }));
}

function pickSlots(source = {}) {
  const out = {};
  for (let level = 1; level <= 9; level++) {
    const slot = (source && source[level]) || {};
    out[level] = {
      total: int(slot.total, 0, 0, 9),
      expended: int(slot.expended, 0, 0, 9),
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
    otherProficiencies: block(body.otherProficiencies),

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
    equipment: block(body.equipment),
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
    featuresAndTraits: block(body.featuresAndTraits),

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
