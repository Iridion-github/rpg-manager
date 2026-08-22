import { useState } from 'react';
import CompendiumModal from '../CompendiumModal.jsx';

/**
 * "Fill this row in from the book."
 *
 * The button and the window it opens, together, because they are one thing: a
 * row sends you to the compendium, you come back with an entry, and the row is
 * that entry. Holding the window here rather than at the top of the section
 * means a section does not have to remember which of its rows asked - the
 * callback is already the right row's.
 *
 * `only` narrows the categories to what could go in the row that opened it, and
 * is the caller's judgement: armour offers armour, an attack offers weapons,
 * and the inventory offers everything, because anything at all can be carried.
 */
export default function CompendiumButton({ title, only = null, onUse, label = 'Compendium' }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="compendium-btn"
        onClick={() => setOpen(true)}
        title="Fill this in from the compendium"
      >
        {label}
      </button>

      {open && (
        <CompendiumModal
          title={title}
          only={only}
          onUse={onUse}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
