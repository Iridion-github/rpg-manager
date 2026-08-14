/**
 * The control that couples a character sheet to a token.
 *
 * One component, used from both ends. In the Characters tab it asks which token
 * a character is; in the Tokens tab it asks which character a token is. Those
 * are the same fact written from two directions, so they get the same control
 * and the same one call behind them - two bespoke pickers would be two chances
 * for the two screens to imply different rules.
 *
 * `note` is composed by the caller even so. Both ends warn that choosing an
 * option takes it off whatever holds it, but each names that other thing in its
 * own vocabulary - a figure at one end, a character at the other - and a single
 * phrasing here would have to be vague enough to fit both.
 *
 * A plain select that acts on change, like the sheet access dropdowns: there is
 * nothing to compose here and nothing to get wrong halfway, so a Save button
 * would only be a second thing to press.
 *
 * Everything it knows is passed in. It does no fetching and holds no opinion
 * about who may link what - both tabs work that out from their own lists, and
 * the server checks it again regardless of what this draws.
 */
export default function SheetTokenLink({
  label,
  // What to call it where the caption is not drawn - down a column that carries
  // its own heading, say. A control with no name at all is a control a screen
  // reader can only describe by its current value.
  ariaLabel,
  hint,
  value,
  options,
  emptyLabel = 'Not linked',
  busy = false,
  disabled = false,
  onChange,
}) {
  return (
    <div className="link-pair">
      <label>
        {label && <span>{label}</span>}
        <select
          value={value || ''}
          aria-label={ariaLabel || label}
          disabled={disabled || busy}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{emptyLabel}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {/* Said in the option itself rather than after the fact, and
                  worded by whoever is asking: at one end choosing this takes
                  it off what holds it, at the other it simply joins them. The
                  two ends are no longer the same promise, so neither of them
                  gets to be phrased here. */}
              {o.name}
              {o.note ? ` - ${o.note}` : ''}
            </option>
          ))}
        </select>
      </label>
      {hint && <p className="hint">{hint}</p>}
      {options.length === 0 && !value && (
        <p className="hint">Nothing here yet that you can link this to.</p>
      )}
    </div>
  );
}
