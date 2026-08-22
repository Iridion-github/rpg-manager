import { abilityMod, armorClass, signed } from './sheet/rules.js';

/**
 * One character in a roster: a portrait, a name, and the four or five numbers
 * worth knowing before you open them.
 *
 * Shared by the two rosters, which are the same list asked two different
 * questions. Inside a campaign it is the cast of that table; outside one it is
 * every character you have, from all of them. The card itself doesn't care -
 * the only thing that differs is the small grey line at the bottom, which is
 * the access summary at a table and the campaign's name away from one, so it
 * arrives as `note` rather than being worked out here.
 */
export default function SheetCard({ sheet, open = false, note = '', onOpen }) {
  return (
    <button
      className={`sheet-card${open ? ' open' : ''}${sheet.portraitUrl ? ' has-portrait' : ''}`}
      onClick={onOpen}
    >
      {/* Only where there is one, and the card is laid out in two columns only
          where there is one: an empty frame on every character nobody has drawn
          yet would cost the whole roster a column to say nothing. */}
      {sheet.portraitUrl && <img className="card-portrait" src={sheet.portraitUrl} alt="" />}
      {/* Everything the card says, in one box beside the picture. A wrapper
          rather than letting these sit in the card's own grid: the portrait has
          to stand alongside all of them at once, and a cell can only span rows
          the grid actually declares - which these, arriving one per character,
          are not. */}
      <span className="card-body">
        <strong>{sheet.name || 'Unnamed'}</strong>
        <span>
          {[sheet.race, sheet.class && `${sheet.class} ${sheet.level ?? 1}`]
            .filter(Boolean)
            .join(' · ') || 'No class yet'}
        </span>
        <div className="card-stats">
          <span>
            HP {sheet.hp?.current ?? 0}/{sheet.hp?.max ?? 0}
          </span>
          <span>AC {armorClass(sheet)}</span>
          <span>
            {/* A quick read on the character without opening them up. */}
            STR {signed(abilityMod(sheet.abilities?.str))} DEX{' '}
            {signed(abilityMod(sheet.abilities?.dex))} CON{' '}
            {signed(abilityMod(sheet.abilities?.con))}
          </span>
        </div>
        {note && <span className="card-access">{note}</span>}
      </span>
    </button>
  );
}
