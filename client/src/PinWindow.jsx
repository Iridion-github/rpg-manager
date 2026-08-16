import FloatingWindow from './FloatingWindow.jsx';
import PinIcon from './PinIcon.jsx';
import { RichTextView } from './RichTextLazy.jsx';
import { shareSummary } from './SharePanel.jsx';

/**
 * An opened pin: what it says, over the spot it says it about.
 *
 * A floating window rather than a modal, because a modal would take the map
 * away - and what a pin is *for* is reading a thing about the place you are
 * looking at. Several can be open at once for the same reason: comparing two
 * pins is an ordinary thing to want, and it is impossible one dialog at a time.
 *
 * Anchored rather than free (see FloatingWindow's `anchor`): the card hangs over
 * its own pin and rides along as the map is scrolled or zoomed. It can still be
 * resized, and the size is remembered for every pin, since how big a card wants
 * to be is a fact about the screen rather than about the pin.
 *
 * Open or shut is *this* browser's business and nobody else's. There is no
 * server call here and nothing is broadcast: a pin somebody else has opened
 * stays shut on your map, which is exactly unlike a token, and deliberately -
 * opening one is reading, and reading is not a move.
 */
export default function PinWindow({
  pin,
  anchor,
  players = [],
  actor,
  zIndex,
  isTop,
  onFocus,
  onClose,
}) {
  const mine = Boolean(pin.ownerId) && pin.ownerId === actor?.userId;
  // Who stuck it in. A pin can name somebody who has since left the table, and
  // an author nobody can find is reported as nobody rather than as a blank.
  const author = pin.ownerId ? players.find((p) => p.id === pin.ownerId) : null;

  return (
    <FloatingWindow
      title={pin.title || 'Pin'}
      anchor={anchor}
      // One key for every pin rather than one each: what is remembered is the
      // size, and a size chosen on one pin is the size that suits this screen.
      storageKey="rpg:pin-window"
      defaultSize={{ w: 360, h: 320 }}
      minSize={{ w: 220, h: 140 }}
      zIndex={zIndex}
      isTop={isTop}
      onFocus={onFocus}
      onClose={onClose}
      // Putting it away is closing it. A pin's card folded to a title bar
      // hovering over the map would be a second, worse version of the pin that
      // is already down there saying the same word.
      onMinimize={onClose}
      controls={<div className="spacer" />}
    >
      <div className="pin-card" style={{ background: pin.background || '#161b22' }}>
        <div className="pin-card-head">
          <PinIcon color={pin.color || '#e5534b'} className="pin-card-icon" />
          <strong>{pin.title || 'Pin'}</strong>
        </div>

        <RichTextView doc={pin.content} />

        {/* Who wrote it, and - for its author alone - who else is reading it.
            The second half is deliberately not shown to everybody: telling a
            player which other players were given the same pin is more than the
            person who shared it chose to say. */}
        <p className="pin-card-foot">
          {author ? `Stuck in by ${author.name}` : 'Stuck in by somebody no longer at this table'}
          {mine && ` · ${shareSummary(pin, players)}`}
        </p>
      </div>
    </FloatingWindow>
  );
}
