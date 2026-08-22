import Compendium from './Compendium.jsx';

/**
 * The Item Compendium tab.
 *
 * A heading, a line saying what this is, and the shelf itself - which lives in
 * Compendium.jsx because the character sheet opens the same thing in a window
 * when somebody is filling in a piece of armour. Reading it and taking from it
 * are the same browsing; only the button on an entry differs, and this is the
 * side with no button.
 */
export default function Items() {
  return (
    <div className="items-page">
      <h2 className="items-title">Item Compendium</h2>
      <p className="hint">
        The equipment from the 5e SRD, for looking things up mid-game. Nothing here belongs to
        this table and nothing is saved.
      </p>
      <Compendium />
    </div>
  );
}
