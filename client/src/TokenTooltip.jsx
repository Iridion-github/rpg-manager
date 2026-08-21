import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePortalTarget } from './portalTarget.js';
import { initiativeText } from './initiative.js';
import HpBar, { hpBar } from './HpBar.jsx';
import { notation } from './dice.js';
import { isBlankAttack } from './sheet/AttackRow.jsx';
import { specAbilityBonus } from './sheet/rules.js';

/**
 * What a token is, shown while the pointer rests on it.
 *
 * It replaces the browser's own `title` bubble, which can hold a line of text
 * and nothing else - no bar, no telling one reader from another. Everyone gets
 * the name and the initiative; only the DM gets the hit points, because knowing
 * exactly how close the ogre is to dropping is the table's job to find out.
 *
 * Rendered into <body> rather than into the map: the map scrolls behind
 * `overflow: auto`, and a tooltip over a token near the edge would be cut in
 * half by it.
 */

// Between the token's edge and the bubble, in px.
const GAP = 10;
// Closest the bubble may come to the window's edge before it is pushed back in.
const MARGIN = 4;

export default function TokenTooltip({ anchor, token, owner, showHp, note, sheet = null }) {
  // Where a dialog goes: the page, or the window it was popped out into.
  const portalTarget = usePortalTarget();
  const ref = useRef(null);

  /**
   * Follow the token.
   *
   * It moves for reasons React never hears about - the map scrolling under a
   * drag, a zoom, another player pushing it across the board - so rather than
   * remembering where the pointer arrived, this re-reads the token's box every
   * frame and writes a transform straight to the node. Off the render path
   * entirely: no state changes, so hovering costs nothing in re-renders.
   */
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const el = ref.current;
      if (!el || !anchor?.isConnected) return;
      const box = anchor.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = el;
      // Above the token, unless that would put it off the top of the window -
      // then below, which is the only other place it certainly fits.
      const above = box.top - h - GAP;
      const top = above < MARGIN ? box.bottom + GAP : above;
      const left = Math.min(
        Math.max(MARGIN, box.left + box.width / 2 - w / 2),
        window.innerWidth - w - MARGIN
      );
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  const hasInitiative = token.initiative !== null && token.initiative !== undefined;
  // Null when there is nothing to draw - a token whose hit points nobody set up
  // rather than one at death's door. See hp.js for what the segments mean.
  const bar = hpBar(token.hp, token.maxHp, token.tempHp);
  const tracked = showHp && bar;

  /**
   * What this creature can do, from both places it can be written down: its own
   * list, and the character sheet it holds if it holds one.
   *
   * Listed together and not merged. They are two different things that happen
   * to print alike - a goblin's bite that nobody wrote a sheet for, and the
   * greatsword on the fighter's page - and the token's own come first because
   * they are the ones that were written *about this figure*.
   *
   * Behind `showHp`, which is the DM. Same reasoning as the hit points above:
   * what the ogre can do to you is the table's job to find out, and a bubble
   * that told a player its damage dice would be answering the question the
   * fight is supposed to ask.
   */
  const attacks = showHp
    ? [
      // The token's own first: they are the ones written about this figure.
      // Nothing to add to their dice - a token has no ability scores.
      ...(token.attacks || []).map((a) => ({ ...a, bonusFor: () => 0 })),
      // And the character's, whose dice are worth more than they read: the
      // ability modifier is kept off the stored spec and worked out from the
      // sheet, so printing the spec alone would under-report every one of them.
      ...(sheet?.attacks || []).map((a) => ({
        ...a,
        bonusFor: (spec) => specAbilityBonus(sheet, spec),
      })),
    ].filter((a) => !isBlankAttack(a))
    : [];

  return createPortal(
    <div className="token-tip" ref={ref} role="tooltip">
      <strong>{token.label}</strong>

      {/* Whose it is, said in words. The colour on the token itself is the
          glance; this is the answer when the glance isn't enough - two players
          with similar colours, or somebody new to the table. */}
      {owner && (
        <span className="token-tip-row">
          Belongs to{' '}
          <b>
            <span className="token-tip-swatch" style={{ background: owner.color }} />
            {owner.name}
          </b>
        </span>
      )}

      {hasInitiative && (
        <span className="token-tip-row">
          Initiative{' '}
          <b>
            {initiativeText(token).total}
            {initiativeText(token).breakdown && (
              <small> ({initiativeText(token).breakdown})</small>
            )}
          </b>
        </span>
      )}

      {tracked && (
        <span className="token-tip-hp">
          <span className="token-tip-row">
            Hit points{' '}
            <b>
              {bar.current} / {bar.total}
            </b>
          </span>
          {/* A row of its own, and only when there are any. Not folded into the
              line above as "12 (+5) / 20", which reads as though the five were
              part of the twenty; they are the opposite of that - the points
              that are spent first and belong to no total. */}
          {bar.temp > 0 && (
            <span className="token-tip-row">
              Temporary <b className="hp-temp-text">+{bar.temp}</b>
            </span>
          )}
          {/* The track is the wound and the fill is what's left of them, so the
              red showing through is exactly the damage taken. Any blue in front
              of it is the cushion that has to go first. */}
          <HpBar bar={bar} />
        </span>
      )}

      {/* Stacked rather than laid out as the rows above are: those are a label
          and a short answer, and this is a name with a line of notation under
          it that will not fit beside anything in a bubble this narrow. */}
      {attacks.length > 0 && (
        <span className="token-tip-attacks">
          {attacks.map((a) => (
            <span className="token-tip-attack" key={a.id}>
              {/* An attack with no name is still worth printing - its dice are
                  the useful half - so it says what it is rather than leaving a
                  blank where a name should be. */}
              <b>{a.name || 'Attack'}</b>
              <small>
                {[
                  a.toHit && `${notation(a.toHit, a.bonusFor(a.toHit))} to hit`,
                  a.damage &&
                    `${notation(a.damage, a.bonusFor(a.damage))}${
                      a.damageType ? ` ${a.damageType}` : ''
                    }`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'no dice set'}
              </small>
            </span>
          ))}
        </span>
      )}

      {/* Under the bar, and shown to everybody rather than only to the DM: what
          a creature is suffering from is what the table is playing around, and
          a player who cannot see that the ogre is prone is missing the thing
          that decides their turn. Always drawn, because "nothing is wrong with
          it" is an answer somebody is looking for - a row that vanished when
          the token was healthy would leave you unsure whether you had checked.

          A token with no status stored is a Normal one: see statusValue in
          TokenModal, where the two are deliberately made the same thing. */}
      <span className="token-tip-row">
        Status <b>{token.status || 'Normal'}</b>
      </span>

      {/* Only ever drawn on the DM's screen, because a token the players cannot
          see is a token their browser was never sent. Said in words as well as
          marked on the board: the eye on the plate is the glance, and this is
          the answer when somebody is checking rather than scanning. */}
      {token.visible === false && (
        <span className="token-tip-row token-tip-hidden">
          Hidden from players <b>Yes</b>
        </span>
      )}

      {/* Last, and not part of the token at all: this is what is happening to
          it this second, which outranks nothing and belongs after the facts. */}
      {note && <small>{note}</small>}
    </div>,
    portalTarget
  );
}
