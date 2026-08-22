/**
 * Turning a compendium entry into something a character sheet can hold.
 *
 * The sheet and the SRD describe the same objects differently, and neither of
 * them is wrong: the book says a breastplate is `armor_class: { base: 14,
 * dex_bonus: true, max_bonus: 2 }`, the sheet says it is an AC of 14 with the
 * Dexterity capped at +2. The translation is here, apart from both, because it
 * is the part most likely to be wrong and the part worth being able to read on
 * its own.
 *
 * ## What a template does not touch
 *
 * Only the fields that describe the object. Not the row's identity, not
 * whether it is being worn - you fill in a piece of armour and then decide to
 * put it on, and a picker that took your armour off would be a picker people
 * work around. Not the picture either: the SRD offers one for some magic items,
 * but it is a URL on somebody else's host and this app's content policy allows
 * images from itself and nowhere else, so it would be a broken picture
 * replacing one somebody chose.
 *
 * ## Entries that do not describe anything
 *
 * Under `armor` the book files thirteen suits of armour and twenty-nine magic
 * items, and Adamantine Armor has a rarity and four paragraphs of rules and no
 * armour class at all - it is a property you put *on* armour. Those still fill
 * in their name, and leave every number alone. Half an answer beats refusing to
 * answer: the name is the field most worth not typing, and what the item does
 * is on the screen the reader is looking at while they decide.
 */

import { ARMOR_TYPES, DEX_CAPS } from './rules.js';
import { DAMAGE_DICE } from '../dice.js';
import { contentsOf, nameOf, proseOf } from '../srd.js';

const CAP_VALUES = DEX_CAPS.map((c) => c.value);

/**
 * Everything an entry has to say in words, as one block of text.
 *
 * The paragraphs in the order the book gives them, headings dropped. A magic
 * item opens with its own type line ("Armor (plate), legendary (requires
 * attunement)") and that is kept: it is the line that says what the thing is
 * and what it costs you to use it. Ordinary armour says nothing at all here,
 * which is right - a chain shirt is fully described by its numbers.
 */
const proseText = (node) => {
  const lines = proseOf(node).flatMap((p) => p.lines);
  return lines
    .reduce((out, line, i) => {
      if (i === 0) return line;
      // A blank line between paragraphs, but not inside a table. The book keeps
      // a table as one `desc` entry per row, and a blank line between every row
      // turns the four rarities of a healing potion into half a page.
      const joiner = isTableRow(line) && isTableRow(lines[i - 1]) ? '\n' : '\n\n';
      return out + joiner + line;
    }, '')
    .trim();
};

/** A row of one of the book's pipe-delimited tables. */
const isTableRow = (line) => String(line ?? '').trim().startsWith('|');

/**
 * How much Dexterity this armour lets through, in the sheet's own terms.
 *
 * A shield is the exception and it is not a subtle one. The book says a shield
 * has `dex_bonus: false`, meaning its own +2 is flat rather than something your
 * Dexterity adds to; the sheet's Dex cap means something else entirely - the
 * ceiling on the wearer's Dexterity - and it is read across everything worn, so
 * writing '0' onto a shield row would quietly delete the Dexterity bonus of
 * every character who picked up a shield. Shields cap nothing.
 */
function dexCapOf(node, shield) {
  if (shield) return 'limitless';
  const ac = node.armor_class;
  if (!ac || typeof ac !== 'object') return null;
  if (ac.dex_bonus !== true) return '0';
  if (ac.max_bonus === undefined || ac.max_bonus === null) return 'limitless';
  // The book only ever says 2 here. A number the sheet has no option for is
  // better read as no cap than as a cap nobody can see in the select.
  const cap = String(ac.max_bonus);
  return CAP_VALUES.includes(cap) ? cap : 'limitless';
}

/**
 * The fields of an Equipped Armor row, from one compendium entry.
 *
 * Returns only what the entry actually says, so the caller can spread it over
 * the row and leave everything else as it was. An entry with no armour in it
 * gives back a name and nothing more.
 */
export function armorTemplate(node) {
  const fields = { name: node?.name || '' };

  const category = typeof node?.armor_category === 'string' ? node.armor_category : '';
  const type = ARMOR_TYPES.includes(category) ? category : '';
  if (type) fields.type = type;

  const shield = type === 'Shield';
  const base = node?.armor_class?.base;
  // A shield's base is its bonus, which is what the row's number means for a
  // shield, so the same field carries both without a conversion.
  if (Number.isFinite(Number(base))) fields.ac = Number(base);

  const cap = dexCapOf(node, shield);
  if (cap) fields.dexCap = cap;

  if (typeof node?.stealth_disadvantage === 'boolean') {
    fields.stealthDisadvantage = node.stealth_disadvantage;
  }

  // Always, including to nothing at all.
  //
  // This is the one field a template clears rather than leaves. The numbers are
  // left alone when the entry is silent about them because a magic item is a
  // property of armour you already have - adamantine is what a breastplate is
  // made of - but a description is prose about a named object, and the name has
  // just been overwritten. Leaving the last one behind would put the rules for
  // Adamantine Armor under a row that now reads Plate Armor, which is worse
  // than an empty box.
  fields.description = proseText(node);

  return fields;
}

/**
 * The fields of an Inventory row, from one compendium entry.
 *
 * Three of the row's four: what it is, what one of them weighs, and what there
 * is to say about it. The quantity is left alone, because how many you are
 * carrying is not something the book knows - it is the one field on the row
 * that is about you rather than about the object.
 *
 * The weight is per item, which is what the column means ("each") and what the
 * total at the top of the section is worked out from. Cleared when the entry
 * gives none, the same way the description is: a weightless row is what the
 * book says a spell scroll is, and leaving the last item's pounds behind would
 * quietly add them to the character's load.
 */
export function inventoryTemplate(node) {
  return {
    title: node?.name || '',
    weight: Number.isFinite(Number(node?.weight)) ? Number(node.weight) : null,
    description: describeForRow(node),
  };
}

/**
 * What to write in an inventory row's description.
 *
 * The rules text, and for a pack the list of what is in it. The contents are
 * here rather than left behind because a pack is the one entry whose whole
 * substance is a list, and the row has nowhere else to put it: "Burglar's Pack"
 * with a weight and no contents is a row that has forgotten what it is.
 *
 * Nothing else off the entry. The cost, the damage, the properties are all a
 * click away in the book and none of them has a field here, and copying them
 * into free text makes a second copy that goes stale the moment anybody edits
 * either one.
 */
function describeForRow(node) {
  const contents = contentsOf(node);
  const packed = contents.length
    ? ['Contains:', ...contents.map((c) => `${c.quantity} x ${c.name}`)].join('\n')
    : '';
  return [proseText(node), packed].filter(Boolean).join('\n\n');
}

/* ---------------------------------------------------------------------------
   Attacks.
   ------------------------------------------------------------------------ */

/** "1d8" or "2d6", as the sheet's dice spec. Null for anything else. */
function parseDice(dice) {
  const match = /^\s*(\d+)\s*d\s*(\d+)\s*$/i.exec(String(dice ?? ''));
  if (!match) return null;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  // The dialog that sets these offers a fixed set of dice, and a spec holding
  // one it does not know would draw a cell nobody can edit back.
  if (!DAMAGE_DICE.includes(sides) || count < 1 || count > 50) return null;
  return { count, sides };
}

/**
 * Which ability swings this.
 *
 * Finesse first and unconditionally, because that is the property's whole
 * point: a rapier may use either and the one worth defaulting to is the one
 * the character who bought a rapier almost certainly has. Then the plain rule -
 * a bow is Dexterity, an axe is Strength.
 *
 * Nothing at all for an entry that is not a weapon. A Flame Tongue is filed as
 * a magic item and says nothing about how it is swung, so the row keeps
 * whatever it already had rather than being told it is a Strength attack.
 */
function attackAbility(node) {
  const properties = (Array.isArray(node?.properties) ? node.properties : [])
    .map(nameOf)
    .filter(Boolean);
  if (properties.some((p) => /finesse/i.test(p))) return 'dex';
  if (node?.weapon_range === 'Ranged') return 'dex';
  if (node?.weapon_range === 'Melee') return 'str';
  return '';
}

/** "20/60 ft.", or "5 ft." where there is no long range. */
const rangeText = (r) =>
  r && (r.normal || r.long) ? (r.long ? `${r.normal}/${r.long} ft.` : `${r.normal} ft.`) : '';

/**
 * What an attack row cannot hold in its four boxes.
 *
 * Unlike the inventory, these facts are copied rather than left in the book,
 * and the difference is when they are wanted: a shopping list is read at leisure
 * with the compendium one click away, and an attack row is read mid-turn by
 * somebody who needs to know whether the thing reaches, whether they can throw
 * it, and what it rolls in two hands. Those have no field of their own and the
 * description is the only place on the row they fit.
 */
function attackNotes(node) {
  const properties = (Array.isArray(node?.properties) ? node.properties : [])
    .map(nameOf)
    .filter(Boolean);
  const twoHanded = node?.two_handed_damage;

  const facts = [
    node?.category_range ? `${node.category_range} weapon` : '',
    properties.length ? `Properties: ${properties.join(', ')}` : '',
    twoHanded?.damage_dice
      ? `Two-handed: ${twoHanded.damage_dice}${nameOf(twoHanded.damage_type) ? ` ${nameOf(twoHanded.damage_type).toLowerCase()}` : ''
      }`
      : '',
    rangeText(node?.range) ? `Range: ${rangeText(node.range)}` : '',
    rangeText(node?.throw_range) ? `Thrown: ${rangeText(node.throw_range)}` : '',
  ].filter(Boolean);

  return [facts.join('\n'), proseText(node)].filter(Boolean).join('\n\n');
}

/**
 * The fields of an attack row, from one compendium entry.
 *
 * The dice are only touched where the entry actually has a weapon in it. Two
 * kinds of entry come back from the weapon shelf: a longsword, which says what
 * it rolls, and a Flame Tongue, which is filed as a magic item and says only
 * what it does in words. Filling the second one's dice in would mean guessing,
 * and the row it landed on was very likely the longsword the flame tongue is -
 * so its dice are left exactly as they were and only the name and the rules
 * text change. That is what "the fields that can be filled" means here.
 *
 * The to-hit modifier stays at nought and does not get a proficiency bonus
 * folded into it. A stored bonus is a bonus that outlives the level it was
 * worked out at, which is the one thing this sheet refuses to do anywhere else;
 * and whether this character is proficient with this weapon is not something
 * the book knows.
 */
export function attackTemplate(node) {
  const fields = { name: node?.name || '', description: attackNotes(node) };

  const dice = parseDice(node?.damage?.damage_dice);
  if (dice) {
    const ability = attackAbility(node);
    fields.toHit = { count: 1, sides: 20, modifier: 0, ability };
    fields.damage = { ...dice, modifier: 0, ability };
    const type = nameOf(node?.damage?.damage_type);
    // Lower case, as the box's own placeholder writes it and as the chat line
    // reads it: "1d8+3 slashing" rather than "1d8+3 Slashing".
    if (type) fields.damageType = type.toLowerCase();
  }

  return fields;
}

/**
 * The categories worth offering when the errand is an attack.
 *
 * Every family the book files a weapon under, plus ammunition. `weapon` is the
 * catch-all and holds the magic ones as well; the others are the quick way to
 * the ordinary ones without reading past sixty-seven entries.
 *
 * Not staves, rods or wands. They can certainly be attacked with, but the book
 * files them as magic items with no damage in them, so they would fill in a
 * name and leave every die untouched - and they are all still there in the
 * Item Compendium tab for anybody who wants to read one.
 */
export const WEAPON_CATEGORIES = [
  'weapon',
  'simple-weapons',
  'simple-melee-weapons',
  'simple-ranged-weapons',
  'martial-weapons',
  'martial-melee-weapons',
  'martial-ranged-weapons',
  'melee-weapons',
  'ranged-weapons',
  'ammunition',
];

/**
 * The categories worth offering when the errand is a piece of armour.
 *
 * The four the book files armour under, plus shields, which it keeps separate
 * because a shield is not worn on the body. The overlap is deliberate: `armor`
 * holds everything including the magic pieces, and the three by weight are the
 * quick way to the ordinary ones.
 */
export const ARMOR_CATEGORIES = ['armor', 'light-armor', 'medium-armor', 'heavy-armor', 'shields'];
