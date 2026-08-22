import { useState } from 'react';
import Compendium from './Compendium.jsx';
import Spells from './Spells.jsx';

/**
 * The Compendia tab: the reference books, one per inner page.
 *
 * Plural because there is more than one of them now. Equipment was the first
 * and is the one that works; spells are the obvious second and are a heading
 * with nothing under it yet, which is deliberate - the page exists so that the
 * shape of the tab is settled before the second book is written into it, rather
 * than the tab being rearranged around it later.
 *
 * The shelf itself lives in Compendium.jsx, because a character sheet opens the
 * same thing in a window when somebody is filling in a row. Reading it and
 * taking from it are the same browsing; only the button on an entry differs,
 * and this is the side with no button.
 */
export default function Items() {
  const [page, setPage] = useState('items');

  return (
    <div className="items-page">
      {/* The same switcher an open character sheet uses for its own pages, and
          the same class, so the two read as the same kind of thing. */}
      <nav className="sheet-pages">
        {[
          ['items', 'Items'],
          ['spells', 'Spells'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={page === key ? 'active' : ''}
            onClick={() => setPage(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {page === 'items' && (
        <>
          <h2 className="items-title">Item Compendium</h2>
          <p className="hint">
            The equipment from the 5e SRD, for looking things up mid-game. Nothing here belongs
            to this table and nothing is saved.
          </p>
          <Compendium />
        </>
      )}

      {page === 'spells' && <Spells />}
    </div>
  );
}
