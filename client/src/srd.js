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

/** A path this app is willing to follow. See routes/srd.js, which agrees. */
const READABLE = /^\/api\/2014\/(equipment-categories(\/[a-z0-9-]+)?|equipment\/[a-z0-9-]+|magic-items\/[a-z0-9-]+)$/;

export const isReadable = (path) => READABLE.test(String(path || ''));

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
 * What a document offers to descend into.
 *
 * `equipment` on a category, `results` on the root list. A leaf has neither, and
 * that absence is what the walk stops on.
 */
export const branchesOf = (node) => {
  if (Array.isArray(node?.equipment)) return node.equipment;
  if (Array.isArray(node?.results)) return node.results;
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
const nameOf = (v) => (v && typeof v === 'object' ? text(v.name) : text(v));
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);

/** "10 gp", or nothing at all when there is no price. */
const money = (cost) =>
  cost && cost.quantity !== undefined ? `${cost.quantity} ${cost.unit ?? ''}`.trim() : null;

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
  { heading: 'Special', lines: Array.isArray(node?.special) ? node.special.filter(Boolean) : [] },
];
