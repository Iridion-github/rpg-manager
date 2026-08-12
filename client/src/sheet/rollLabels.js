// How a roll from a character sheet is described in the chat log.
//
// Pulled out of the component because it got this wrong once: the label used to
// be derived from *how many* rolls an attack produced, so an attack with only
// damage set fell into the single-roll branch and lost its name. The name is
// not optional - a log line of "Damage 2d10 = 9" tells you nothing.

/** Labels for an attack's two rolls. The damage carries its type, if set. */
export function attackRollLabels(attack = {}) {
  const name = (attack.name || '').trim() || 'Attack';
  const type = (attack.damageType || '').trim();
  return {
    toHit: `${name} to hit`,
    damage: `${name} damage${type ? ` (${type})` : ''}`,
  };
}

/** Prefix with the character, so a GM rolling for a whole table can tell who. */
export function characterRollLabel(characterName, rollLabel) {
  const who = (characterName || '').trim() || 'Character';
  return `${who} - ${rollLabel}`;
}
