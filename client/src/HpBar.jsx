import { hpBar } from './hp.js';

/**
 * The bar itself, drawn from what `hpBar` worked out.
 *
 * Takes the computed object rather than the raw numbers, because every caller
 * wants those numbers for the line of text beside the bar as well - so they do
 * the sum once and hand the answer to both.
 *
 * A `<span>` so it can sit inside the tooltip's and the tracker's inline rows
 * as readily as inside the sheet's block. Hidden from screen readers: it is the
 * same fact as the "12 / 20" printed next to it, and hearing it twice is worse
 * than not hearing it at all.
 */
export default function HpBar({ bar }) {
  if (!bar) return null;
  return (
    <span className="hp-bar" aria-hidden="true">
      <span className="hp-fill" style={{ width: `${bar.currentPercent}%` }} />
      {/* Left out entirely rather than drawn at nought width, so an ordinary
          bar is exactly the two elements it has always been. */}
      {bar.temp > 0 && <span className="hp-temp" style={{ width: `${bar.tempPercent}%` }} />}
      {/* Over the top of both, from the left edge, rather than beside them:
          non-lethal damage is not a share of the bar, it is how far along the
          bar the beating has got. Last in the markup so it lies over what it
          covers. */}
      {bar.nonLethal > 0 && (
        <span className="hp-nonlethal" style={{ width: `${bar.nonLethalPercent}%` }} />
      )}
    </span>
  );
}

export { hpBar };
