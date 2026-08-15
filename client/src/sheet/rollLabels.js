// How a roll from a character sheet is described in the chat log.
//
// Pulled out of the component because it got this wrong once: the label used to
// be derived from *how many* rolls an attack produced, so an attack with only
// damage set fell into the single-roll branch and lost its name. The name is
// not optional - a log line of "Damage 2d10 = 9" tells you nothing.

/** A name and a kind of damage, as the two lines they produce in the log. */
function rollPair(rawName, rawType, fallback) {
  const name = (rawName || '').trim() || fallback;
  const type = (rawType || '').trim();
  return {
    toHit: `${name} to hit`,
    damage: `${name} damage${type ? ` (${type})` : ''}`,
  };
}

/** Labels for an attack's two rolls. The damage carries its type, if set. */
export const attackRollLabels = (attack = {}) =>
  rollPair(attack.name, attack.damageType, 'Attack');

/**
 * The same for a spell, whose damage type is written in its own box on the
 * sheet: "Damage/Effect", which is where "necrotic" or "1d8 healing" lives.
 */
export const spellRollLabels = (spell = {}) =>
  rollPair(spell.name, spell.damageEffect, 'Spell');

/** Prefix with the character, so a GM rolling for a whole table can tell who. */
export function characterRollLabel(characterName, rollLabel) {
  const who = (characterName || '').trim() || 'Character';
  return `${who} - ${rollLabel}`;
}
