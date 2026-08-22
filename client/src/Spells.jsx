import Compendium from './Compendium.jsx';
import { SPELL_CATEGORIES } from './srd.js';

/**
 * The spell shelf, read the same way the equipment one is.
 *
 * The same component underneath, and deliberately so: a reader who has found a
 * longsword has already learned how to find Fireball. What differs is only the
 * rows across the top, and those live in srd.js beside the rest of what this
 * app knows about the shape of that API - with the reasoning for both of them,
 * and because a character sheet opens the same shelf in a window.
 */

export default function Spells() {
  return (
    <>
      <h2 className="items-title">Spell Compendium</h2>
      <p className="hint">
        The spells from the 5e SRD, by level or by school. Nothing here belongs to this table
        and nothing is saved.
      </p>
      <Compendium
        categories={SPELL_CATEGORIES}
        catsLabel="Spell categories"
        emptyHint="Pick a level or a school to see the spells in it."
      />
    </>
  );
}
