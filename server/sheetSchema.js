'use strict';

/**
 * The shape of a D&D 5e character sheet.
 *
 * Only *raw* values are stored. Everything the printed sheet asks you to work
 * out — ability modifiers, save and skill bonuses, proficiency bonus, passive
 * Perception, spell save DC — is derived when rendering. Storing a derived
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
 * Keys aren't checked against a list of the 18 skills on purpose — that list
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

// A chosen roll: how many dice, which die, and a modifier added once.
function pickDice(source, allowed) {
  if (!source || typeof source !== 'object') return null;
  const sides = Number(source.sides);
  if (!allowed.has(sides)) return null;
  return {
    count: int(source.count, 1, 1, 50),
    sides,
    modifier: int(source.modifier, 0, -99, 99),
  };
}

/**
 * Attacks used to hold free text ("+5", "1d8 + 3 slashing"). Rather than drop
 * what people already typed, read a dice spec out of it where the shape is
 * obvious — anything unparseable simply comes back empty, which is what an
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
    abilities: pickAbilities(body.abilities),
    inspiration: Boolean(body.inspiration),
    saves: pickSaves(body.saves),
    skills: pickSkills(body.skills),
    otherProficiencies: block(body.otherProficiencies),

    // --- combat ---
    armorClass: int(body.armorClass ?? body.ac, 10, 0, 99),
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
