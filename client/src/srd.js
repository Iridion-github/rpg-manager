/**
 * Reading the SRD equipment tree, and knowing when you have hit the bottom.
 *
 * Kept apart from the screen that draws it for the usual reason: this is about
 * the shape of somebody else's data, and that is worth being able to reason
 * about - and change when they change it - without a browser in the way.
 *
 * ## The tree
 *
 * Three levels, and the walk is the same at each: fetch a path, look at what
 * came back, decide whether it is a fork or the end of the road.
 *
 *   1. `/api/2014/equipment-categories`  → 39 categories
 *   2. `/api/2014/equipment-categories/<index>` → an `equipment` list
 *   3. whatever those entries point at → one thing, described
 *
 * **A leaf is a document with nowhere left to go.** Every document carries its
 * own `url` and at every level that url is the one you just asked for, so the
 * url alone cannot tell a category from a shield; both answer yes. What does
 * tell them apart is the onward list. A category carries `equipment`, the root
 * carries `results`, and a piece of equipment carries neither - so the bottom of
 * the tree is the point where there is nothing further to follow. Both are
 * checked here, the url as well as the list, because a document that answered
 * for a path other than the one asked for is a redirect this walk has no idea
 * what to do with and should stop on rather than guess about.
 *
 * The urls sitting inside *other* properties - `equipment_category`, a damage
 * type, the items in a pack - are never followed, or the walk would wander
 * sideways for ever. Only the named onward lists count.
 *
 * **A fork with one road is not a fork.** A category holding exactly one piece
 * of equipment is a button nobody would thank you for; the walk goes straight
 * through it. Today only Shields is like that, but the rule is written about
 * the count rather than about Shields.
 *
 * ## What comes back at the bottom
 *
 * Not one shape but six, and they overlap. Armour has an armour class, a weapon
 * has damage, a pack has contents, a mount has a speed, a magic item has a
 * rarity and no weight at all. `describe` below turns any of them into the same
 * thing - a list of labelled lines - so the screen can draw one and not six.
 */

import { api } from './api.js';
import {
  SPELL_LEVELS,
  SPELL_SCHOOLS,
  spellLevelLabel,
  spellLevelName,
} from './sheet/rules.js';

/**
 * The two ways into the spell shelf.
 *
 * Equipment has an endpoint that lists its categories. Spells do not: there are
 * three hundred and nineteen of them in one flat list, and the only way to ask
 * for a slice is a filter. So the rows are written out here from the ten levels
 * and the eight schools the game has, both of which this app already knows,
 * because a character sheet asks for exactly the same ten and eight.
 *
 * Two rows and one choice. A spell belongs to a level and to a school and
 * neither is more its category than the other: somebody looking for something
 * to put in a 3rd level slot and somebody looking for a divination are asking
 * different questions and both are fair. Picking from one row clears the other,
 * because those are different questions rather than a narrowing of one.
 *
 * The levels stay in level order rather than being alphabetised with everything
 * else. "Cantrip, 1st, 2nd" is the order that row means; sorted by name it
 * would read "1st, 2nd, ... 9th, Cantrips", which is nobody's idea of a spell
 * list. The schools are alphabetical, which is the order the game lists them in
 * and the only order that suggests itself.
 *
 * Here rather than in the tab that draws them because the character sheet opens
 * the same shelf in a window when somebody is filling a spell in, and two copies
 * of this would be two lists to keep in step.
 */
export const SPELL_CATEGORIES = [
  ...SPELL_LEVELS.map((level) => ({
    index: `level-${level}`,
    name: level === 0 ? 'Cantrips' : `${spellLevelLabel(level)} level`,
    url: `/api/2014/spells?level=${level}`,
    group: 'By level',
  })),
  ...SPELL_SCHOOLS.map((school) => ({
    index: `school-${school.toLowerCase()}`,
    name: school,
    // The filter wants the index the API files the school under, which is the
    // name in lower case for all eight of them.
    url: `/api/2014/spells?school=${school.toLowerCase()}`,
    group: 'By school',
  })),
];

/**
 * The least time a load may take, in milliseconds.
 *
 * A spinner that flashes up and vanishes reads as a glitch rather than as work
 * being done, and the cache behind this makes that the common case: the second
 * time anybody opens Armor it is already in hand. Holding every load to the
 * same floor makes the screen behave the same way whether or not it had to ask
 * anybody, which is what stops the interface feeling like it is stuttering.
 */
export const MIN_LOAD_MS = 500;

/** Fetch one document, never faster than the floor above. */
export async function fetchNode(path) {
  // Both, not one after the other: the wait runs *alongside* the request rather
  // than after it, so a slow answer costs what it costs and a fast one is held
  // to the floor. `all` also carries the failure through - an error that
  // appeared instantly, before the spinner had been seen, would read as a click
  // that did something odd rather than as an answer.
  const [body] = await Promise.all([
    api.srd(path),
    new Promise((resolve) => setTimeout(resolve, MIN_LOAD_MS)),
  ]);
  return body;
}

/**
 * A to Z, and the same A to Z for everybody.
 *
 * An explicit locale rather than the reader's own, for the reason the dates are
 * formatted with one: two people at the same table should be looking at the
 * same list in the same order, and a browser set to another language quietly
 * sorts some of these differently. The entries are English either way, since
 * that is the language the book is written in.
 *
 * Case is ignored, so "arrow" would file beside "Arrow" rather than after every
 * capital letter, and digits are read as numbers, so a hypothetical "+2 Weapon"
 * does not sort behind "+10 Weapon".
 */
const byName = (a, b) =>
  String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'en', {
    sensitivity: 'base',
    numeric: true,
  });

/**
 * What a document offers to descend into, in alphabetical order.
 *
 * `equipment` on a category, `results` on the root list. A leaf has neither, and
 * that absence is what the walk stops on.
 *
 * Sorted here rather than at each of the places that draws a list, so the
 * categories across the top and the entries inside one cannot end up ordered
 * differently. The book's own order is dropped on purpose: it puts armour by
 * ascending armour class and weapons by the table they are printed in, which is
 * a fine way to read a rulebook and a poor way to find the one item you already
 * know the name of. A copy is sorted rather than the array itself, since the
 * caller was handed a document it did not ask to have rearranged.
 */
export const branchesOf = (node) => {
  if (Array.isArray(node?.equipment)) return [...node.equipment].sort(byName);
  if (Array.isArray(node?.results)) return [...node.results].sort(byName);
  return [];
};

/** The end of the road: this document answered for the path, and leads nowhere. */
export const isLeaf = (node, path) =>
  Boolean(node) && node.url === path && branchesOf(node).length === 0;

const text = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * The name of a thing, whether it arrived as one or as a reference to one.
 *
 * The API is not consistent about this and there is no rule to learn: an item's
 * `armor_category` and `vehicle_category` are plain strings, its `gear_category`
 * is a `{ index, name, url }` reference to the category document. Both mean the
 * same thing to a reader, so both are flattened to the name here rather than at
 * each of the places that wants one.
 */
export const nameOf = (v) => (v && typeof v === 'object' ? text(v.name) : text(v));
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);

/** "10 gp", or nothing at all when there is no price. */
const money = (cost) =>
  cost && cost.quantity !== undefined ? `${cost.quantity} ${cost.unit ?? ''}`.trim() : null;

/** "1st", "3rd", "17th". Needed past 9th, where the spell ordinals stop. */
const ordinal = (n) => {
  const i = Math.abs(Math.round(Number(n) || 0));
  const tens = i % 100;
  if (tens >= 11 && tens <= 13) return `${i}th`;
  return `${i}${['th', 'st', 'nd', 'rd'][i % 10] || 'th'}`;
};

/**
 * One of the book's scaling tables, on a line: "3rd 8d6 - 4th 9d6 - ...".
 *
 * A spell that grows carries an object keyed by the slot it was cast with, or
 * for a cantrip by the caster's own level. Read in key order as numbers, since
 * an object keyed "11" and "5" is not in any order worth trusting.
 */
const scaling = (table) => {
  if (!table || typeof table !== 'object') return null;
  const steps = Object.entries(table)
    .map(([at, dice]) => [Number(at), dice])
    .filter(([at]) => Number.isFinite(at))
    .sort((a, b) => a[0] - b[0])
    .map(([at, dice]) => `${ordinal(at)} ${dice}`);
  return steps.length ? steps.join(' · ') : null;
};

/** "1d8 slashing", the way a sheet writes it. */
const damage = (d) => {
  if (!d?.damage_dice) return null;
  const type = nameOf(d.damage_type);
  return type ? `${d.damage_dice} ${type.toLowerCase()}` : String(d.damage_dice);
};

/**
 * One entry, as lines worth reading.
 *
 * Only the properties that say something. Everything the API carries for its
 * own sake - `index`, `url`, `updated_at`, the nested urls - is left out, and
 * so is any field this particular entry has nothing in: a shield with no
 * special rules should not print an empty "Special" heading.
 *
 * `desc` and `special` come back as arrays of paragraphs and are kept that way,
 * because on a magic item that is four paragraphs of rules text and joining
 * them into one line would be unreadable.
 */
export function describe(node) {
  const rows = [];
  // Anything that is still an object at this point is a shape nobody here
  // anticipated, and handing one to React ends the whole app rather than this
  // one row - so it gets flattened on the way in as well as at each call. This
  // is somebody else's data and it is allowed to surprise us.
  const add = (label, raw) => {
    const value = raw && typeof raw === 'object' ? nameOf(raw) : raw;
    if (value !== null && value !== undefined && value !== '') rows.push({ label, value });
  };

  /* Spells.

     A spell and a piece of equipment never share a field, so both live in the
     one function and each entry answers only to the rows it has something for -
     which is how this was built for the six shapes of equipment in the first
     place. The guards below are about *which* shape rather than about spells
     being special: `range` is a string on a spell and a pair of numbers on a
     bow, and only one of the two rows can fire. */
  if (node.school) {
    add('Level', spellLevelName(node.level));
    add('School', nameOf(node.school));
  }
  add('Casting time', text(node.casting_time));
  if (typeof node.range === 'string') add('Range', node.range);
  if (Array.isArray(node.components) && node.components.length) {
    add('Components', node.components.map(nameOf).filter(Boolean).join(', '));
  }
  add('Materials', text(node.material));
  add('Duration', text(node.duration));
  // Only when true. "Ritual: No" and "Concentration: No" on three hundred
  // spells is two rows of nothing, and the absence says the same thing.
  if (node.concentration === true) add('Concentration', 'Yes');
  if (node.ritual === true) add('Ritual', 'Yes');
  if (node.area_of_effect?.size) {
    add('Area', `${node.area_of_effect.size} ft ${nameOf(node.area_of_effect.type) || ''}`.trim());
  }
  // The book writes this one in lower case ("ranged", "melee") where every
  // other value on the entry is capitalised. It is a value in a table here, not
  // a word in a sentence, so it matches the rest of the column.
  const attackType = text(node.attack_type);
  add('Attack', attackType && attackType[0].toUpperCase() + attackType.slice(1));
  if (node.dc?.dc_type) {
    // "half" is the common one and worth spelling out; the rest of the book's
    // words for this read well enough as they are.
    const onSuccess = node.dc.dc_success === 'half' ? ' (half on a success)' : '';
    add('Save', `${nameOf(node.dc.dc_type)}${onSuccess}`);
  }
  if (node.school) {
    add('Damage type', nameOf(node.damage?.damage_type));
    add('Damage by slot', scaling(node.damage?.damage_at_slot_level));
    // A cantrip does not scale with the slot, because it has none: it grows
    // with the caster, and this table is the only place the book says so.
    add('Damage by level', scaling(node.damage?.damage_at_character_level));
    add('Healing by slot', scaling(node.heal_at_slot_level));
    if (Array.isArray(node.classes) && node.classes.length) {
      add('Classes', node.classes.map(nameOf).filter(Boolean).join(', '));
    }
  }

  add('Category', nameOf(node.equipment_category));
  add(
    'Type',
    nameOf(node.armor_category) ||
      nameOf(node.weapon_category) ||
      nameOf(node.gear_category) ||
      nameOf(node.vehicle_category),
  );
  add('Rarity', nameOf(node.rarity));

  // Armour.
  if (node.armor_class) {
    const ac = node.armor_class;
    const dex =
      ac.dex_bonus === true
        ? ac.max_bonus
          ? ` + Dex (max ${ac.max_bonus})`
          : ' + Dex'
        : '';
    add('Armor class', `${ac.base}${dex}`);
    add('Adds Dexterity', yesNo(ac.dex_bonus));
  }
  // Only when there is one. Every shield and every light armour says nought,
  // and a line reading "Strength needed 0" is a field printed for its own sake.
  add('Strength needed', node.str_minimum > 0 ? node.str_minimum : null);
  add('Stealth disadvantage', yesNo(node.stealth_disadvantage));

  // Weapons.
  add('Range type', node.weapon_range);
  add('Damage', damage(node.damage));
  add('Two-handed damage', damage(node.two_handed_damage));
  if (node.range && (node.range.normal || node.range.long)) {
    add('Range', node.range.long ? `${node.range.normal}/${node.range.long} ft.` : `${node.range.normal} ft.`);
  }
  if (Array.isArray(node.properties) && node.properties.length) {
    add('Properties', node.properties.map(nameOf).filter(Boolean).join(', '));
  }

  // Mounts and vehicles.
  add('Speed', node.speed ? `${node.speed.quantity} ${node.speed.unit ?? ''}`.trim() : null);
  add('Capacity', text(node.capacity));

  // Everything that has a body and a price.
  add('Weight', node.weight ? `${node.weight} lb.` : null);
  add('Cost', money(node.cost));

  return rows;
}

/** What is in a pack, as "1 × Backpack" lines. Empty for anything else. */
export const contentsOf = (node) =>
  (Array.isArray(node?.contents) ? node.contents : [])
    .filter((c) => c?.item?.name)
    .map((c) => ({ name: c.item.name, quantity: c.quantity ?? 1 }));

/** The paragraphs an entry carries, under the heading they belong to. */
export const proseOf = (node) => [
  { heading: 'Description', lines: Array.isArray(node?.desc) ? node.desc.filter(Boolean) : [] },
  {
    heading: 'At higher levels',
    lines: Array.isArray(node?.higher_level) ? node.higher_level.filter(Boolean) : [],
  },
  { heading: 'Special', lines: Array.isArray(node?.special) ? node.special.filter(Boolean) : [] },
];
