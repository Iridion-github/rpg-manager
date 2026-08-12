// Shared dice vocabulary: the chat roller and the attack fields on a character
// sheet pick from the same list and render specs the same way.

export const DICE_OPTIONS = [
  { label: 'Coin', sides: 2 },
  { label: 'd4', sides: 4 },
  { label: 'd6', sides: 6 },
  { label: 'd8', sides: 8 },
  { label: 'd10', sides: 10 },
  { label: 'd12', sides: 12 },
  { label: 'd20', sides: 20 },
  { label: 'd100', sides: 100 },
];

// Attacks roll a d20 to hit, and anything but a coin for damage.
export const TO_HIT_DICE = [20];
export const DAMAGE_DICE = [4, 6, 8, 10, 12, 20, 100];

export const MAX_DICE = 50;
export const MAX_MODIFIER = 99;

export const clampDice = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The field always carries its sign, so "+2" reads as a modifier rather than a
// quantity. Negatives already have one.
export const signedMod = (n) => (n < 0 ? String(n) : `+${n}`);

/** "2d10+3", "1d20-1", "3 coins" - how a spec reads once it's chosen. */
export function notation(spec) {
  if (!spec || !spec.sides) return '';
  const count = spec.count || 1;
  if (spec.sides === 2) return `${count} coin${count === 1 ? '' : 's'}`;
  const mod = spec.modifier || 0;
  return `${count}d${spec.sides}${mod ? signedMod(mod) : ''}`;
}
